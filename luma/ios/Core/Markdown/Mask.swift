import Foundation

/// While a message is still streaming, its last delimiter is routinely half
/// written, and Markdown shows that half as literal punctuation until the closer
/// lands. Hiding the dangling delimiter keeps `**加粗` from flashing its asterisks
/// a token before it turns bold.
///
/// A port of `maskIncompleteTail` in `src/web/markdown.tsx`. The step order is
/// load-bearing and the tests in `MaskTests` are the same property the web's
/// `scripts/audit-markdown.tsx` asserts.
enum Mask {
    static func incompleteTail(_ text: String) -> String {
        // 1. An open fence already renders as a verbatim block and every
        //    delimiter inside it is content, so the whole message is left alone.
        if fenceLineCount(text) % 2 == 1 { return text }

        // 2. Only the prose after every *closed* code span can hold a dangling
        //    delimiter. The split requires a non-empty inline span, so a fence
        //    opener arriving one backtick at a time stays in the prose tail
        //    where step 3 can hide it, instead of being mistaken for an empty
        //    inline span.
        let (head, tail) = splitTrailingProse(text)
        var masked = tail

        // 3. Drop a trailing backtick run, then close each delimiter whose count
        //    is odd by removing its *last* occurrence.
        masked = masked.replacingOccurrences(
            of: "`{1,2}$", with: "", options: [.regularExpression]
        )
        for delimiter in ["**", "~~", "`"] {
            let count = masked.components(separatedBy: delimiter).count - 1
            if count % 2 == 1 { masked = removingLast(delimiter, in: masked) }
        }

        // 4. A link is only readable once its destination arrives; until then
        //    show the label alone, and nothing at all for an image, whose alt
        //    text is not prose.
        masked = maskPartialLink(masked)

        return head + masked
    }

    /// Lines that begin a fence. An odd count means one is still open.
    private static func fenceLineCount(_ text: String) -> Int {
        var count = 0
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("```") || line.hasPrefix("~~~") { count += 1 }
        }
        // `split` drops a trailing fence that has no newline after it only when
        // the text ends exactly at the boundary, which the loop above already
        // covers, so nothing further is needed here.
        return count
    }

    private static let codeSpans = try! NSRegularExpression(
        pattern: "```[\\s\\S]*?```|~~~[\\s\\S]*?~~~|`[^`\\n]+`"
    )

    /// Everything up to and including the last closed code span, and the prose
    /// after it.
    private static func splitTrailingProse(_ text: String) -> (head: String, tail: String) {
        let range = NSRange(text.startIndex..., in: text)
        guard let last = codeSpans.matches(in: text, range: range).last,
              let end = Range(last.range, in: text)?.upperBound
        else { return ("", text) }
        return (String(text[text.startIndex..<end]), String(text[end...]))
    }

    private static func removingLast(_ needle: String, in text: String) -> String {
        guard let found = text.range(of: needle, options: .backwards) else { return text }
        return text.replacingCharacters(in: found, with: "")
    }

    private static let completeLink = try! NSRegularExpression(pattern: "^\\[[^\\]\\n]*\\]\\([^)\\n]*\\)")
    private static let partialLink = try! NSRegularExpression(pattern: "^\\[([^\\]\\n]*)(?:\\]\\(?[^)\\n]*)?$")

    private static func maskPartialLink(_ text: String) -> String {
        guard let open = text.range(of: "[", options: .backwards) else { return text }
        let rest = String(text[open.lowerBound...])
        guard !rest.isEmpty else { return text }

        let restRange = NSRange(rest.startIndex..., in: rest)
        // Already a whole `[label](url)`: nothing to hide.
        if completeLink.firstMatch(in: rest, range: restRange) != nil { return text }
        guard let match = partialLink.firstMatch(in: rest, range: restRange),
              let label = Range(match.range(at: 1), in: rest)
        else { return text }

        let isImage = open.lowerBound > text.startIndex
            && text[text.index(before: open.lowerBound)] == "!"
        let cut = isImage ? text.index(before: open.lowerBound) : open.lowerBound
        return String(text[text.startIndex..<cut]) + (isImage ? "" : String(rest[label]))
    }
}
