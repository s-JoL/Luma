import AVKit
import SwiftUI

/// Everywhere a clip can be watched goes through this: the transcript, the
/// studio gallery and the file library. One implementation, so a video is never
/// a poster that does nothing in two of the three.
///
/// `AVPlayer` fetches on its own and cannot be handed a `URLRequest`, so the
/// bearer token travels as an asset option instead — `GET /v1/videos/:id` from a
/// bare URL arrives with no credential and is refused. Letting AVFoundation do
/// the fetching is also what makes seeking cheap: it asks for byte ranges, which
/// the server answers, so scrubbing costs the part being watched rather than the
/// whole file.
struct VideoViewer: View {
    let videoId: VideoId
    var poster: ImageId?

    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var player: AVPlayer?
    @State private var failed = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let player {
                VideoPlayer(player: player)
                    .ignoresSafeArea()
            } else if failed {
                ContentUnavailableView(
                    "这个视频打不开",
                    systemImage: Symbols.failed,
                    description: Text("检查网络或稍后再试")
                )
            } else {
                loading
            }
        }
        .overlay(alignment: .topTrailing) { closeButton }
        .statusBarHidden()
        .task {
            guard let item = await load() else { return }
            await watch(item)
        }
        // A player left running behind a dismissed cover keeps the audio session
        // and goes on downloading, which is the classic way a closed video keeps
        // talking over the next screen.
        .onDisappear {
            player?.pause()
            player = nil
        }
    }

    /// The poster is what was already on screen when the tap happened, so it
    /// stays until the first frame replaces it.
    private var loading: some View {
        ZStack {
            if let poster {
                AuthedImage(imageId: poster, width: 1280)
                    .opacity(0.4)
            }
            ProgressView().tint(.white)
        }
    }

    private var closeButton: some View {
        Button {
            dismiss()
        } label: {
            Image(systemName: "xmark")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 34, height: 34)
                .floatingGlass(in: .circle, interactive: true)
        }
        .buttonStyle(.plain)
        .padding(Space.lg)
        .accessibilityLabel("关闭")
    }

    private func load() async -> AVPlayerItem? {
        guard player == nil, !failed else { return nil }
        do {
            let source = try await app.api.mediaSource(.video(videoId))
            // Spelled out rather than referenced: AVFoundation exports this key
            // but does not declare it in its headers, so there is no constant to
            // name. It is the only way to authenticate an `AVURLAsset` short of
            // standing up a resource-loader delegate to proxy every range.
            let asset = AVURLAsset(
                url: source.url,
                options: ["AVURLAssetHTTPHeaderFieldsKey": source.headers]
            )
            let item = AVPlayerItem(asset: asset)
            let player = AVPlayer(playerItem: item)
            player.play()
            self.player = player
            return item
        } catch {
            failed = true
            return nil
        }
    }

    /// A refused or malformed fetch is reported as a status change on the item
    /// and nothing else — nothing throws and the player calls back about
    /// nothing — so without this a clip the server would not serve sits on a
    /// black rectangle forever, which reads as a hung app rather than an error.
    private func watch(_ item: AVPlayerItem) async {
        while !Task.isCancelled, item.status == .unknown {
            try? await Task.sleep(for: .milliseconds(200))
        }
        if item.status == .failed {
            player = nil
            failed = true
        }
    }
}

/// The still a clip shows before it is played: the server's poster where there
/// is one, the muted fill where there is not, and the play glyph either way, so
/// a video never reads as a picture that failed to load.
struct VideoPoster: View {
    var poster: ImageId?
    var width: Int = 1280
    var contentMode: ContentMode = .fit

    var body: some View {
        ZStack {
            if let poster {
                AuthedImage(imageId: poster, width: width, contentMode: contentMode)
            } else {
                Color.mutedFill.frame(minHeight: 160)
            }
            Image(systemName: "play.circle.fill")
                .font(.largeTitle)
                .foregroundStyle(.white.opacity(0.9))
                .shadow(color: .black.opacity(0.3), radius: 6)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("视频")
        .accessibilityHint("轻点播放")
        .accessibilityAddTraits(.isButton)
    }
}

/// The presented clip, matching `ZoomedImage`: `fullScreenCover(item:)` wants an
/// identity, and the asset id is one. The poster comes along so the cover opens
/// on the frame that was just tapped rather than on black.
struct PlayingVideo: Identifiable {
    let id: String
    var poster: ImageId?

    var videoId: VideoId { VideoId(id) }

    init(_ raw: String, poster: ImageId? = nil) {
        id = raw
        self.poster = poster
    }
}
