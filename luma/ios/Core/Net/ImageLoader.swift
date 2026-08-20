import SwiftUI
import UIKit

/// `GET /v1/images/:id` needs the `Authorization` header, so `AsyncImage` cannot
/// be used — it builds a bare `URLRequest`.
///
/// Bytes are cached by `URLCache` (the server marks them immutable and
/// long-lived) and decoded images by `NSCache`, keyed `id@width`.
actor ImageLoader {
    static let shared = ImageLoader()

    private let cache = NSCache<NSString, UIImage>()
    private var inFlight: [String: Task<UIImage?, Never>] = [:]
    private var api: APIClient?

    private init() {
        cache.totalCostLimit = 64 << 20
    }

    func use(_ client: APIClient) { api = client }

    /// Always request a width: `?w=320` for a grid tile, `?w=1280` for the
    /// transcript, no `w` only for saving and sharing. This is what makes a
    /// gallery cost tens of kilobytes instead of hundreds of megabytes.
    func image(_ id: ImageId, width: Int?) async -> UIImage? {
        let key = "\(id.raw)@\(width.map(String.init) ?? "full")"
        if let hit = cache.object(forKey: key as NSString) { return hit }
        if let running = inFlight[key] { return await running.value }

        let task = Task<UIImage?, Never> { [api] in
            guard let api else { return nil }
            let endpoint = Endpoint(
                path: "/images/\(id.raw)",
                query: ["w": width.map(String.init)]
            )
            guard let data = try? await api.send(endpoint),
                  let image = UIImage(data: data)
            else { return nil }
            return image
        }
        inFlight[key] = task
        let image = await task.value
        inFlight.removeValue(forKey: key)
        if let image {
            cache.setObject(image, forKey: key as NSString, cost: image.byteCost)
        }
        return image
    }
}

private extension UIImage {
    var byteCost: Int {
        guard let cg = cgImage else { return 1 }
        return cg.bytesPerRow * cg.height
    }
}

/// Authenticated image view with a placeholder at the known aspect ratio and a
/// short cross-fade, so a transcript does not jump as pictures land.
struct AuthedImage: View {
    let imageId: ImageId
    var width: Int?
    var contentMode: ContentMode = .fit

    @State private var image: UIImage?
    @State private var failed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
                    .transition(reduceMotion ? .identity : .opacity)
            } else if failed {
                placeholder(systemImage: Symbols.failed)
            } else {
                placeholder(systemImage: nil)
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: image != nil)
        .task(id: imageId.raw) {
            guard image == nil else { return }
            let loaded = await ImageLoader.shared.image(imageId, width: width)
            if let loaded { image = loaded } else { failed = true }
        }
        .accessibilityLabel("图片")
    }

    private func placeholder(systemImage: String?) -> some View {
        ZStack {
            Color.mutedFill
            if let systemImage {
                Image(systemName: systemImage).foregroundStyle(Color.mutedFg)
            }
        }
        .frame(minHeight: 120)
    }
}
