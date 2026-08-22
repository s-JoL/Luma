import SwiftUI

/// What a picture is, and what can be done with it next.
///
/// The gallery used to open straight into the viewer, which meant the app could
/// show a render at full size and say nothing at all about where it came from.
/// Everything here is already on the server — `GET /images/:id/provenance`
/// answers for uploads too — so the absence was only ever a screen.
///
/// The three actions are the point, and they are three because they are
/// genuinely different requests. *Again* re-sends the recorded parameters
/// untouched, which is the one that has to bypass the form: copying values in
/// and back out is how a repeat quietly stops being one. *Adjust* loads them into
/// the form to be changed. *Edit* takes the output as the next input.
struct AssetDetailView: View {
    let assetId: String
    let kind: GeneratedAsset.Kind
    /// Known up front from a gallery row, and only from the provenance reply for
    /// a picture opened out of a transcript — hence the fallback below.
    var knownAspectRatio: Double?
    var posterId: ImageId?

    init(asset: GeneratedAsset) {
        assetId = asset.assetId
        kind = asset.kind
        knownAspectRatio = asset.aspectRatio
        posterId = asset.poster
    }

    /// For a picture opened from a transcript, where all the app has is the id.
    init(imageId: ImageId) {
        assetId = imageId.raw
        kind = .image
    }

    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var provenance: Provenance?
    @State private var loading = true
    @State private var working = false
    @State private var zoom: ZoomedImage?
    @State private var playing: PlayingVideo?

    private var store: StudioStore { app.studio }

