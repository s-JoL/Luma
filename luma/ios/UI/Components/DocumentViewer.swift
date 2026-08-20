import QuickLook
import SwiftUI

/// An attachment with nothing to preview. The name is all there is to recognise
/// it by, and the size is what says whether opening it is a glance or a wait —
/// the same two things the web's `FileChip` shows, so a document reads the same
/// in both clients.
struct DocumentChip: View {
    let name: String
    var bytes: Int?
    var tap: () -> Void

    var body: some View {
        Button(action: tap) {
            HStack(spacing: Space.xs) {
                Image(systemName: Symbols.document)
                    .foregroundStyle(Color.mutedFg)
                Text(name)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let bytes {
                    Text(Format.bytes(bytes)).foregroundStyle(.secondary)
                }
            }
            .font(.caption)
            .foregroundStyle(Color.onSecondary)
            .padding(.horizontal, Space.md)
            .frame(height: 34)
            .background(Color.secondaryFill, in: RoundedRectangle(cornerRadius: Radius.md))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .frame(minHeight: 44)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(bytes.map { "文档 \(name)，\(Format.bytes($0))" } ?? "文档 \(name)")
        .accessibilityHint("轻点打开")
        .accessibilityAddTraits(.isButton)
    }
}

/// Everywhere a document is opened goes through this. Quick Look draws PDFs,
/// text, spreadsheets and images itself and offers the share sheet for whatever
/// it cannot draw, which covers the whole range an attachment can be — so a tap
/// opens one control rather than branching on the mime type.
///
/// The bytes are fetched through `APIClient` and written to disk first: Quick
/// Look and the share sheet both take a file URL, and a URL pointing at
/// `/v1/files/:id/content` would be fetched by them without the bearer token and
/// refused, the same problem `AVURLAsset` has with a clip.
struct DocumentViewer: View {
    let fileId: FileId
    let name: String

    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var url: URL?
    @State private var failed = false

    var body: some View {
        ZStack {
            Color.bg.ignoresSafeArea()

            if let url {
                QuickLook(url: url) { dismiss() }
                    .ignoresSafeArea(edges: .bottom)
            } else if failed {
                ContentUnavailableView(
                    "这个文件打不开",
                    systemImage: Symbols.failed,
                    description: Text("检查网络或稍后再试")
                )
            } else {
                ProgressView()
            }
        }
        // Quick Look carries its own way out; the states before it do not.
        .overlay(alignment: .topTrailing) {
            if url == nil { closeButton }
        }
        .task { await load() }
    }

    private var closeButton: some View {
        Button("关闭") { dismiss() }
            .font(.subheadline)
            .padding(Space.lg)
    }

    private func load() async {
        guard url == nil, !failed else { return }
        do {
            url = try await app.api.download(fileId, name: name)
        } catch {
            failed = true
        }
    }
}

/// The presented document, matching `ZoomedImage` and `PlayingVideo`:
/// `fullScreenCover(item:)` wants an identity, and the file id is one. The name
/// travels with it because the id alone says nothing about what the file is.
struct OpenedDocument: Identifiable {
    let id: String
    let name: String

    var fileId: FileId { FileId(id) }

    init(_ raw: String, name: String) {
        id = raw
        self.name = name
    }
}

private struct QuickLook: UIViewControllerRepresentable {
    let url: URL
    let done: () -> Void

    func makeUIViewController(context: Context) -> UINavigationController {
        let preview = QLPreviewController()
        preview.dataSource = context.coordinator
        // Quick Look adds its own Done only when it is the thing being
        // presented. Inside a cover it is not, so the way out is put back by
        // hand — through the coordinator rather than a captured closure, which
        // a `UIAction` handler may not hold.
        preview.navigationItem.leftBarButtonItem = UIBarButtonItem(
            title: "完成",
            style: .plain,
            target: context.coordinator,
            action: #selector(Coordinator.finish)
        )
        return UINavigationController(rootViewController: preview)
    }

    func updateUIViewController(_ controller: UINavigationController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(url: url, done: done) }

    @MainActor
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        private let item: NSURL
        private let done: () -> Void

        init(url: URL, done: @escaping () -> Void) {
            item = url as NSURL
            self.done = done
        }

        @objc func finish() { done() }

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

        func previewController(
            _ controller: QLPreviewController, previewItemAt index: Int
        ) -> any QLPreviewItem {
            item
        }
    }
}
