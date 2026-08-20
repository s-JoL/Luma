import Testing
@testable import Luma

/// The two repairs the web renderer already carries, both of which were seen
/// rendering wrong before they were ported.
struct ProseFixupsTests {
    @Test("bold survives a CJK colon before the closing delimiter")
    func boldAcrossCJKColon() {
        // CommonMark will not close this run, because `：` is punctuation and
        // `开` is a letter. The repair makes the closer flanking again.
        let repaired = ProseFixups.repairLiteralStrong("**五图卡点：**开门入冬")
        #expect(repaired == "**五图卡点：\u{200B}**开门入冬")
    }

    @Test("a run CommonMark already handles is left untouched")
    func ordinaryBoldIsUnchanged() {
        #expect(ProseFixups.repairLiteralStrong("**bold** text") == "**bold** text")
        #expect(ProseFixups.repairLiteralStrong("这是 **加粗** 文字") == "这是 **加粗** 文字")
        // Punctuation before the closer is fine when a space follows it.
        #expect(ProseFixups.repairLiteralStrong("**结束。** 后面") == "**结束。** 后面")
    }

    @Test("an unclosed run is left exactly as written")
    func unclosedRun() {
        #expect(ProseFixups.repairLiteralStrong("**还没写完") == "**还没写完")
    }

    @Test("adjacent links get a separator so they are not one run-on word")
    func adjacentLinks() {
        let joined = "[youtube.com](https://y.com)[bilibili.com](https://b.com)"
        let separated = ProseFixups.separateAdjacentLinks(joined)
        #expect(separated == "[youtube.com](https://y.com)\u{2009}[bilibili.com](https://b.com)")
    }

    @Test("a lone link is not padded")
    func singleLink() {
        let one = "见 [来源](https://x.com) 结束"
        #expect(ProseFixups.separateAdjacentLinks(one) == one)
    }

    @Test("code spans are never rewritten")
    func codeIsUntouched() {
        let text = "prose **五图：**开门 `let x = **a：**b` end"
        let fixed = ProseFixups.apply(text)
        #expect(fixed.contains("`let x = **a：**b`"), "the inline span keeps its literal asterisks")
        #expect(fixed.contains("**五图：\u{200B}**开门"), "the prose around it is still repaired")
    }

    @Test("a fenced block is never rewritten")
    func fencesAreUntouched() {
        let text = "```\n**标题：**内容\n```\n**标题：**内容"
        let fixed = ProseFixups.apply(text)
        #expect(fixed.contains("```\n**标题：**内容\n```"))
        #expect(fixed.hasSuffix("**标题：\u{200B}**内容"))
    }

    @Test("the reference string comes out renderable")
    func referenceString() {
        let reference = "**五图卡点：**开门入冬 → 清点存货。[youtube.com](https://y.com)[bilibili.com](https://b.com)"
        let fixed = ProseFixups.apply(reference)
        #expect(fixed.contains("**五图卡点：\u{200B}**"))
        #expect(fixed.contains(")\u{2009}["))
    }
}
