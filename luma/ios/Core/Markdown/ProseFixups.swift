import Foundation

/// Two repairs the web client makes to a parsed tree (`remarkProseFixups` in
/// `src/web/markdown.tsx`) and this one has to make to the source text, because
/// `swift-markdown-ui` owns its parser and offers no hook between parsing and
/// rendering.
///
/// Both were observed breaking, and both are in the PRD's acceptance list.
enum ProseFixups {
    static func apply(_ text: String) -> String {
        outsideCode(text) { chunk in
            separateAdjacentLinks(repairLiteralStrong(chunk))
        }
    }

    // MARK: Bold across a CJK colon

    /// CommonMark refuses to close a `**` run when the character before the
    /// closer is punctuation and the character after it is a letter, so the
    /// extremely common Chinese heading form `**五图卡点：**开门` parses as
    /// literal asterisks.
    ///
    /// The web promotes the leftover text node to `strong` after parsing. Here
    /// the only lever is the source, so a zero-width space is inserted next to
    /// the offending delimiter: `U+200B` is neither Unicode whitespace nor
    /// punctuation to CommonMark, so it makes the run flanking again, and it is
    /// invisible in the rendered text.
    static func repairLiteralStrong(_ text: String) -> String {
        guard text.contains("**") else { return text }

        var output = ""
        var rest = Substring(text)

        while let open = rest.range(of: "**") {
            output += rest[rest.startIndex..<open.lowerBound]
            let afterOpen = open.upperBound

            // A closer must exist, and the body must not be empty or start with
            // whitespace — those are not emphasis in the first place.
            guard let close = rest.range(of: "**", range: afterOpen..<rest.endIndex),
                  afterOpen < close.lowerBound,
                  let firstBody = rest[afterOpen..<close.lowerBound].first,
                  !firstBody.isWhitespace,
                  let lastBody = rest[afterOpen..<close.lowerBound].last
            else {
                output += rest[open.lowerBound...]
                return output
            }

            let before = rest[rest.startIndex..<open.lowerBound].last
            let after = close.upperBound < rest.endIndex ? rest[close.upperBound] : nil

            // The opener needs to be left-flanking, the closer right-flanking.
            let openerBlocked = isPunctuation(firstBody) && (before.map(isLetterish) ?? false)
            let closerBlocked = isPunctuation(lastBody) && (after.map(isLetterish) ?? false)

            output += "**"
            if openerBlocked { output += "\u{200B}" }
            output += rest[afterOpen..<close.lowerBound]
            if closerBlocked { output += "\u{200B}" }
            output += "**"

            rest = rest[close.upperBound...]
        }

        return output + rest
    }

    /// "A letter" in the flanking sense: anything that is neither whitespace nor
    /// punctuation, which is what makes a delimiter fail to close.
    private static func isLetterish(_ character: Character) -> Bool {
        !character.isWhitespace && !isPunctuation(character)
    }

    private static func isPunctuation(_ character: Character) -> Bool {
        character.isPunctuation || character.isSymbol
    }

    // MARK: Adjacent links

    /// Grouped citations arrive as `[youtube.com](…)[bilibili.com](…)` with
    /// nothing between them, which renders as one run-on word. A thin space is
    /// the separator the web inserts.
    static func separateAdjacentLinks(_ text: String) -> String {
        guard text.contains(")[") else { return text }
        let range = NSRange(text.startIndex..., in: text)
        return adjacentLinks.stringByReplacingMatches(
            in: text, range: range, withTemplate: "$1\u{2009}$2"
        )
    }

    private static let adjacentLinks = try! NSRegularExpression(
        pattern: "(\\]\\([^)\\n]*\\))(\\!?\\[)"
    )

    // MARK: Leaving code alone

    private static let codeSpans = try! NSRegularExpression(
        pattern: "```[\\s\\S]*?```|~~~[\\s\\S]*?~~~|`[^`\\n]*`"
    )

    /// Applies a rewrite to prose only, leaving fenced blocks and code spans
    /// exactly as the model wrote them.
    static func outsideCode(_ text: String, _ rewrite: (String) -> String) -> String {
        let source = text as NSString
        let matches = codeSpans.matches(
            in: text, range: NSRange(location: 0, length: source.length)
        )
        guard !matches.isEmpty else { return rewrite(text) }

        var output = ""
        var cursor = 0
        for match in matches {
            let gap = NSRange(location: cursor, length: match.range.location - cursor)
            output += rewrite(source.substring(with: gap))
            output += source.substring(with: match.range)
            cursor = match.range.location + match.range.length
        }
        output += rewrite(source.substring(from: cursor))
        return output
    }
}
