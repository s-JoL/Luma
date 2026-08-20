import Foundation
import SwiftUI
import Testing
@testable import Luma

/// A picture the model embedded in its answer used to vanish, and every existing
/// test was green: the turn was built correctly, the standalone copy was dropped
/// on purpose, and the prose held the reference. Nothing asserted that anything
/// drew it. So these tests end where the bug was — at the source the renderer is
/// given, and at the space the rendered prose takes up.
struct InlineImagePromotionTests {
    private static let reference = "![夜晚霓虹弯月](image://img_4df7d10cbebbc402ca5a040b9a10d4c9)"

    @Test("prose with no picture in it is handed over untouched")
    func leavesOrdinaryProseAlone() {
        let text = "先查一下，再回答。\n\n**结论**：用 dpmpp_2m。"
        #expect(InlineImages.ownParagraph(text) == text)
    }

    /// What the audit server's `edit_image` run actually returned.
    @Test("a picture already in its own paragraph stays where it is")
    func keepsASettledParagraph() {
        let text = "已经改成夜晚霓虹灯风格。\n\n\(Self.reference)"
        #expect(InlineImages.ownParagraph(text) == text)
    }

    @Test("a picture sharing a line with prose gets a paragraph of its own")
    func splitsAMixedLine() {
        #expect(
            InlineImages.ownParagraph("画好了：\(Self.reference)")
                == "画好了：\n\n\(Self.reference)"
        )
    }

    /// One line break is not a paragraph break: a picture written under its
    /// caption is still mixed into that caption's paragraph, which is the shape
    /// that renders as a line of text and nothing else.
    @Test("a picture on the line below its caption is separated from it")
    func separatesASoftBreak() {
        #expect(
            InlineImages.ownParagraph("画好了：\n\(Self.reference)")
                == "画好了：\n\n\(Self.reference)"
        )
    }

    @Test("prose after a picture starts a new paragraph")
    func splitsTrailingProse() {
        #expect(
            InlineImages.ownParagraph("\(Self.reference) 好看吧？")
                == "\(Self.reference)\n\n好看吧？"
        )
    }

    /// The picture has to stay inside the item it belongs to, so it is indented
    /// to the item's text rather than left at the margin, which would end the
    /// list.
    @Test("a picture in a list item becomes a block of that item")
    func indentsInsideAListItem() {
        #expect(
            InlineImages.ownParagraph("1. 夜景：\(Self.reference)")
                == "1. 夜景：\n\n   \(Self.reference)"
        )
        #expect(
            InlineImages.ownParagraph("- \(Self.reference) 第一版")
                == "- \(Self.reference)\n\n  第一版"
        )
    }

    /// A blank line closes a blockquote, so the separator inside one is `>`.
    @Test("a picture in a blockquote is separated without leaving the quote")
    func staysInsideABlockquote() {
        #expect(
            InlineImages.ownParagraph("> 夜景：\(Self.reference)")
                == "> 夜景：\n>\n> \(Self.reference)"
        )
    }

    @Test("a reference being shown as code is text, not a picture")
    func leavesCodeAlone() {
        let fenced = "```\n\(Self.reference)\n```"
        #expect(InlineImages.ownParagraph(fenced) == fenced)
        let span = "写成 `\(Self.reference)` 这样"
        #expect(InlineImages.ownParagraph(span) == span)
    }

    /// Moving the label out of a link breaks both the link and the picture.
    @Test("a picture used as a link's label is left in the link")
    func leavesALinkLabelAlone() {
        let text = "看这里 [\(Self.reference)](https://example.com) 谢谢"
        #expect(InlineImages.ownParagraph(text) == text)
    }

    @Test("a table cell is left as written, having nowhere to put a paragraph")
    func leavesATableRowAlone() {
        let row = "| 改前 | \(Self.reference) |"
        #expect(InlineImages.ownParagraph(row) == row)
    }
}

/// The half-written tail of a streaming answer. `Mask` has to hide an image
/// whose destination has not arrived and leave a finished one alone.
struct StreamingImageTests {
    @Test("a finished picture in the tail survives masking")
    func keepsAClosedReference() {
        let text = "画好了：![猫](image://img_0123456789abcdef0123456789abcdef)"
        #expect(Mask.incompleteTail(text) == text)
    }

