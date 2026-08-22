import SwiftUI

/// A GFM pipe table, rendered without anchor preferences.
///
/// This exists because of a main-thread stall found by sampling the app while a
/// transcript containing a table was on screen. `swift-markdown-ui` lays tables
/// out with a `GeometryReader` and one anchor preference per cell, then converts
/// every anchor through the view-transform chain to work out column widths —
/// `TableBounds.init(rowCount:columnCount:anchors:proxy:)`. That runs inside the
/// view graph update, on the main thread, and with a table in each of several
/// dozen turns it pinned the main thread for tens of seconds: XCUITest reported
/// "process main thread busy for 30.0s" and the reader felt it as the transcript
/// locking up.
///
/// A table does not need any of that. Column widths come from `Grid`, which
/// measures its children itself, and the rules are drawn as backgrounds rather
/// than derived from resolved anchors.
struct MarkdownTable: View, Equatable {
    let table: PipeTable

    nonisolated static func == (lhs: MarkdownTable, rhs: MarkdownTable) -> Bool {
        lhs.table == rhs.table
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                ForEach(Array(table.rows.enumerated()), id: \.offset) { index, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { column, cell in
                            Text(MarkdownTable.inline(cell))
                                .font(.body)
                                .fontWeight(index == 0 ? .semibold : .regular)
                                .foregroundStyle(Color.fg)
                                .multilineTextAlignment(table.alignment(for: column))
                                .frame(
                                    maxWidth: .infinity,
                                    alignment: table.frameAlignment(for: column)
                                )
                                .padding(.horizontal, Space.md)
                                .padding(.vertical, Space.sm)
                        }
                    }
                    // A rule under the header carries the weight; the rest are
                    // separators and should barely register. No vertical rules —
                    // columns are already separated by the alignment of what is
                    // in them.
                    .background(alignment: .bottom) {
                        if index < table.rows.count - 1 {
                            Rectangle()
                                .fill(Color.hairline)
                                .frame(height: index == 0 ? 1 : 0.5)
                                .opacity(index == 0 ? 1 : 0.6)
                        }
                    }
                }
            }
            .fixedSize(horizontal: true, vertical: false)
        }
    }

    /// Cells carry inline markup — bold, code, links — but never blocks, so the
    /// cheap inline-only parser is exactly right and costs nothing.
    private static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: false,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}

/// A pipe table as rows of cells, plus what the delimiter row said about
/// alignment.
struct PipeTable: Equatable, Sendable {
    enum Column: Equatable, Sendable { case leading, center, trailing }

    let rows: [[String]]
    let columns: [Column]

    func alignment(for column: Int) -> TextAlignment {
        switch columns.indices.contains(column) ? columns[column] : .leading {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }

    func frameAlignment(for column: Int) -> Alignment {
        switch columns.indices.contains(column) ? columns[column] : .leading {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }

    /// Parses the block if it really is a table. A block that only starts with a
    /// pipe is not one — GFM requires a delimiter row of dashes directly under
    /// the header, and without it the text is a paragraph that happens to
    /// contain pipes.
    init?(_ source: String) {
        let lines = source
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard lines.count >= 2 else { return nil }

        let header = PipeTable.cells(lines[0])
        let delimiters = PipeTable.cells(lines[1])
        guard !header.isEmpty, header.count == delimiters.count else { return nil }

        var columns: [Column] = []
        for delimiter in delimiters {
            let text = delimiter.trimmingCharacters(in: .whitespaces)
            guard text.count >= 3 || text.allSatisfy({ $0 == "-" || $0 == ":" }),
                  text.contains("-"),
                  text.allSatisfy({ $0 == "-" || $0 == ":" })
            else { return nil }
            let left = text.hasPrefix(":")
            let right = text.hasSuffix(":")
            columns.append(left && right ? .center : (right ? .trailing : .leading))
        }

        var rows = [header]
        for line in lines.dropFirst(2) {
            var cells = PipeTable.cells(line)
            // GFM pads or truncates a row to the header's width rather than
            // rejecting it.
            while cells.count < header.count { cells.append("") }
            rows.append(Array(cells.prefix(header.count)))
        }

        self.rows = rows
        self.columns = columns
    }

    /// Splits on unescaped pipes, dropping the optional leading and trailing
    /// ones. `\|` inside a cell is a literal pipe and must not split it.
    private static func cells(_ line: String) -> [String] {
        var cells: [String] = []
        var current = ""
        var escaped = false
        for character in line {
            if escaped {
                current.append(character)
                escaped = false
            } else if character == "\\" {
                escaped = true
                current.append(character)
            } else if character == "|" {
                cells.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
            } else {
                current.append(character)
            }
        }
        cells.append(current.trimmingCharacters(in: .whitespaces))

        if cells.first?.isEmpty == true { cells.removeFirst() }
        if cells.last?.isEmpty == true { cells.removeLast() }
        return cells
    }
}
