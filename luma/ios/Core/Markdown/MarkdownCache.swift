import MarkdownUI
import SwiftUI

/// Blocks that have already been through the source repairs and the parser.
///
/// Both steps are pure functions of the block and the citation map, and both used
/// to run inside `body`: `Citations.linkify`, `ProseFixups.apply` and
/// `InlineImages.ownParagraph` are four regular expressions and a character walk
/// over the text, and then `swift-markdown-ui` parses the CommonMark. Any view
/// pass that touched a turn paid for all of it again.
///
/// That is the other half of what the block split buys. Splitting stops a new
/// paragraph from re-parsing the ones above it; caching stops a body pass with no
/// new paragraph at all — the reader typing, scrolling, or rotating the phone —
/// from re-parsing anything.
/// A parsed block on its way back to the main actor.
///
/// `MarkdownContent` is an immutable tree of value types, but its module does
/// not mark it `Sendable`, so it cannot cross an actor boundary on its own. The
/// unchecked conformance is sound here for the reason the type is safe in the
/// first place: nothing mutates it after `init` — the parser produces it once
/// and the cache only ever reads it.
struct ParsedBox: @unchecked Sendable {
    let content: MarkdownContent
}

@MainActor
enum MarkdownCache {
    /// Keyed on the citation token as well as the source, because an anchor
    /// resolving late changes what the same block renders.
    private struct Key: Hashable {
        let source: String
        let citations: Int
    }

    /// The inline parse, for blocks that render as a single `Text`. Separate
    /// from the block cache because it is a different value for the same source
    /// — see `FlatProse`.
    struct InlineKey: Hashable {
        let source: String
        let kind: ProseBlock.Kind
        let citations: Int
    }

    static var inlineCache: [InlineKey: AttributedString] = [:]
    static var inlineOrder: [InlineKey] = []
    static let inlineLimit = 400

    private static var parsed: [Key: MarkdownContent] = [:]
    /// Insertion order, for eviction. Not moved on a hit: a strict LRU costs a
    /// lookup and a shift on the hot path to protect against a case — a
    /// transcript longer than the cache, read from the top — where the parse it
    /// saves is one the reader is scrolling past anyway.
    private static var order: [Key] = []
    private static let limit = 400

    /// How many blocks have actually been through the parser. The point of all
    /// of this is that a streaming answer parses each of its blocks once instead
    /// of re-parsing every block above the one being written, and that is a
    /// counting argument rather than a matter of taste — so `MarkdownCacheTests`
    /// counts it.
    private(set) static var parses = 0

    /// Counts a block that went through a parser, whichever of the two it was.
    static func countParse() { parses += 1 }

    static func content(_ source: String, citations: CitationIndex) -> MarkdownContent {
        let key = Key(source: source, citations: citations.token)
        if let hit = parsed[key] { return hit }

        parses += 1
        let content = MarkdownContent(prepared(source, citations: citations))
        parsed[key] = content
        order.append(key)
        if order.count > limit {
            parsed.removeValue(forKey: order.removeFirst())
        }
        return content
    }

    /// The block split, cached on the prose it came from.
    ///
    /// Worth caching for the same reason the parse is, and for one more: the
    /// streaming path asks for this on every published frame, and the settled
    /// prefix it asks about only changes when a paragraph completes. Without the
    /// cache the transcript would walk every line of the answer twenty times a
    /// second to rediscover boundaries it already knew.
    private static var splits: [String: [ProseBlock]] = [:]
    private static var splitOrder: [String] = []
    private static let splitLimit = 200

    static func blocks(of text: String) -> [ProseBlock] {
        if let hit = splits[text] { return hit }

        let blocks = ProseBlocks.blocks(of: text)
        splits[text] = blocks
        splitOrder.append(text)
        if splitOrder.count > splitLimit {
            splits.removeValue(forKey: splitOrder.removeFirst())
        }
        return blocks
    }

    /// The streaming path's fast lane, and the last piece of per-frame work that
    /// was still proportional to the length of the answer.
    ///
    /// `blocks(of:)` keys on the prose, which means building the settled prefix
    /// and hashing it — both linear, both on every published frame, both almost
    /// always to rediscover the same answer. A run only appends, so within one
    /// live turn the *length* of the settled prefix identifies it, and comparing
    /// an integer is enough. `generation` is what keeps that true across a
    /// rewind, where the same live turn is replaced by different prose that
    /// could briefly reach the same length.
    private static var growing: [String: (offset: Int, blocks: [ProseBlock])] = [:]

