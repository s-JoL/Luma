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
        Markdown(ProseFixups.apply(Citations.linkify(text, using: citations)))
            .markdownTheme(.luma)
            .environment(\.openURL, OpenURLAction { url in
                handle(url) ? .handled : .systemAction
            })
    }

    /// A citation chip and a generated image are both links by the time the
    /// renderer sees them, so both are intercepted here rather than needing a
    /// custom inline renderer.
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