    /// The gallery knows the shape before anything is fetched, so the sheet does
    /// not reflow when the provenance lands. A transcript picture has to wait for
    /// it, and squares until then.
    private var aspectRatio: Double {
        if let knownAspectRatio { return knownAspectRatio }
        guard let width = provenance?.width, let height = provenance?.height,
              width > 0, height > 0
        else { return 1 }
        return Double(width) / Double(height)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.lg) {
                    preview
                    actions
                    if loading {
                        HStack { Spacer(); Spinner(); Spacer() }
                    } else if let provenance {
                        details(provenance)
                    }
                }
                .padding(Space.lg)
            }
            .background(Color.bg)
            .navigationTitle(kind == .video ? "视频" : "图片")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
        .fullScreenCover(item: $zoom) { item in ImageViewer(imageId: item.imageId) }
        .fullScreenCover(item: $playing) { item in
            VideoViewer(videoId: item.videoId, poster: item.poster)
        }
        .task {
            provenance = await store.provenance(ofAsset: assetId, kind: kind)
            loading = false
        }
    }

    // MARK: The picture

    private var preview: some View {
        Button {
            if kind == .video {
                playing = PlayingVideo(assetId, poster: posterId)
            } else {
                zoom = ZoomedImage(assetId)
            }
        } label: {
            Color.clear
                .aspectRatio(aspectRatio, contentMode: .fit)
                .overlay {
                    Group {
                        if kind == .video {
                            VideoPoster(poster: posterId, width: 1280, contentMode: .fill)
                        } else {
                            AuthedImage(imageId: ImageId(assetId), width: 1280, contentMode: .fill)
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .clipped()
                }
                .overlay(alignment: .center) {
                    if kind == .video {
                        Image(systemName: "play.circle.fill")
                            .font(.system(size: 48))
                            .foregroundStyle(.white.opacity(0.9))
                            .shadow(radius: 8)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: Radius.lg))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(kind == .video ? "播放这段视频" : "放大这张图")
    }

    // MARK: What to do with it

    @ViewBuilder
    private var actions: some View {
        // Laid out as a wrapping row of chips rather than a menu: on a gallery
        // screen these are the reason the sheet opened, and burying them behind
        // an ellipsis costs a tap on every one of them.
        let repeatable = provenance?.job?.repeatable == true
        VStack(spacing: Space.sm) {
            HStack(spacing: Space.sm) {
                if repeatable {
                    action("同参再来", systemImage: "arrow.clockwise", prominent: true) {
                        guard let provenance else { return }
                        try await store.again(provenance)
                        dismiss()
                    }
                    action("改参数重画", systemImage: "slider.horizontal.3") {
                        guard let provenance, store.edit(provenance) else {
                            app.toast = Toast(message: "这个模型已经不在了，改不了参数", isError: true)
                            return
                        }
                        dismiss()
                    }
                }
            }
            HStack(spacing: Space.sm) {
                if kind == .image {
                    action("以此为源编辑", systemImage: "wand.and.stars") {
                        guard store.useAsSource(assetId) else {
                            app.toast = Toast(message: "还没有配置图片编辑模型", isError: true)
                            return
                        }
                        dismiss()
                    }
                }
                action("存到相册", systemImage: "square.and.arrow.down") {
                    do {
                        if kind == .video {
                            try await AssetSaver.saveVideo(VideoId(assetId), using: app.api)
                        } else {
                            try await AssetSaver.saveImage(ImageId(assetId), using: app.api)
                        }
                        Haptics.success()
                        app.toast = Toast(message: "已存到相册")
                    } catch let failure as AssetSaver.Failure {
                        app.toast = Toast(message: failure.message, isError: true)
                    }
                }
            }
        }
        .disabled(working)
    }

    private func action(
        _ title: String,
        systemImage: String,
        prominent: Bool = false,
        run: @escaping () async throws -> Void
    ) -> some View {
        Button {
            Task {
                working = true
                defer { working = false }
                do { try await run() }
                catch let error as APIError { app.handle(error) }
                catch {}
            }
        } label: {
            Label(title, systemImage: systemImage)
                .font(.subheadline.weight(.medium))
                .lineLimit(1)
                .frame(maxWidth: .infinity)
                .frame(height: 40)
        }
        .buttonStyle(.plain)
        .foregroundStyle(prominent ? Color.onBrand : Color.fg)
        .background(
            prominent ? AnyShapeStyle(LinearGradient.brandFill) : AnyShapeStyle(Color.secondaryFill),
            in: RoundedRectangle(cornerRadius: Radius.lg)
        )
    }

    // MARK: Where it came from

    @ViewBuilder
    private func details(_ provenance: Provenance) -> some View {
        if !provenance.prompt.isEmpty {
            section("提示词") {
                Text(provenance.prompt)
                    .font(.callout)
                    .foregroundStyle(Color.fg)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Space.md)
                    .background(Color.mutedFill, in: RoundedRectangle(cornerRadius: Radius.md))
                    .contextMenu {
                        Button {
                            UIPasteboard.general.string = provenance.prompt
                            Haptics.success()
                        } label: {
                            Label("复制提示词", systemImage: "doc.on.doc")
                        }
                        Button {
                            store.adopt("prompt", .string(provenance.prompt))
                            Haptics.tap()
                            app.toast = Toast(message: "提示词已放回创作台")
                        } label: {
                            Label("用这个提示词", systemImage: "arrow.uturn.left")
                        }
                    }
            }
        }

        section("信息") {
            VStack(spacing: 0) {
                ForEach(facts(provenance), id: \.name) { fact in
                    row(fact.name, fact.value)
                }
            }
            .background(Color.card, in: RoundedRectangle(cornerRadius: Radius.md))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.md).strokeBorder(Color.hairline, lineWidth: 1)
            )
        }

        let settings = provenance.settings
        if !settings.isEmpty {
            section("参数") {
                VStack(spacing: 0) {
                    ForEach(settings, id: \.name) { setting in
                        reusableRow(setting.name, setting.value, from: provenance)
                    }
                }
                .background(Color.card, in: RoundedRectangle(cornerRadius: Radius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: Radius.md).strokeBorder(Color.hairline, lineWidth: 1)
                )
            }
        }

        if !provenance.parents.isEmpty {
            section(kind == .video ? "取自这些画面" : "基于这些图") {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Space.sm) {
                        ForEach(provenance.parents, id: \.self) { parent in
                            Button {
                                zoom = ZoomedImage(parent)
                            } label: {
                                AuthedImage(imageId: ImageId(parent), width: 320, contentMode: .fill)
                                    .frame(width: 88, height: 88)
                                    .clipped()
                                    .clipShape(RoundedRectangle(cornerRadius: Radius.md))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text(title)
                .font(.footnote.weight(.medium))
                .foregroundStyle(.secondary)
            content()
        }
    }

    /// A setting, with its own way back into the form.
    ///
    /// Per-field rather than all-or-nothing: "that seed, with my prompt" is the
    /// request people actually have, and reusing the whole thing means loading
    /// it and then undoing the parts they did not want.
    private func reusableRow(
        _ name: String, _ value: String, from provenance: Provenance
    ) -> some View {
        HStack(alignment: .top, spacing: Space.md) {
            Text(name)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer(minLength: Space.sm)
            Text(value)
                .font(.subheadline.monospaced())
                .foregroundStyle(Color.fg)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
            Button {
                guard let raw = provenance.job?.params[name] else { return }
                store.adopt(name, raw)
                Haptics.tap()
                app.toast = Toast(message: "已把「\(name)」放回创作台")
            } label: {
                Image(systemName: "arrow.uturn.left.circle")
                    .foregroundStyle(Color.brand)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("把 \(name) 用回创作台")
        }
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.sm)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.hairline).frame(height: 0.5).opacity(0.6)
        }
    }

    private func row(_ name: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: Space.md) {
            Text(name)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer(minLength: Space.sm)
            Text(value)
                .font(.subheadline)
                .foregroundStyle(Color.fg)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.sm)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.hairline).frame(height: 0.5).opacity(0.6)
        }
    }

    /// Everything true of the asset itself, which is the part that survives when
    /// there is no job behind it.
    private func facts(_ provenance: Provenance) -> [(name: String, value: String)] {
        var facts: [(name: String, value: String)] = []
        if let model = provenance.job?.modelName ?? provenance.model, !model.isEmpty {
            facts.append(("模型", model))
        }
        if let provider = provenance.provider, !provider.isEmpty {
            facts.append(("提供方", provider))
        }
        if let width = provenance.width, let height = provenance.height {
            facts.append(("尺寸", "\(width) × \(height)"))
        }
        if let ms = provenance.durationMs, ms > 0 {
            facts.append(("时长", Self.seconds(ms)))
        }
        if let ms = provenance.job?.elapsedMs, ms > 0 {
            facts.append(("耗时", Self.seconds(ms)))
        }
        if provenance.createdAt > 0 {
            facts.append(("生成于", Self.moment(provenance.createdAt)))
        }
        if provenance.job == nil {
            // Said plainly rather than left as an empty parameters section: an
            // uploaded picture has no request behind it and never will.
            facts.append(("来源", "上传，没有生成记录"))
        }
        return facts
    }

    private static func seconds(_ ms: Int) -> String {
        let value = Double(ms) / 1000
        return value < 10
            ? String(format: "%.1f 秒", value)
            : String(format: "%.0f 秒", value)
    }

    private static func moment(_ millis: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(millis) / 1000)
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy年M月d日 HH:mm"
        return formatter.string(from: date)
    }
}
