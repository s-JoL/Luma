import Testing
@testable import Luma

/// The property the web's `scripts/audit-markdown.tsx` asserts, ported: every
/// prefix of a streamed line renders, and none may show a delimiter that has not
/// closed yet.
struct MaskTests {
    @Test("a closed delimiter is left alone")
    func closedDelimiters() {
        #expect(Mask.incompleteTail("**加粗**后面") == "**加粗**后面")
        #expect(Mask.incompleteTail("`code` and more") == "`code` and more")
        #expect(Mask.incompleteTail("~~gone~~ ok") == "~~gone~~ ok")
    }

    @Test("a half-written delimiter is hidden")
    func openDelimiters() {
        #expect(Mask.incompleteTail("**加粗") == "加粗")
        #expect(Mask.incompleteTail("前面 **加粗") == "前面 加粗")
        #expect(Mask.incompleteTail("~~删除") == "删除")
        #expect(Mask.incompleteTail("一个 `co") == "一个 co")
    }

    @Test("a trailing backtick run is dropped so a fence opener does not flash")
    func fenceOpener() {
        #expect(Mask.incompleteTail("text `") == "text ")
        #expect(Mask.incompleteTail("text ``") == "text ")
    }

    @Test("an open fence renders verbatim and is left entirely alone")
    func openFence() {
        let text = "```swift\nlet x = **not bold**\n"
        #expect(Mask.incompleteTail(text) == text)
    }

    @Test("a closed fence is not disturbed by masking the prose after it")
    func closedFence() {
        let text = "```\ncode\n```\nthen **bold"
        #expect(Mask.incompleteTail(text) == "```\ncode\n```\nthen bold")
    }

    @Test("an unfinished link shows its label and nothing else")
    func partialLink() {
        #expect(Mask.incompleteTail("see [标题") == "see 标题")
        #expect(Mask.incompleteTail("see [标题](htt") == "see 标题")
        #expect(Mask.incompleteTail("see [标题](https://x.com)") == "see [标题](https://x.com)")
    }

    @Test("an unfinished image shows nothing, because alt text is not prose")
    func partialImage() {
        #expect(Mask.incompleteTail("look ![alt") == "look ")
        #expect(Mask.incompleteTail("look ![alt](image://x") == "look ")
    }

    @Test("no prefix of a streamed line ever shows an unclosed delimiter")
    func everyPrefix() {
        let line = "**五图卡点：**开门入冬 → `清点存货` 与 [来源](https://example.com) 结束。"
        for end in line.indices {
            let masked = Mask.incompleteTail(String(line[line.startIndex...end]))
            #expect(!endsWithOpenDelimiter(masked), "prefix leaked a delimiter: \(masked)")
        }
    }

    private func endsWithOpenDelimiter(_ text: String) -> Bool {
        for delimiter in ["**", "~~", "`"] {
            let count = text.components(separatedBy: delimiter).count - 1
            if count % 2 == 1 { return true }
        }
        return false
    }
}
