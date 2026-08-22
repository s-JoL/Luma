import Testing

@testable import Luma

/// The same properties `src/web/markdown.tsx` holds, because a formula has to
/// break the same way in both clients.
struct MathTests {
    // MARK: Delimiters

    @Test("bracket delimiters become dollars")
    func normalisesBrackets() {
        #expect(Math.normalise("公式：\\[a^2 + b^2 = c^2\\]") == "公式：$$a^2 + b^2 = c^2$$")
        #expect(Math.normalise("其中 \\(x\\) 是变量") == "其中 $x$ 是变量")
    }

    @Test("a formula spanning lines is still one formula")
    func normalisesAcrossLines() {
        #expect(Math.normalise("\\[\na + b\n\\]") == "$$\na + b\n$$")
    }

    @Test("code keeps its backslashes")
    func leavesCodeAlone() {
        let text = "写 `\\(x\\)` 表示行内公式"
        #expect(Math.normalise(text) == text)
    }

    @Test("text with no math is returned untouched")
    func skipsPlainProse() {
        let text = "普通的一段话，没有任何公式。"
        #expect(Math.normalise(text) == text)
    }

    // MARK: Currency, which is the trap

    @Test("prices are not formulas")
    func guardsCurrency() {
        let runs = Math.runs(in: "从 $5 涨到 $10 了")
        #expect(runs == [.text("从 $5 涨到 $10 了")], "got \(runs)")
    }

    @Test("a short symbol run is a formula")
    func acceptsShortSymbols() {
        #expect(Math.runs(in: "设 $x$ 为变量") == [.text("设 "), .math("x"), .text(" 为变量")])
    }

    @Test("a backslash command is a formula however long")
    func acceptsCommands() {
        let runs = Math.runs(in: "面积是 $\\frac{1}{2} b h$ 这么大")
        #expect(runs == [.text("面积是 "), .math("\\frac{1}{2} b h"), .text(" 这么大")])
    }

    @Test("a relation is a formula")
    func acceptsRelations() {
        #expect(Math.isFormula("a = b"))
        #expect(Math.isFormula("x^2"))
        #expect(Math.isFormula("a_1"))
        #expect(!Math.isFormula("5 到 10 块钱"))
    }

    // MARK: Splitting

    @Test("several formulas in one sentence all come out")
    func splitsSeveral()  {
        let runs = Math.runs(in: "$a$ 加 $b$ 等于 $c$")
        #expect(runs == [
            .math("a"), .text(" 加 "), .math("b"), .text(" 等于 "), .math("c"),
        ])
    }

    @Test("an unclosed dollar stays prose")
    func leavesUnclosedAlone() {
        #expect(Math.runs(in: "只有一个 $x 没有闭合") == [.text("只有一个 $x 没有闭合")])
    }

    @Test("prose with no dollars is one run")
    func singleRun() {
        #expect(Math.runs(in: "什么都没有") == [.text("什么都没有")])
        #expect(!Math.hasFormula(in: "什么都没有"))
    }

    // MARK: Display blocks

    @Test("a lone display formula is its own block")
    func detectsDisplayBlock() {
        #expect(Math.displayBody(of: "$$a^2 + b^2 = c^2$$") == "a^2 + b^2 = c^2")
        #expect(Math.displayBody(of: "$$\n  \\int_0^1 x\\,dx\n$$") == "\\int_0^1 x\\,dx")
    }

    @Test("prose around a formula means it is not a display block")
    func rejectsMixedBlock() {
        #expect(Math.displayBody(of: "结果是 $$a$$ 对吧") == nil)
        #expect(Math.displayBody(of: "$$a$$ 和 $$b$$") == nil)
        #expect(Math.displayBody(of: "普通一段") == nil)
    }

    /// The whole point of routing display math through the block splitter: it has
    /// to come out as one block, with the delimiters already stripped.
    @Test("the block splitter reports a display formula as math")
    func splitterClassifies() {
        let blocks = ProseBlocks.blocks(of: "先看这个：\n\n\\[E = mc^2\\]\n\n就这样。")
        #expect(blocks.count == 3)
        #expect(blocks[1].kind == .math("E = mc^2"))
        #expect(blocks[0].kind == .paragraph)
        #expect(blocks[2].kind == .paragraph)
    }
}
