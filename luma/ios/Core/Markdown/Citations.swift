import Foundation

struct Citation: Sendable, Equatable {
    let label: String
    let url: URL?
    let detail: String?
}

/// Tool output marks sources with `\ue202turn0file1`-style anchors, and models
/// echo them back either as the six literal characters `\ue202` or as the U+E202
/// codepoint itself. Both spellings must resolve to the same source, and the
/// wrapper codepoints must be removed: an unassigned private-use codepoint draws
/// as a tofu box on iOS exactly as it does in a browser.
///
/// A port of the citation half of `src/web/messages.ts` and `markdown.tsx`.
enum Citations {
    /// `\ue202turn0file1`, in either spelling.
    static let anchorPattern = "(?:\\\\ue202|\\x{E202})turn(\\d+)(file|search|news|image|video)(\\d+)"

    /// U+E200/U+E201 bracket a run of sources and U+E203/U+E204 the sentence they
    /// support. They carry no text of their own.
    static let markupPattern = "\\\\ue20[0134]|[\\x{E200}\\x{E201}\\x{E203}\\x{E204}]"

    private static let anchor = try! NSRegularExpression(pattern: anchorPattern, options: [.caseInsensitive])
    private static let markup = try! NSRegularExpression(pattern: markupPattern, options: [.caseInsensitive])
    /// Anything else left in the private use area. A model that invents its own
    /// marker must not put a tofu box on screen.
    private static let privateUse = try! NSRegularExpression(pattern: "[\\x{E000}-\\x{F8FF}]")

    /// Collapses either spelling onto the key `collect` stores.
    static func key(_ anchor: String) -> String {
        var text = anchor
        if let range = text.range(of: "^(?:\\\\ue202|\u{E202})", options: [.regularExpression, .caseInsensitive]) {
            text = "\\ue202" + text[range.upperBound...]
        }
        return text.lowercased()
    }

    /// Drops anchors and wrappers, for 复制 and 分享 so pasted text is clean.
    static func stripMarkers(_ text: String) -> String {
        var output = replacingAll(anchor, in: text, with: "")
        output = replacingAll(markup, in: output, with: "")
        return replacingAll(privateUse, in: output, with: "")
    }

    /// Builds the anchor → source map by re-reading tool output, so citations
    /// keep resolving after a relaunch without persisting a second copy.
    static func collect(from turns: [Turn]) -> [String: Citation] {
        var citations: [String: Citation] = [:]
        for turn in turns {
            for part in turn.parts {
                guard case .tool(let tool) = part, !tool.result.isEmpty else { continue }
                for block in blocks(of: tool.result) {
                    guard let found = firstMatch(anchorLine, in: block, group: 1) else { continue }
                    let file = firstMatch(fileLabel, in: block, group: 1)
                    let url = firstMatch(urlLine, in: block, group: 1)
                    let title = firstMatch(titleLine, in: block, group: 1)
                    let label = file ?? url.map(host(of:)) ?? title ?? "source"
                    citations[key(found)] = Citation(
                        label: label,
                        url: url.flatMap(URL.init(string:)),
                        detail: title ?? file
                    )
                }
            }
        }
        return citations
    }

    /// Tool results list sources as blocks starting on `#` or `File:`.
    private static func blocks(of result: String) -> [String] {
        var blocks: [String] = []
        var current = ""
        for line in result.split(separator: "\n", omittingEmptySubsequences: false) {
            let starts = line.hasPrefix("#") || line.hasPrefix("File:")
            if starts && !current.isEmpty {
                blocks.append(current)
                current = ""
            }
            current += (current.isEmpty ? "" : "\n") + line
        }
        if !current.isEmpty { blocks.append(current) }
        return blocks
    }

    private static let anchorLine = try! NSRegularExpression(
        pattern: "Anchor:\\s*((?:\\\\ue202|\\x{E202})turn\\d+(?:file|search|news|image|video)\\d+)",
        options: [.caseInsensitive]
    )
    private static let fileLabel = try! NSRegularExpression(
        pattern: "Anchor:\\s*(?:\\\\ue202|\\x{E202})turn\\d+file\\d+\\s*\\(([^)]+)\\)",
        options: [.caseInsensitive]
    )
    private static let urlLine = try! NSRegularExpression(
        pattern: "^URL:\\s*(\\S+)$", options: [.anchorsMatchLines]
    )
    private static let titleLine = try! NSRegularExpression(
        pattern: "^#\\s*(?:Search|News)\\s*\\d+:\\s*\"?([^\"\\n]*)\"?",
        options: [.anchorsMatchLines, .caseInsensitive]
    )

    /// Rewrites inline anchors into ordinary Markdown links the renderer turns
    /// into chips. An anchor the tools never produced is dropped rather than
    /// shown raw.
    static func linkify(_ text: String, using citations: [String: Citation]) -> String {
        let source = text as NSString
        var output = ""
        var cursor = 0
        for match in anchor.matches(in: text, range: NSRange(location: 0, length: source.length)) {
            output += source.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            let found = source.substring(with: match.range)
            if let citation = citations[key(found)] {
                let encoded = key(found).addingPercentEncoding(
                    withAllowedCharacters: .alphanumerics
                ) ?? ""
                output += "[\(escaped(citation.label))](\(citeScheme)\(encoded))"
            }
            cursor = match.range.location + match.range.length
        }
        output += source.substring(from: cursor)

        output = replacingAll(markup, in: output, with: "")
        return replacingAll(privateUse, in: output, with: "")
    }

    static let citeScheme = "luma-cite:"

    /// A label carrying a bracket would close the link early.
    private static func escaped(_ label: String) -> String {
        label
            .replacingOccurrences(of: "[", with: "(")
            .replacingOccurrences(of: "]", with: ")")
    }

    private static func replacingAll(
        _ expression: NSRegularExpression, in text: String, with replacement: String
    ) -> String {
        expression.stringByReplacingMatches(
            in: text, range: NSRange(text.startIndex..., in: text), withTemplate: replacement
        )
    }

    private static func firstMatch(
        _ expression: NSRegularExpression, in text: String, group: Int
    ) -> String? {
        let range = NSRange(text.startIndex..., in: text)
        guard let match = expression.firstMatch(in: text, range: range),
              let captured = Range(match.range(at: group), in: text)
        else { return nil }
        return String(text[captured])
    }

    private static func host(of url: String) -> String {
        guard let host = URL(string: url)?.host() else { return url }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }
}
