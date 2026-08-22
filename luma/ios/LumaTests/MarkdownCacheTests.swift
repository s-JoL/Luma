import Foundation
import Testing

@testable import Luma

/// What the block split was for.
///
/// Rendering the settled prefix of a streaming answer as one document re-parsed
/// the whole answer every time a paragraph completed: quadratic in the length of
/// the reply, on the main thread, while the next tokens were arriving. These
/// tests count parses, because that is the thing that changed — the rest is
/// visible only as a frame rate.
@MainActor
struct MarkdownCacheTests {
    /// The transcript's streaming path, without the views: split off the tail,
    /// then render the blocks above it.
    ///
    /// Mirrors `MarkdownBlock`'s dispatch, including which cache each kind of
    /// block reads. A paragraph goes through the flat inline path and a fenced
    /// block through the parsed one, and a test that asked the wrong cache would
    /// report a miss for work that had already been done.
    private func renderFrame(_ text: String) {
        let (settled, _) = ProseSplit.split(text, streaming: true)
        for block in MarkdownCache.blocks(of: settled) {
            if block.kind.isFlat, FlatProse.canRender(block) {
                _ = MarkdownCache.attributed(block, citations: CitationIndex())
            } else {
                _ = MarkdownCache.content(block.source, citations: CitationIndex())
            }
        }
    }

    private func answer(paragraphs: Int) -> String {
        (1...paragraphs)
            .map { "第 \($0) 段，写了一些**内容**，还带了 `代码` 和一个 [链接](https://example.com/\($0))。" }
            .joined(separator: "\n\n")
    }

    /// Streamed a token at a time, an answer of *n* paragraphs must cost *n*
    /// parses. It used to cost one per paragraph *boundary crossed*, each over a
    /// prefix that kept getting longer.
    @Test("a streaming answer parses each block once")
    func parsesEachBlockOnce() {
        MarkdownCache.reset()
        let full = answer(paragraphs: 40)

        // Grow the answer the way the stream does. Every frame re-runs the whole
        // render path, which is exactly the situation the cache exists for.
        var length = 0
        while length < full.count {
            length = min(length + 3, full.count)
            renderFrame(String(full.prefix(length)))
        }

        // 39 settled paragraphs (the last is still the tail), plus the handful of
        // partial blocks seen while a paragraph was still being written.
        #expect(MarkdownCache.parses <= 45, "parsed \(MarkdownCache.parses) times for 40 paragraphs")
        #expect(MarkdownCache.parses >= 39, "the answer really was rendered")
    }

    /// The same answer re-rendered — the reader typing, scrolling, or rotating
    /// the phone — must cost nothing at all.
    @Test("re-rendering settled prose parses nothing")
    func reRenderIsFree() {
        MarkdownCache.reset()
        let full = answer(paragraphs: 20)

        renderFrame(full)
        let afterFirst = MarkdownCache.parses
        #expect(afterFirst > 0)

        for _ in 0..<50 { renderFrame(full) }
        #expect(MarkdownCache.parses == afterFirst, "a repeated render re-parsed something")
    }

    /// A citation resolving late has to invalidate what it changes, or a chip
    /// never appears. This is the case `count` alone used to miss.
    @Test("a changed citation map re-parses")
    func citationsInvalidate() {
        MarkdownCache.reset()
        let source = "见 \u{E202}turn0search0 的说明。"

        let empty = CitationIndex()
        _ = MarkdownCache.content(source, citations: empty)
        let afterEmpty = MarkdownCache.parses

        let resolved = CitationIndex([
            "\\ue202turn0search0": Citation(
                label: "example.com",
                url: URL(string: "https://example.com"),
                detail: nil
            )
        ])
        _ = MarkdownCache.content(source, citations: resolved)
        #expect(MarkdownCache.parses == afterEmpty + 1)

        // Same contents, rebuilt: the token matches, so the parse is reused.
        let again = CitationIndex([
            "\\ue202turn0search0": Citation(
                label: "example.com",
                url: URL(string: "https://example.com"),
                detail: nil
            )
        ])
        _ = MarkdownCache.content(source, citations: again)
        #expect(MarkdownCache.parses == afterEmpty + 1, "an identical map should not re-parse")
    }

    /// Prewarming is only worth anything if the render that follows is free.
    /// If this regresses, the first sight of a block goes back to parsing during
    /// the scroll that revealed it.
    @Test("prewarming means the first render costs nothing")
    func prewarmsAhead() async throws {
        MarkdownCache.reset()

        let text = answer(paragraphs: 12)
        let turn = Turn(id: "t1", seq: 0, role: .assistant, parts: [.text(text)])
        let warming = MarkdownCache.warm([turn], citations: CitationIndex())

        // The warm runs on a detached task; wait for it rather than racing it.
        let deadline = Date().addingTimeInterval(5)
        while MarkdownCache.parses < 12, Date() < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        await warming.value
        let warmed = MarkdownCache.parses
        #expect(warmed >= 12, "prewarm should have parsed every block, got \(warmed)")

        renderFrame(text)
        #expect(MarkdownCache.parses == warmed, "a prewarmed turn should render without parsing")
    }

    @Test("a purge under memory pressure loses nothing but the work")
    func purgeIsRecoverable() {
        MarkdownCache.reset()
        let text = answer(paragraphs: 3)
        renderFrame(text)
        let before = MarkdownCache.parses

        MarkdownCache.purge()
        renderFrame(text)
        #expect(MarkdownCache.parses > before, "a purged cache has to do the work again")

        let after = MarkdownCache.parses
        renderFrame(text)
        #expect(MarkdownCache.parses == after, "and then be warm again")
    }
}
