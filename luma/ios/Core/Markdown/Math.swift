import Foundation

/// Finding the formulas in an answer.
///
/// A port of the math half of `src/web/markdown.tsx`, and it has to stay one: a
/// formula that typesets in the browser and shows as `$\frac{a}{b}$` on the phone
/// is the same answer rendered two different ways, which is the thing both
/// clients exist to avoid.
///
/// Three rules, in the order the web applies them.
enum Math {
    /// Most models write display math as `\[…\]` and inline math as `\(…\)`.
    /// Markdown treats a backslash before a bracket as an escape, so an
    /// untouched formula arrives as bare parentheses — rewriting to dollars is
    /// what makes it a formula at all. Code spans keep their backslashes.
    static func normalise(_ text: String) -> String {
        guard text.contains("\\(") || text.contains("\\[") else { return text }
        return ProseFixups.outsideCode(text) { chunk in
            // Rewritten by hand rather than with a replacement template: `$` is
            // the template language's own group-reference sigil, and the whole
            // job here is to emit dollars.
            rewrite(inline, in: rewrite(display, in: chunk, delimiter: "$$"), delimiter: "$")
        }
    }

    private static func rewrite(
        _ expression: NSRegularExpression, in text: String, delimiter: String
    ) -> String {
        let source = text as NSString
        let matches = expression.matches(
            in: text, range: NSRange(location: 0, length: source.length)
        )
        guard !matches.isEmpty else { return text }

        var output = ""
        var cursor = 0
        for match in matches {
            output += source.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            output += delimiter + source.substring(with: match.range(at: 1)) + delimiter
            cursor = match.range.location + match.range.length
        }
        return output + source.substring(from: cursor)
    }

    /// A backslash command, superscript, subscript, brace or relation.
    private static let signal = try! NSRegularExpression(pattern: "[\\\\^_{}=]")

    /// Not every `$…$` is a formula: "costs $5 to $10" is prose, and treating it
    /// as math silently eats the sentence between the dollars. Only spans that
    /// carry a math signal — or that are a short unbroken symbol run like `$x$` —
    /// are kept.
    static func isFormula(_ body: String) -> Bool {
        guard !body.isEmpty else { return false }
        let range = NSRange(body.startIndex..., in: body)
        if signal.firstMatch(in: body, range: range) != nil { return true }
        return !body.contains(where: \.isWhitespace) && body.count <= 40
    }

    /// Whether it is worth looking any closer. Dollars are the only delimiter
    /// left once `normalise` has run.
    static func looksLikeMath(_ text: String) -> Bool { text.contains("$") }

    // MARK: Splitting a paragraph

    enum Run: Equatable {
        case text(String)
        case math(String)
    }

    /// A paragraph as alternating prose and formulas. Returns a single `.text`
    /// run when there is no math in it, so a caller can cheaply tell the two
    /// cases apart.
    static func runs(in text: String) -> [Run] {
        guard looksLikeMath(text) else { return [.text(text)] }

        var runs: [Run] = []
        var prose = ""
        var rest = Substring(text)

        while let open = rest.firstIndex(of: "$") {
            // `$$` inside a paragraph is display math the block splitter did not
            // separate — treated as one formula rather than as two empty ones.
            let afterOpen = rest.index(after: open)
            let isDouble = afterOpen < rest.endIndex && rest[afterOpen] == "$"
            let delimiter = isDouble ? "$$" : "$"
            let bodyStart = isDouble ? rest.index(after: afterOpen) : afterOpen

            guard bodyStart <= rest.endIndex,
                  let close = rest.range(of: delimiter, range: bodyStart..<rest.endIndex)
            else {
                break
            }

            let body = String(rest[bodyStart..<close.lowerBound])
            guard isDouble || isFormula(body) else {
                // Currency, or something else that only looked like math. The
                // dollar and its body stay in the prose.
                prose += rest[rest.startIndex...open]
                rest = rest[afterOpen...]
                continue
            }

            prose += rest[rest.startIndex..<open]
            if !prose.isEmpty {
                runs.append(.text(prose))
                prose = ""
            }
            runs.append(.math(body.trimmingCharacters(in: .whitespacesAndNewlines)))
            rest = rest[close.upperBound...]
        }

        prose += rest
        if !prose.isEmpty { runs.append(.text(prose)) }
        return runs.isEmpty ? [.text(text)] : runs
    }

    /// Whether this paragraph has any formula in it at all, which is what decides
    /// whether it takes the inline-math renderer instead of the Markdown one.
    static func hasFormula(in text: String) -> Bool {
        runs(in: text).contains { if case .math = $0 { true } else { false } }
    }

    /// The whole block is one display formula — `$$…$$` on its own, which is how
    /// a model writes an equation that deserves its own line.
    static func displayBody(of block: String) -> String? {
        let trimmed = block.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("$$"), trimmed.hasSuffix("$$"), trimmed.count > 4 else { return nil }
        let body = trimmed.dropFirst(2).dropLast(2)
        // A second `$$` inside would mean two formulas, not one block.
        guard !body.contains("$$") else { return nil }
        return body.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static let display = try! NSRegularExpression(pattern: "\\\\\\[([\\s\\S]+?)\\\\\\]")
    private static let inline = try! NSRegularExpression(pattern: "\\\\\\(([\\s\\S]+?)\\\\\\)")
}
