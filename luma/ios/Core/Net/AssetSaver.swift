import Photos
import UIKit

/// Puts a generated picture or clip in the camera roll.
///
/// The one thing a phone can do with a rendered image that a browser tab cannot,
/// and the reason it needs its own type: the bytes are behind a bearer token, so
/// they have to be fetched by the app and handed to Photos rather than pointed
/// at. `PHAssetCreationRequest` takes a file URL for video and data for a still,
/// which is why the two paths differ.
enum AssetSaver {
    enum Failure: Error {
        case denied
        case fetch
        case write

        var message: String {
            switch self {
            case .denied: "没有相册权限，去「设置 → Luma → 照片」里打开"
            case .fetch: "取图失败，稍后再试"
            case .write: "存到相册失败"
            }
        }
    }

    /// `addOnly` rather than `readWrite`: the app never reads the library, and
    /// asking for less is the difference between a prompt people accept and one
    /// they think about.
    private static func authorise() async throws {
        let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        switch status {
        case .authorized, .limited:
            return
        case .notDetermined:
            let granted = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
            guard granted == .authorized || granted == .limited else { throw Failure.denied }
        default:
            throw Failure.denied
        }
    }

    static func saveImage(_ id: ImageId, using api: APIClient) async throws {
        try await authorise()
        guard let data = try? await api.send(.image(id)), !data.isEmpty else { throw Failure.fetch }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                PHAssetCreationRequest.forAsset().addResource(with: .photo, data: data, options: nil)
            }
        } catch {
            throw Failure.write
        }
    }

    /// Video goes via a temporary file. Photos will not take clip bytes in
    /// memory, and a render can be tens of megabytes.
    static func saveVideo(_ id: VideoId, using api: APIClient) async throws {
        try await authorise()
        guard let data = try? await api.send(.video(id)), !data.isEmpty else { throw Failure.fetch }

        let url = URL.temporaryDirectory.appending(path: "save-\(id.raw).mp4")
        defer { try? FileManager.default.removeItem(at: url) }
        do {
            try data.write(to: url, options: .atomic)
            try await PHPhotoLibrary.shared().performChanges {
                PHAssetCreationRequest.forAsset().addResource(with: .video, fileURL: url, options: nil)
            }
        } catch {
            throw Failure.write
        }
    }
}