    static func blocks(of text: String, upTo cut: String.Index, stream key: String) -> [ProseBlock] {
        // O(1) on a native Swift string: the index carries its encoded offset.
        let offset = cut.utf16Offset(in: text)
        if let memo = growing[key], memo.offset == offset { return memo.blocks }

        let blocks = ProseBlocks.blocks(of: String(text[..<cut]))
        // One live turn at a time, and a handful of text parts within it.
        if growing.count > 8 { growing.removeAll(keepingCapacity: true) }
        growing[key] = (offset, blocks)
        return blocks
    }

    /// What the renderer is handed rather than what the model wrote: citations as
    /// links, the two prose repairs, and a paragraph of its own for every picture.
    /// The pictures go last because that step reads the text the other two produce.
    static func prepared(_ source: String, citations: CitationIndex) -> String {
        InlineImages.ownParagraph(ProseFixups.apply(Citations.linkify(source, using: citations.map)))
    }

    /// Parse ahead of the reader, off the main thread.
    ///
    /// A block is parsed the first time it is drawn, which is during the scroll
    /// that brought it on screen — the one moment there is no time for it. The
    /// fix is not to make the parse async at the view (that would leave a
    /// block with no height, and a block with no height reflows the transcript
    /// the moment it gets one). It is to have done the work already.
    ///
    /// The source repairs and the CommonMark parse are pure functions of a
    /// string, so they run on a background task; only the finished value crosses
    /// back. Called when turns change, which is exactly when the app learns
    /// about prose the reader has not reached yet.
    static func warm(_ turns: [Turn], citations: CitationIndex) {
        let sources = turns
            .flatMap(\.parts)
            .compactMap { part -> String? in
                if case .text(let text) = part { return text } else { return nil }
            }
        guard !sources.isEmpty else { return }

        let map = citations.map
        let token = citations.token

        Task.detached(priority: .utility) {
            for source in sources {
                if Task.isCancelled { return }
                // All of this is pure string work and runs off the main actor.
                // Each block is prepared into whichever representation its
                // renderer will actually ask for — the flat ones into an
                // `AttributedString`, the rest into a parsed block tree. Warming
                // the wrong one is work nobody ever collects, which is what this
                // did after paragraphs moved to `FlatProse`.
                var ready: [Warmed] = []
                for block in ProseBlocks.blocks(of: source) {
                    if Task.isCancelled { return }
                    let prepared = InlineImages.ownParagraph(
                        ProseFixups.apply(Citations.linkify(block.source, using: map))
                    )
                    if block.kind.isFlat, FlatProse.canRender(block) {
                        ready.append(.inline(
                            block,
                            FlatProse.parse(prepared, heading: block.kind.isHeading)
                        ))
                    } else {
                        ready.append(.blocks(block.source, ParsedBox(content: MarkdownContent(prepared))))
                    }
                }

                // One hop per turn rather than one per block. Several hundred
                // tiny main-actor jobs is its own kind of stall.
                let batch = ready
                await MainActor.run { adopt(batch, token: token) }
                await Task.yield()
            }
        }
    }

    /// A block prepared elsewhere, in the shape its renderer wants.
    enum Warmed: @unchecked Sendable {
        case inline(ProseBlock, AttributedString)
        case blocks(String, ParsedBox)
    }

    /// Files parses that happened elsewhere. Counted like any other, because
    /// `parses` means "blocks that went through the parser" and a prewarmed one
    /// did.
    private static func adopt(_ batch: [Warmed], token: Int) {
        for item in batch {
            switch item {
            case .inline(let block, let text):
                let key = InlineKey(source: block.source, kind: block.kind, citations: token)
                guard inlineCache[key] == nil else { continue }
                parses += 1
                inlineCache[key] = text
                inlineOrder.append(key)
                if inlineOrder.count > inlineLimit {
                    inlineCache.removeValue(forKey: inlineOrder.removeFirst())
                }
            case .blocks(let source, let box):
                let key = Key(source: source, citations: token)
                guard parsed[key] == nil else { continue }
                parses += 1
                parsed[key] = box.content
                order.append(key)
                if order.count > limit {
                    parsed.removeValue(forKey: order.removeFirst())
                }
            }
        }
    }

    /// Dropped wholesale under memory pressure. Everything here is recomputable,
    /// and a transcript that has to re-parse the paragraph on screen is a far
    /// better outcome than one the system kills.
    static func purge() {
        parsed.removeAll(keepingCapacity: false)
        order.removeAll(keepingCapacity: false)
        splits.removeAll(keepingCapacity: false)
        splitOrder.removeAll(keepingCapacity: false)
        growing.removeAll(keepingCapacity: false)
        inlineCache.removeAll(keepingCapacity: false)
        inlineOrder.removeAll(keepingCapacity: false)
    }

    /// Purge and reset the counter, so one test cannot read another's work.
    static func reset() {
        purge()
        parses = 0
    }
}