    @Test("a picture whose destination is still arriving shows nothing")
    func hidesAnUnclosedReference() {
        #expect(Mask.incompleteTail("画好了：![猫](image://img_0123") == "画好了：")
        #expect(Mask.incompleteTail("画好了：![") == "画好了：")
    }

    /// The tail is drawn as a `Text`, which can only show a picture's alt text.
    /// So a finished picture belongs to the settled side, where it is drawn as a
    /// picture, and gets there without waiting for the blank line after it.
    @Test("a finished picture settles as soon as it is written")
    func settlesAFinishedPicture() {
        let text = "已经改好了。\n\n![猫](image://img_0123456789abcdef0123456789abcdef)"
        let (settled, tail) = ProseSplit.split(text, streaming: true)
        #expect(settled == text)
        #expect(tail.isEmpty)
    }

    @Test("a picture still being written stays in the tail, where it is hidden")
    func keepsAnUnfinishedPictureInTheTail() {
        let (settled, tail) = ProseSplit.split(
            "已经改好了。\n\n![猫](image://img_0123", streaming: true
        )
        #expect(settled == "已经改好了。\n\n")
        #expect(Mask.incompleteTail(tail).isEmpty)
    }

    @Test("a reference inside an unclosed fence settles nothing")
    func leavesAnOpenFenceAlone() {
        let (settled, tail) = ProseSplit.split(
            "写法：\n\n```\n![猫](image://img_0123456789abcdef0123456789abcdef)", streaming: true
        )
        #expect(settled == "写法：\n\n")
        #expect(tail.hasPrefix("```"))
    }
}

/// Laid out for real, because the layer that failed was the one no test reached.
@MainActor
struct TranscriptPictureRenderTests {
    private static let id = "img_4df7d10cbebbc402ca5a040b9a10d4c9"
    /// `AuthedImage`'s placeholder is 120 points tall, so a picture that is
    /// rendered at all adds at least that much. One the renderer skips adds
    /// nothing — which is exactly what an unresolvable `image://` did.
    private static let placeholder: CGFloat = 120

    private static let markup = try! NSRegularExpression(
        pattern: "!\\[[^\\]]*\\]\\(image://[^)]*\\)"
    )

    /// The height this prose asks for at a phone's column width.
    private func height(_ text: String) -> CGFloat {
        let host = UIHostingController(rootView: MarkdownText(text: text, citations: [:]))
        return host.sizeThatFits(in: CGSize(width: 320, height: CGFloat.greatestFiniteMagnitude)).height
    }

    /// The same prose with every picture taken out: the baseline a rendered
    /// picture has to rise above.
    private func withoutPictures(_ text: String) -> String {
        Self.markup.stringByReplacingMatches(
            in: text, range: NSRange(text.startIndex..., in: text), withTemplate: ""
        )
    }

    private func addedHeight(_ text: String) -> CGFloat {
        height(text) - height(withoutPictures(text))
    }

    @Test("a picture in its own paragraph is drawn there")
    func drawsASettledParagraph() {
        let prose = "已经改成夜晚霓虹灯风格。\n\n![夜晚霓虹弯月](image://\(Self.id))"
        #expect(addedHeight(prose) >= Self.placeholder)
    }

    @Test("a picture sharing a line with prose is drawn there too")
    func drawsAMixedLine() {
        #expect(addedHeight("画好了：![猫](image://\(Self.id))") >= Self.placeholder)
    }

    @Test("a picture under its caption is drawn rather than swallowed by it")
    func drawsAcrossASoftBreak() {
        #expect(addedHeight("画好了：\n![猫](image://\(Self.id))") >= Self.placeholder)
    }

    /// The invariant the deduplication rests on. `withoutRepeatedImages` removes
    /// the standalone copy of a picture the prose refers to, so the prose has to
    /// be the thing that shows it — every picture in the turn exactly once,
    /// counted where the reader would count them.
    @Test("the copy the transcript dropped is the copy the prose draws")
    func everyPictureOnceAndVisible() {
        let turn = TurnBuilder.build(Fixtures.messages(Fixtures.imageTurn))[1]
        let standalone = turn.parts.filter { if case .image = $0 { true } else { false } }
        #expect(standalone.isEmpty, "the prose already refers to it")

        var drawn = 0
        for case .text(let prose) in turn.parts where prose != withoutPictures(prose) {
            #expect(addedHeight(prose) >= Self.placeholder, "the prose refers to a picture it does not draw")
            drawn += 1
        }
        #expect(drawn == 1)
    }
}
