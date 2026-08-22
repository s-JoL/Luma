import Foundation

/// One renderable unit of a turn's prose.
///
/// Splitting exists because of what streaming costs without it. The transcript
/// hands the settled prefix of an answer to the block renderer, and that prefix
/// grows by a paragraph at a time — so rendering it as one document re-parsed
/// the whole answer from the top on every completed paragraph, on the main
/// thread, while the next tokens were still arriving. That is quadratic in the
/// length of the reply, and it is what a long answer stuttering actually was.
///
/// Split first and the work becomes linear: a new paragraph parses one
/// paragraph, and every block above it is already in `MarkdownCache`.
struct ProseBlock: Identifiable, Equatable, Sendable {
    /// Position in the turn. Blocks are append-only while an answer streams, so
    /// the ordinal is both stable and cheap — which matters, because this is
    /// what `ForEach` diffs on every frame of a run.
    let id: Int
    let source: String
    let kind: Kind

    enum Kind: Sendable, Hashable {
        case paragraph
        case heading(level: Int)
        case list
        case code
        case quote
        case table
        /// A display formula on its own, carrying the LaTeX rather than the
        /// delimiters so the renderer does not have to strip them again.
        case math(String)
    }
}

extension ProseBlock.Kind {
    /// The gap above a block of this kind.
    ///
    /// `swift-markdown-ui` spaces blocks by padding each one's top with the
    /// larger of its own top margin and its predecessor's bottom margin, and
    /// gives the first block none. Every block being its own view now means that
    /// rule never fires — each renderer sees a document of one block — so the
    /// transcript applies the same idea itself, which is also what makes the
    /// reading rhythm a decision here rather than an emergent property of a
    /// theme.
    var leadingSpace: CGFloat {
        switch self {
        case .heading(let level): level <= 2 ? 26 : 20
        case .code, .quote, .table, .math: 16
        case .paragraph, .list: 14
        }
    }
}

enum ProseBlocks {
    /// Every block of `text`, in order.
    ///
    /// The math rewrite happens here rather than in the renderer, because it
    /// changes where the boundaries are: a model writing `\[…\]` across two lines
    /// produces one formula, and only after the delimiters become dollars is that
    /// visible as a single block.
    static func blocks(of text: String) -> [ProseBlock] {
        chunks(of: Math.normalise(text)).enumerated().map { index, source in
            ProseBlock(id: index, source: source, kind: kind(of: source))
        }
    }

    // MARK: Splitting

    /// Blank lines separate blocks in CommonMark, with two exceptions that would
    /// change what the reader sees.
    ///
    /// A fenced code block owns its blank lines. And a loose list, an indented
    /// code block and a blockquote all survive one: splitting `1. a` from `2. b`
    /// renders two lists, and the second starts at 1 again. So chunks are cut on
    /// blank lines and then re-joined wherever the next one continues the
    /// container the last one opened.
    private static func chunks(of text: String) -> [String] {
        guard !text.isEmpty else { return [] }

        var groups: [[Substring]] = []
        var current: [Substring] = []
        var fence: Fence?

        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if let open = fence {
                current.append(line)
                if open.closes(line) { fence = nil }
                continue
            }
            if let opened = Fence(line) {
                fence = opened
                current.append(line)
                continue
            }
            if isBlank(line) {
                if !current.isEmpty {
                    groups.append(current)
                    current = []
                }
                continue
            }
            current.append(line)
        }
        if !current.isEmpty { groups.append(current) }

        var merged: [[Substring]] = []
        for group in groups {
            if let previous = merged.last, continues(previous, with: group) {
                // The blank line that separated them is part of what makes the
                // list loose, so it is put back rather than dropped.
                merged[merged.count - 1].append("")
                merged[merged.count - 1].append(contentsOf: group)
            } else {
                merged.append(group)
            }
        }
        return merged.map { $0.joined(separator: "\n") }
    }

    /// An open fence, and what would close it. Tracked by marker and run length
    /// because a fence is only closed by at least as many of the same character.
    private struct Fence {
        let marker: Character
        let length: Int

        init?(_ line: Substring) {
            let body = line.drop { $0 == " " || $0 == "\t" }
            guard let first = body.first, first == "`" || first == "~" else { return nil }
            let run = body.prefix { $0 == first }
            guard run.count >= 3 else { return nil }
            marker = first
            length = run.count
        }

        func closes(_ line: Substring) -> Bool {
            let body = line.drop { $0 == " " || $0 == "\t" }
            let run = body.prefix { $0 == marker }
            guard run.count >= length else { return false }
            return body.dropFirst(run.count).allSatisfy { $0 == " " || $0 == "\t" }
        }
    }

    /// Whether a chunk belongs to the block the previous one opened. Judged from
    /// the two head lines, which is all a container's shape shows.
    private static func continues(_ previous: [Substring], with next: [Substring]) -> Bool {
        guard let head = previous.first, let start = next.first else { return false }
        if isListItem(head) {
            // Either the next item, or a paragraph indented under the last one.
            return isListItem(start) || indent(of: start) >= 2
        }
        if indent(of: head) >= 4 { return indent(of: start) >= 4 }
        if isQuote(head) { return isQuote(start) }
        return false
    }

    // MARK: Reading a line

    private static func kind(of source: String) -> ProseBlock.Kind {
        if let formula = Math.displayBody(of: source) { return .math(formula) }
        guard let first = source.split(separator: "\n", omittingEmptySubsequences: false).first else {
            return .paragraph
        }
        let body = first.drop { $0 == " " || $0 == "\t" }
        if body.hasPrefix("```") || body.hasPrefix("~~~") { return .code }
        if isListItem(first) { return .list }
        if indent(of: first) >= 4 { return .code }
        if body.hasPrefix(">") { return .quote }
        if body.hasPrefix("|") { return .table }
        if body.hasPrefix("#") {
            let level = body.prefix { $0 == "#" }.count
            if level <= 6, body.dropFirst(level).first == " " { return .heading(level: level) }
        }
        return .paragraph
    }

    private static let listMarker = try! NSRegularExpression(
        pattern: "^[ \\t]*(?:[-*+]|[0-9]{1,9}[.)])[ \\t]+"
    )

    private static func isListItem(_ line: Substring) -> Bool {
        let text = String(line)
        return listMarker.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    private static func isQuote(_ line: Substring) -> Bool {
        line.drop { $0 == " " || $0 == "\t" }.hasPrefix(">")
    }

    private static func isBlank(_ line: Substring) -> Bool {
        line.allSatisfy { $0 == " " || $0 == "\t" }
    }

    /// Tabs count as four, which is what CommonMark does for the purpose of
    /// deciding whether a line is indented code.
    private static func indent(of line: Substring) -> Int {
        var width = 0
        for character in line {
            if character == " " {
                width += 1
            } else if character == "\t" {
                width += 4
            } else {
                break
            }
        }
        return width
    }
}
