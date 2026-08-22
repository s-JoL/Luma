import Testing

@testable import Luma

/// The split that makes streaming linear. Two properties matter: it must not
/// change what the reader sees, and appending must not disturb what came before.
struct ProseBlocksTests {
    private func sources(_ text: String) -> [String] {
        ProseBlocks.blocks(of: text).map(\.source)
    }

    // MARK: What a block is

    @Test("a blank line separates paragraphs")
    func splitsParagraphs() {
        #expect(sources("第一段。\n\n第二段。") == ["第一段。", "第二段。"])
    }

    @Test("consecutive blank lines do not make empty blocks")
    func ignoresRuns() {
        #expect(sources("一。\n\n\n\n二。") == ["一。", "二。"])
        #expect(sources("\n\n开头有空行。\n\n") == ["开头有空行。"])
    }

    @Test("a soft break stays inside its paragraph")
    func keepsSoftBreaks() {
        #expect(sources("上一行\n下一行") == ["上一行\n下一行"])
    }

    // MARK: The containers a blank line must not cut

    /// The one that would be visible immediately: split, each half renders as its
    /// own list and the second one starts at 1 again.
    @Test("a loose ordered list stays one block")
    func keepsLooseOrderedList() {
        let text = "1. 第一项\n\n2. 第二项\n\n3. 第三项"
        #expect(sources(text) == [text])
    }

    @Test("a loose bulleted list stays one block")
    func keepsLooseBulletList() {
        let text = "- 一\n\n- 二"
        #expect(sources(text) == [text])
    }

    @Test("a paragraph indented under a list item belongs to the item")
    func keepsIndentedContinuation() {
        let text = "- 一\n\n  接着说\n\n- 二"
        #expect(sources(text) == [text])
    }

    @Test("a fenced block owns its blank lines")
    func keepsFencedCode() {
        let text = "```swift\nlet a = 1\n\nlet b = 2\n```"
        #expect(sources(text) == [text])
    }

    @Test("a fence is only closed by at least as many of its own marker")
    func respectsFenceLength() {
        let text = "````\n```\n\n还在里面\n````"
        #expect(sources(text) == [text])
    }

    @Test("an unclosed fence swallows the rest of the answer")
    func keepsOpenFenceWhole() {
        let text = "```\nstill writing\n\nand more"
        #expect(sources(text) == [text])
    }

    @Test("an indented code block survives a blank line")
    func keepsIndentedCode() {
        let text = "    let a = 1\n\n    let b = 2"
        #expect(sources(text) == [text])
    }

    @Test("a blockquote survives a blank line")
    func keepsBlockquote() {
        let text = "> 一\n\n> 二"
        #expect(sources(text) == [text])
    }

    @Test("prose after a list is its own block")
    func separatesAfterList() {
        #expect(sources("- 一\n- 二\n\n结尾。") == ["- 一\n- 二", "结尾。"])
    }

    @Test("prose after a fence is its own block")
    func separatesAfterFence() {
        #expect(sources("```\ncode\n```\n\n说明。") == ["```\ncode\n```", "说明。"])
    }

    // MARK: Kinds, which decide the space above a block

    @Test("a block knows what it is")
    func classifies() {
        #expect(ProseBlocks.blocks(of: "# 标题")[0].kind == .heading(level: 1))
        #expect(ProseBlocks.blocks(of: "### 小标题")[0].kind == .heading(level: 3))
        #expect(ProseBlocks.blocks(of: "```\nx\n```")[0].kind == .code)
        #expect(ProseBlocks.blocks(of: "    x")[0].kind == .code)
        #expect(ProseBlocks.blocks(of: "> 引用")[0].kind == .quote)
        #expect(ProseBlocks.blocks(of: "| a | b |")[0].kind == .table)
        #expect(ProseBlocks.blocks(of: "- 一")[0].kind == .list)
        #expect(ProseBlocks.blocks(of: "1. 一")[0].kind == .list)
        #expect(ProseBlocks.blocks(of: "普通一段")[0].kind == .paragraph)
    }

    /// `#hashtag` is not a heading, and a list marker needs its space.
    @Test("a heading needs its space and so does a list marker")
    func doesNotOverClassify() {
        #expect(ProseBlocks.blocks(of: "#标签")[0].kind == .paragraph)
        #expect(ProseBlocks.blocks(of: "-未加空格")[0].kind == .paragraph)
    }

    // MARK: The property the cache rests on

    /// Every block above the one being written must come out byte-identical as
    /// the answer grows, or the parse cache misses and the split has bought
    /// nothing. This is the actual invariant behind the optimisation, so it is
    /// asserted rather than assumed.
    @Test("appending never disturbs the blocks above")
    func appendingIsStable() {
        let full = """
            开头一段。

            ## 小标题

            1. 第一项

            2. 第二项

            ```swift
            let a = 1
            ```

            > 引用

            结尾一段。
            """

        // Only the last block can still be extended, so "settled" means every
        // block above it — and a block that was settled once must never change.
        var settled: [String] = []
        for end in stride(from: 1, through: full.count, by: 7) {
            let index = full.index(full.startIndex, offsetBy: end)
            let blocks = sources(String(full[..<index])).dropLast()
            for (offset, block) in blocks.enumerated() where offset < settled.count {
                #expect(block == settled[offset], "block \(offset) changed as the answer grew")
            }
            #expect(blocks.count >= settled.count, "a settled block disappeared")
            settled = Array(blocks)
        }
        #expect(settled.count > 3, "the walk should have settled most of the answer")
    }

    @Test("blocks put the answer back together")
    func losesNothing() {
        let text = "一段。\n\n- 甲\n- 乙\n\n```\ncode\n```\n\n收尾。"
        let joined = sources(text).joined(separator: "\n\n")
        #expect(joined == text)
    }

    @Test("nothing in, nothing out")
    func handlesEmpty() {
        #expect(sources("").isEmpty)
        #expect(sources("\n\n  \n").isEmpty)
    }
}
