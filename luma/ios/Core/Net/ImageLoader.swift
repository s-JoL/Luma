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

    /// The shape of every picture that has been seen, by id.
    ///
    /// Kept so a placeholder can reserve the right box the *second* time a
    /// picture appears — scrolling back up a transcript, or reopening it. The
    /// first sighting of an unknown picture is the only one that can reflow.
    private var ratios: [String: Double] = [:]

    private init() {
        cache.totalCostLimit = 64 << 20
    }

    func use(_ client: APIClient) { api = client }

    func ratio(_ id: ImageId) -> Double? { ratios[id.raw] }

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

            // `UIImage(data:)` does not decode — it keeps the compressed bytes
            // and decodes on whatever thread first *draws* it, which is the main
            // thread, during the scroll that brought the picture on screen. A
            // 1280px render costs several milliseconds there, once per picture,
            // and that is what a transcript full of generated images feels like.
            // `byPreparingForDisplay` does the same work here instead.
            return await image.byPreparingForDisplay() ?? image
        }
        inFlight[key] = task
        let image = await task.value
        inFlight.removeValue(forKey: key)
        if let image {
            cache.setObject(image, forKey: key as NSString, cost: image.byteCost)
            if image.size.height > 0 {
                ratios[id.raw] = Double(image.size.width / image.size.height)
            }
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

/// Authenticated image, with the space it will need reserved before it arrives.
///
/// The reservation is the point. A placeholder of a fixed height means every
/// picture resizes its row the moment it lands, which in a transcript moves
/// everything below it — while the reader is scrolling through it. The server
/// knows the dimensions for a generated asset and `ImageLoader` remembers them
/// for everything else, so the only picture that can reflow is one this app has
/// never seen at a size it was not told.
struct AuthedImage: View {
    let imageId: ImageId
    var width: Int?
    var contentMode: ContentMode = .fit
    /// Width ÷ height, when the caller already knows it.
    var aspectRatio: Double?

    @State private var image: UIImage?
    @State private var reserved: Double?
    @State private var failed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
            } else {
                placeholder
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: image != nil)
        .task(id: imageId.raw) {
            guard image == nil else { return }
            if reserved == nil, aspectRatio == nil {
                reserved = await ImageLoader.shared.ratio(imageId)
            }
            let loaded = await ImageLoader.shared.image(imageId, width: width)
            if let loaded { image = loaded } else { failed = true }
        }
        .accessibilityLabel("图片")
    }

    @ViewBuilder
    private var placeholder: some View {
        let shape = Color.mutedFill.overlay {
            if failed {
                Image(systemName: Symbols.failed).foregroundStyle(Color.mutedFg)
            }
        }
        if let ratio = aspectRatio ?? reserved, ratio > 0 {
            shape.aspectRatio(ratio, contentMode: contentMode)
        } else {
            // Nothing known about it yet. A 4:3 box is a better guess than a
            // 120pt strip: most renders are landscape or square, and being
            // roughly right means the correction when it lands is small.
            shape.aspectRatio(4.0 / 3.0, contentMode: contentMode)
        }
    }
}
