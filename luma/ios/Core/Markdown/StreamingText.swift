import SwiftUI

/// The tail of a streaming answer. Masks the half-written delimiter (`Mask`) and
/// then builds an `AttributedString` with inline-only parsing: emphasis, code and
/// links, no block tree and no layout pass. That is cheap enough to run on every
/// published frame, which the full block renderer is not.
///
/// The split is what keeps a long answer smooth. Settled blocks go through
/// `MarkdownText` once and are never re-parsed; only this one runs at 20 Hz.
struct StreamingText: View, Equatable {
    let text: String
    let citations: [String: Citation]
    var showsCaret = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var caretOn = true

    /// `nonisolated` because `View` is main-actor isolated in Swift 6 and
    /// SwiftUI compares views off the main actor.
    nonisolated static func == (lhs: StreamingText, rhs: StreamingText) -> Bool {
        lhs.text == rhs.text && lhs.showsCaret == rhs.showsCaret
    }

    var body: some View {
        // Concatenated rather than overlaid, so the caret wraps with the text and
        // sits at the writing position instead of on a line of its own.
        (Text(rendered) + caret)
            .font(.body)
            .foregroundStyle(Color.fg)
            .proseLeading()
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .task(id: showsCaret) {
                guard showsCaret, !reduceMotion else { return }
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(560))
                    caretOn.toggle()
                }
            }
    }

    private var caret: Text {
        guard showsCaret else { return Text(verbatim: "") }
        return Text(verbatim: "\u{2006}▍")
            .foregroundColor(Color.brand.opacity(caretOn || reduceMotion ? 1 : 0.15))
    }

    private var rendered: AttributedString {
        let masked = ProseFixups.apply(Mask.incompleteTail(Citations.stripMarkers(text)))
        // `inlineOnlyPreservingWhitespace` keeps the newlines a partially
        // written list or paragraph already has, so the tail does not reflow
        // when the block renderer takes over on settle.
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: false,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        return (try? AttributedString(markdown: masked, options: options)) ?? AttributedString(masked)
    }
}

/// A turn's prose split into the part that will not change again and the tail
/// that still might. Everything up to the last blank line has settled: Markdown
/// blocks are separated by one, so a block before it can no longer be extended.
enum ProseSplit {
    static func split(_ text: String, streaming: Bool) -> (settled: String, tail: String) {
        guard streaming else { return (text, "") }
        guard let breakRange = text.range(of: "\n\n", options: .backwards) else {
            return ("", text)
        }
        return (String(text[..<breakRange.upperBound]), String(text[breakRange.upperBound...]))
    }
}
