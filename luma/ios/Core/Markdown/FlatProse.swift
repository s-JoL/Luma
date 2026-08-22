import SwiftUI

/// A paragraph or heading as a single `Text`.
///
/// The transcript's hot path. Everything else in the renderer is arranged so
/// that most blocks end up here, because this is the one shape that costs a
/// constant number of views regardless of how much markup is in it.
///
/// The alternative — and what the app did — is `swift-markdown-ui`, which builds
/// a SwiftUI view per markdown node: a paragraph with two bold runs and a link is
/// five or six nested views, and a long transcript is thousands. Those values are
/// copied by the lazy stack's prefetch, on the main thread, while the reader is
/// scrolling. Sampling put the main thread in `signalPrefetch` doing exactly that,
/// and the heartbeat measured 150–185ms stalls.
///
/// Foundation's own Markdown parser already produces everything a paragraph
/// needs. `Text` renders an `AttributedString` in one view, handles links through
/// the environment's `openURL`, and gets text selection, Dynamic Type and
/// line-breaking from the system rather than from a layout tree.
struct FlatProse: View, Equatable {
    let block: ProseBlock
    let citations: CitationIndex

    nonisolated static func == (lhs: FlatProse, rhs: FlatProse) -> Bool {
        lhs.block == rhs.block && lhs.citations == rhs.citations
    }

    /// Whether this block is one `Text` can render faithfully.
    ///
    /// A picture is the exception that matters: `InlineImages.ownParagraph` gives
    /// every `image://` reference a paragraph of its own, but the reference is
    /// still *inside* that paragraph's text, and an `AttributedString` can only
    /// show its alt text. Those blocks keep the block renderer, which has an
    /// image provider. Everything else — emphasis, code spans, links, citation
    /// chips — survives the flat path exactly.
    nonisolated static func canRender(_ block: ProseBlock) -> Bool {
        !block.source.contains("image://") && !block.source.contains("![")
    }

    var body: some View {
        Text(MarkdownCache.attributed(block, citations: citations))
            .font(font)
            .foregroundStyle(Color.fg)
            .proseLeading()
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var font: Font {
        switch block.kind {
        case .heading(let level):
            switch level {
            case 1: .system(.title2, weight: .semibold)
            case 2: .system(.title3, weight: .semibold)
            default: .system(.headline)
            }
        default:
            .body
        }
    }
}

extension MarkdownCache {
    /// The inline parse, cached beside the block parse and evicted with it.
    ///
    /// Same reasoning as `content(_:citations:)`: it is a pure function of the
    /// source and the citation map, and running it inside `body` means running
    /// it again every time anything else on the screen changes.
    static func attributed(_ block: ProseBlock, citations: CitationIndex) -> AttributedString {
        let key = InlineKey(source: block.source, kind: block.kind, citations: citations.token)
        if let hit = inlineCache[key] { return hit }

        let source = prepared(block.source, citations: citations)
        let parsed = FlatProse.parse(source, heading: block.kind.isHeading)

        countParse()
        inlineCache[key] = parsed
        inlineOrder.append(key)
        if inlineOrder.count > inlineLimit {
            inlineCache.removeValue(forKey: inlineOrder.removeFirst())
        }
        return parsed
    }

    nonisolated static func strippedHeading(_ source: String) -> String {
        var text = Substring(source)
        text = text.drop { $0 == " " || $0 == "\t" }
        text = text.drop { $0 == "#" }
        return String(text).trimmingCharacters(in: .whitespaces)
    }
}

extension FlatProse {
    /// The inline parse itself, with no cache and no actor.
    ///
    /// Split out so the prewarm can run it off the main thread — Foundation's
    /// Markdown parser has no isolation requirement, and the whole point of
    /// warming is to have done this before the reader scrolls into it.
    nonisolated static func parse(_ prepared: String, heading: Bool) -> AttributedString {
        // A heading keeps its text and loses its hashes; the size comes from the
        // font, not from the markup.
        let body = heading ? MarkdownCache.strippedHeading(prepared) : prepared
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: false,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        var text = (try? AttributedString(markdown: body, options: options)) ?? AttributedString(body)

        // Links are styled here rather than by the Markdown theme, because a
        // flat paragraph never reaches the theme. Without this a citation in a
        // paragraph and the same citation inside a list would be two different
        // looking things. The tinted ground is what separates grouped citations
        // — `[a.com](…)[b.com](…)` arrives with nothing between them and reads
        // as one word when both runs are only coloured.
        for run in text.runs where run.link != nil {
            text[run.range].foregroundColor = Color.onAccent
            text[run.range].backgroundColor = Color.accentFill
        }
        return text
    }
}

extension ProseBlock.Kind {
    var isHeading: Bool {
        if case .heading = self { return true }
        return false
    }

    /// Kinds that are a run of styled text and nothing else, so one `Text` can
    /// draw them. Lists and quotes are excluded because their structure — the
    /// markers, the indent, the rule — is layout rather than markup.
    var isFlat: Bool {
        switch self {
        case .paragraph, .heading: true
        case .list, .code, .quote, .table, .math: false
        }
    }
}
