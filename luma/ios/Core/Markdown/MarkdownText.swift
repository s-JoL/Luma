import MarkdownUI
import SwiftUI

/// Settled prose: full block Markdown through `swift-markdown-ui`, one block at a
/// time. Used only for text that will never change again, which is what makes it
/// safe to lean on a dependency in maintenance mode — CommonMark is a frozen spec
/// and this renders blocks that are already final.
///
/// The per-block structure is not a detail of this view, it is the reason the
/// transcript keeps up with a stream. See `ProseBlocks`.
struct MarkdownText: View, Equatable {
    let text: String
    let citations: CitationIndex
    var onImage: ((ImageId) -> Void)?

    nonisolated static func == (lhs: MarkdownText, rhs: MarkdownText) -> Bool {
        lhs.text == rhs.text && lhs.citations == rhs.citations
    }

    var body: some View {
        ProseBlockList(
            blocks: MarkdownCache.blocks(of: text),
            citations: citations,
            onImage: onImage
        )
    }
}

/// Already-split prose. The streaming path builds its own block list — it splits
/// once per frame to find the tail and would otherwise throw the result away —
/// so the split and the rendering are separate views.
struct ProseBlockList: View {
    let blocks: [ProseBlock]
    let citations: CitationIndex
    var onImage: ((ImageId) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(blocks) { block in
                MarkdownBlock(block: block, citations: citations, onImage: onImage)
                    .equatable()
                    .padding(.top, block.id == 0 ? 0 : block.kind.leadingSpace)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // Applied once per prose part rather than once per block.
        //
        // These are environment modifiers, so one high up covers every block
        // below it — and `Theme` is a large struct of closures. Sampling the app
        // while scrolling showed `initializeWithCopy for Theme` on the main
        // thread inside the lazy stack's prefetch, once per block view being
        // copied. A turn of ten paragraphs was carrying ten copies of the theme
        // for no benefit; the value is identical every time.
        .markdownTheme(.luma)
        .markdownImageProvider(TranscriptImageProvider(onImage: onImage))
        .environment(\.openURL, OpenURLAction { url in
            Citations.open(url, in: citations, onImage: onImage) ? .handled : .systemAction
        })
    }
}

/// One block, rendered from the parse cache.
///
/// `Equatable` on the block and the citation token is what lets a body pass skip
/// the ones that have not changed — which, during a run, is all of them but the
/// last. The tap handlers are deliberately outside the comparison: they are
/// closures rebuilt on every parent body, they are never stale in a way the
/// reader can observe, and comparing them would defeat the whole arrangement.
struct MarkdownBlock: View, Equatable {
    let block: ProseBlock
    let citations: CitationIndex
    var onImage: ((ImageId) -> Void)?

    nonisolated static func == (lhs: MarkdownBlock, rhs: MarkdownBlock) -> Bool {
        lhs.block == rhs.block && lhs.citations == rhs.citations
    }

    var body: some View {
        RenderLog.tick("MarkdownBlock")
        return Group {
            switch block.kind {
            case .math(let latex):
                MathBlock(latex: latex).equatable()
            case .table where PipeTable(block.source) != nil:
                // Never handed to MarkdownUI. Its table layout resolves an
                // anchor preference per cell through the view-transform chain on
                // the main thread, which a transcript with a table in several
                // turns turns into a multi-second stall. See `MarkdownTable`.
                MarkdownTable(table: PipeTable(block.source)!).equatable()
            default:
                // A sentence with a formula in it cannot go through MarkdownUI:
                // there is no way to put a foreign view inside a line of its
                // output, and the formula would render as its own source.
                // `InlineMathText` draws the whole paragraph instead. Only
                // paragraphs that actually contain one take that path.
                if Math.hasFormula(in: block.source) {
                    InlineMathText(text: block.source).equatable()
                } else if block.kind.isFlat, FlatProse.canRender(block) {
                    // The common case, and the one worth collapsing.
                    //
                    // MarkdownUI builds a SwiftUI view per markdown node, so a
                    // paragraph with a bold run and a link is a small tree, and
                    // a transcript is hundreds of them. Sampling during a scroll
                    // put the main thread in `LazyLayoutViewCache.signalPrefetch`
                    // copying `InlineText` / `ParagraphView` / `BlockSequence`
                    // values, with measured stalls of 150–185ms.
                    //
                    // A paragraph does not need a tree. Foundation's inline-only
                    // parser produces an `AttributedString` carrying the
                    // emphasis, code and links, and one `Text` draws it.
                    //
                    // Written as an `if` rather than as `case .paragraph,
                    // .heading where …`, because in a comma-separated case list
                    // a `where` clause binds only to the pattern it follows —
                    // which silently sent every picture-bearing paragraph down
                    // the flat path, where a picture can only be its alt text.
                    FlatProse(block: block, citations: citations).equatable()
                } else {
                    markdown
                }
            }
        }
    }

    /// The theme, the image provider and the link handler all come from the
    /// environment now — see `ProseBlockList`, which applies them once for the
    /// whole part instead of once per block.
    private var markdown: some View {
        Markdown(MarkdownCache.content(block.source, citations: citations))
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
        // A tinted ground behind every link, which in an agent's answer mostly
        // means citations. Grouped citations arrive as `[a.com](…)[b.com](…)`
        // with nothing between them; the thin space `ProseFixups` inserts stops
        // them running into one word, but two blue runs side by side still read
        // as one. A background is what makes them count.
        .link {
            ForegroundColor(.onAccent)
            BackgroundColor(.accentFill)
        }
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
        // Editorial rather than spreadsheet. A rule under the header and a hairline
        // between rows is enough to track a row across columns; boxing every cell
        // draws a grid the reader then has to look past to find the numbers. The
        // vertical rules are the ones to drop — columns are already separated by
        // the alignment of their contents.
        // The borders are drawn by the table itself, not by the cells, so this is
        // where the grid has to go: `insideHorizontalBorders` keeps the rules that
        // let the eye track a row across columns and drops the outer box and the
        // column rules, which only draw a spreadsheet the reader then has to look
        // past to find the numbers.
        .table { configuration in
            ScrollView(.horizontal, showsIndicators: false) {
                configuration.label
                    .markdownTableBorderStyle(
                        TableBorderStyle(.insideHorizontalBorders, color: .hairline, width: 1)
                    )
                    .markdownTableBackgroundStyle(
                        .alternatingRows(Color.clear, Color.mutedFill.opacity(0.35))
                    )
            }
            .markdownMargin(top: 0, bottom: 0)
        }
        .tableCell { configuration in
            configuration.label
                .markdownTextStyle {
                    if configuration.row == 0 { FontWeight(.semibold) }
                }
                .padding(.horizontal, Space.md)
                .padding(.vertical, Space.sm)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
}
