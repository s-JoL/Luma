import Foundation

/// A generated picture has to lay out like a picture wherever the model chose to
/// put it. `swift-markdown-ui` only sends an image through `ImageProvider` when
/// that image is a paragraph on its own; anywhere inside a line of prose it
/// becomes a `Text` attachment instead, which cannot be sized to the column and
/// cannot be tapped. The web client has no such split — an `<img>` lays out the
/// same wherever it sits — so the source is rewritten here to give every
/// `image://` reference the paragraph it needs, in the place it already
/// occupies. That keeps both clients showing the same answer.
///
/// The neighbouring blank line is as load-bearing as the line break: two lines
/// with no blank between them are one paragraph, so a picture written under its
/// caption is still mixed into prose as far as the parser is concerned.
enum InlineImages {
    /// `![alt](image://img_…)` as the prompt asks the model to write it. The
    /// same reference used as a link rather than an image is deliberately not
    /// matched: that one is text the reader taps, not a picture.
    private static let reference = try! NSRegularExpression(
        pattern: "!\\[[^\\]\\n]*\\]\\(image://img_[0-9a-f]{32}\\)", options: [.caseInsensitive]
    )

    static func ownParagraph(_ text: String) -> String {
        guard text.range(of: "image://", options: [.caseInsensitive]) != nil else { return text }

        var lines: [String] = []
        var inFence = false
        // Set after a picture is emitted: the next line that carries prose is a
        // new block and needs the separator this container spells as blank.
        var pendingBlank: String?

        for slice in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(slice)
            if isFence(line) {
                inFence.toggle()
                lines.append(line)
                pendingBlank = nil
                continue
            }
            if inFence {
                lines.append(line)
                pendingBlank = nil
                continue
            }

            for piece in pieces(of: line) {
                switch piece {
                case .prose(let prose):
                    if let blank = pendingBlank, !isBlank(prose) { lines.append(blank) }
                    pendingBlank = nil
                    lines.append(prose)
                case .picture(let picture, let blank):
                    if let last = lines.last, !isBlank(last) { lines.append(blank) }
                    lines.append(picture)
                    pendingBlank = blank
                }
            }
        }
        return lines.joined(separator: "\n")
    }

    /// Where the last finished reference ends. A reference with its closing
    /// bracket in place cannot become anything else, so the prose up to there has
    /// settled — except for the two shapes where the bracket is not the end of
    /// the story: a picture being wrapped in a link, and one inside code that is
    /// still open.
    static func endOfLastPicture(in text: String) -> String.Index? {
        let range = NSRange(text.startIndex..., in: text)
        for match in reference.matches(in: text, range: range).reversed() {
            guard let found = Range(match.range, in: text) else { continue }
            if found.lowerBound > text.startIndex, text[text.index(before: found.lowerBound)] == "[" {
                continue
            }
            // An odd number of backticks before it means an unclosed span or
            // fence, where the reference is the text being shown.
            if text[text.startIndex..<found.lowerBound].filter({ $0 == "`" }).count % 2 == 1 {
                continue
            }
            return found.upperBound
        }
        return nil
    }

    // MARK: One line at a time

    private enum Piece {
        case prose(String)
        /// A picture, and how this container writes an empty line around it.
        case picture(String, blank: String)
    }

    private static func pieces(of line: String) -> [Piece] {
        let range = NSRange(line.startIndex..., in: line)
        let found = reference.matches(in: line, range: range)
            .compactMap { Range($0.range, in: line) }
            .filter { !isLinkLabel(line, $0) && !isInCodeSpan(line, $0) }
        guard !found.isEmpty, let shape = Shape(line) else { return [.prose(line)] }

        var pieces: [Piece] = []
        var cursor = line.startIndex
        for match in found {
            let before = String(line[cursor..<match.lowerBound])
            // On the first piece the marker that opened the line is not content:
            // a list item whose text begins with the picture has nothing before
            // it, and emitting one would leave an empty paragraph in the item.
            let content = pieces.isEmpty ? String(before.dropFirst(shape.prefix.count)) : before
            if !isBlank(content) {
                pieces.append(.prose(pieces.isEmpty ? before : shape.continuation + trimmedLeft(before)))
            }
            // The first piece keeps the marker that opened the line, so a
            // picture at the head of a list item stays inside the item instead
            // of ending it.
            let head = pieces.isEmpty ? shape.prefix : shape.continuation
            pieces.append(.picture(head + String(line[match]), blank: shape.blank))
            cursor = match.upperBound
        }
        let after = String(line[cursor...])
        if !isBlank(after) { pieces.append(.prose(shape.continuation + trimmedLeft(after))) }
        return pieces
    }

    /// What kind of block this line opens, in the only two terms the rewrite
    /// needs: what a following line must repeat to stay inside it, and what an
    /// empty line looks like there. A table row has no answer — a cell cannot
    /// hold a paragraph — so those lines are left exactly as written.
    private struct Shape {
        /// The markers the line already carries, kept on the first piece.
        let prefix: String
        /// What a continuation line inside the same block repeats.
        let continuation: String
        /// An empty line here. A blockquote's is not empty: a truly blank line
        /// closes the quote.
        let blank: String

        init?(_ line: String) {
            let indent = line.prefix { $0 == " " || $0 == "\t" }
            let body = line.dropFirst(indent.count)
            if body.hasPrefix("|") { return nil }

            if let quote = Shape.quote.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
               let matched = Range(quote.range, in: line) {
                prefix = String(line[matched])
                continuation = prefix
                blank = InlineImages.trimmedRight(prefix)
                return
            }
            if let item = Shape.listItem.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
               let matched = Range(item.range, in: line) {
                prefix = String(line[matched])
                // Aligned with the item's text, which is what keeps the picture
                // a block of that item rather than a new top-level paragraph.
                continuation = String(repeating: " ", count: prefix.count)
                blank = ""
                return
            }
            if body.hasPrefix("#") {
                // A heading is a single line by definition, so the picture
                // becomes the paragraph that follows it.
                prefix = ""
                continuation = ""
                blank = ""
                return
            }
            prefix = String(indent)
            continuation = prefix
            blank = ""
        }

        private static let quote = try! NSRegularExpression(pattern: "^[ \\t]*(?:>[ \\t]?)+")
        private static let listItem = try! NSRegularExpression(
            pattern: "^[ \\t]*(?:[-*+]|[0-9]{1,9}[.)])[ \\t]+"
        )
    }

    // MARK: Where a rewrite would do harm

    /// A picture that is a link's label belongs to that link and cannot be moved
    /// out of it without breaking both.
    private static func isLinkLabel(_ line: String, _ match: Range<String.Index>) -> Bool {
        guard match.lowerBound > line.startIndex, match.upperBound < line.endIndex else { return false }
        return line[line.index(before: match.lowerBound)] == "[" && line[match.upperBound] == "]"
    }

    /// Inside a code span the reference is the text being shown, not a picture.
    private static func isInCodeSpan(_ line: String, _ match: Range<String.Index>) -> Bool {
        line[line.startIndex..<match.lowerBound].filter { $0 == "`" }.count % 2 == 1
    }

    private static func isFence(_ line: String) -> Bool {
        let body = line.drop { $0 == " " || $0 == "\t" }
        return body.hasPrefix("```") || body.hasPrefix("~~~")
    }

    /// Blank in the sense that matters: nothing a reader would see. A blockquote
    /// marker counts as empty because `>` alone is how that container spells an
    /// empty line.
    private static func isBlank(_ line: String) -> Bool {
        line.allSatisfy { $0 == " " || $0 == "\t" || $0 == ">" }
    }

    private static func trimmedLeft(_ text: String) -> String {
        String(text.drop { $0 == " " || $0 == "\t" })
    }

    private static func trimmedRight(_ text: String) -> String {
        var trimmed = text
        while let last = trimmed.last, last == " " || last == "\t" { trimmed.removeLast() }
        return trimmed
    }
}
