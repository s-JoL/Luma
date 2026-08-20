import MarkdownUI
import SwiftUI

/// Settled prose: full block Markdown through `swift-markdown-ui`. Used only for
/// text that will never change again, which is what makes it safe to lean on a
/// dependency in maintenance mode — CommonMark is a frozen spec and this renders
/// blocks that are already final.
struct MarkdownText: View, Equatable {
    let text: String
    let citations: [String: Citation]
    var onImage: ((ImageId) -> Void)?

    nonisolated static func == (lhs: MarkdownText, rhs: MarkdownText) -> Bool {
        lhs.text == rhs.text && lhs.citations.count == rhs.citations.count
    }

    var body: some View {
        Markdown(MarkdownText.source(text, citations: citations))
            .markdownTheme(.luma)
            .markdownImageProvider(TranscriptImageProvider(onImage: onImage))
            .environment(\.openURL, OpenURLAction { url in
                handle(url) ? .handled : .systemAction
            })
    }

    /// What the renderer is handed rather than what the model wrote: citations
    /// as links, the two prose repairs, and a paragraph of its own for every
    /// picture. The pictures go last because that step reads the text the other
    /// two produce.
    static func source(_ text: String, citations: [String: Citation]) -> String {
        InlineImages.ownParagraph(ProseFixups.apply(Citations.linkify(text, using: citations)))
    }

    /// A citation chip is a link by the time the renderer sees it, and so is an
    /// `image://` reference the model wrote as a link rather than as a picture,
    /// so both are intercepted here rather than needing a custom inline
    /// renderer. A picture is drawn instead, and carries its own tap.
    private func handle(_ url: URL) -> Bool {
        let text = url.absoluteString
        if text.hasPrefix(Citations.citeScheme) {
            let key = String(text.dropFirst(Citations.citeScheme.count)).removingPercentEncoding ?? ""
            if let destination = citations[key]?.url {
                UIApplication.shared.open(destination)
            }
            return true
        }
        if let id = ImageRef.parse(text) {
            onImage?(id)
            return true
        }
        return false
    }
}

/// The hook MarkdownUI has no default for. `image://` is not a scheme
/// `NetworkImage` can open, and its failure state is a zero-sized nothing, so an
/// answer that embedded a generated picture used to show the sentence about the
/// picture and no picture — while `withoutRepeatedImages` had already dropped the
/// standalone copy on the grounds that the prose would render it. This is the
/// place where that becomes true, and it is the same place the web client
/// resolves the reference (`transformUrl` in `src/web/markdown.tsx`).
///
/// The conformance is `@preconcurrency` because MarkdownUI declares the hook
/// `nonisolated` while everything it can return is a view: it is only ever
/// called from a body being built, so the isolation is real and the check for it
/// is left to the runtime.
@MainActor
private struct TranscriptImageProvider: @preconcurrency ImageProvider {
    var onImage: ((ImageId) -> Void)?

    func makeImage(url: URL?) -> some View {
        if let id = url.flatMap({ ImageRef.parse($0.absoluteString) }) {
            TranscriptPicture(imageId: id) { onImage?(id) }
        } else {
            DefaultImageProvider.default.makeImage(url: url)
        }
    }
}

/// `image://img_…` is how tools reference generated images in prose.
enum ImageRef {
    private static let pattern = try! NSRegularExpression(
        pattern: "^image://(img_[0-9a-f]{32})$", options: [.caseInsensitive]
    )

    static func parse(_ url: String) -> ImageId? {
        let range = NSRange(url.startIndex..., in: url)
        guard let match = pattern.firstMatch(in: url, range: range),
              let captured = Range(match.range(at: 1), in: url)
        else { return nil }
        return ImageId(String(url[captured]).lowercased())
    }
}

extension MarkdownUI.Theme {
    /// Matched to `src/web/theme.css` so an answer breaks in the same places in
    /// both clients. No syntax highlighting, because the web client has none
    /// either and adding it to one would split them.
    /// `Theme` is not `Sendable` and its builders are main-actor isolated, which
    /// is fine: the only thing that reads a theme is a view body.
    @MainActor static let luma = MarkdownUI.Theme()
        .text {
            ForegroundColor(.fg)
            FontSize(17)
        }
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(.em(0.92))
            BackgroundColor(.mutedFill)
        }
        .link { ForegroundColor(.brand) }
        .strong { FontWeight(.semibold) }
        .heading1 { configuration in
            configuration.label
                .markdownMargin(top: .em(0.8), bottom: .em(0.4))
                .markdownTextStyle { FontSize(.em(1.3)); FontWeight(.semibold) }
        }
        .heading2 { configuration in
            configuration.label
                .markdownMargin(top: .em(0.8), bottom: .em(0.35))
                .markdownTextStyle { FontSize(.em(1.15)); FontWeight(.semibold) }
        }
        .heading3 { configuration in
            configuration.label
                .markdownMargin(top: .em(0.7), bottom: .em(0.3))
                .markdownTextStyle { FontSize(.em(1.05)); FontWeight(.semibold) }
        }
        .paragraph { configuration in
            configuration.label
                .lineSpacing(3)
                .markdownMargin(top: 0, bottom: Space.md)
        }
        .codeBlock { configuration in
            // Horizontal scroll rather than wrapping: a wrapped 100-column line
            // is unreadable, and the header carries the copy button because
            // selecting monospaced text by hand on a phone is miserable.
            CodeBlockView(
                language: configuration.language,
                content: configuration.content.trimmingCharacters(in: .newlines)
            )
            .markdownMargin(top: Space.sm, bottom: Space.md)
        }
        .blockquote { configuration in
            configuration.label
                .padding(.leading, Space.md)
                .overlay(alignment: .leading) {
                    Rectangle().fill(Color.hairline).frame(width: 2)
                }
                .foregroundStyle(Color.mutedFg)
        }
        .table { configuration in
            ScrollView(.horizontal, showsIndicators: false) {
                configuration.label
            }
            .markdownMargin(top: Space.sm, bottom: Space.md)
        }
        .tableCell { configuration in
            configuration.label
                .padding(Space.sm)
                .overlay(Rectangle().strokeBorder(Color.hairline, lineWidth: 1))
        }
}
