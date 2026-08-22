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
///
/// A finished picture settles the same way without waiting for that blank line.
/// `StreamingText` builds a `Text`, which can only show a picture's alt text —
/// prose the answer never wrote, replaced by the picture a moment later. The
/// block renderer draws it straight away instead, which is also when the web
/// client draws it.
enum ProseSplit {
    /// Where the settled prose ends. Returned as an index rather than as two
    /// strings because the streaming caller asks on every published frame, and
    /// building the settled half is the expensive part — it copies the whole
    /// answer so far, twenty times a second, to hand back something it almost
    /// always already has.
    static func cut(_ text: String) -> String.Index {
        // Searched backwards, so it stops at the last blank line rather than
        // walking the answer.
        let block = text.range(of: "\n\n", options: .backwards)?.upperBound ?? text.startIndex

        // A picture can only move the cut if it is *after* the last blank line —
        // one before it is already settled either way. So the search is bounded
        // to the tail, which is one unfinished paragraph rather than the whole
        // answer. Unbounded, this was the single most expensive thing the
        // transcript did per frame: a case-insensitive search that has to scan
        // everything written so far before it can report that the answer, as is
        // true of nearly every answer, contains no generated picture at all.
        guard text[block...].range(of: "image://", options: .caseInsensitive) != nil,
              let picture = InlineImages.endOfLastPicture(in: text)
        else { return block }
        return max(block, picture)
    }

    static func split(_ text: String, streaming: Bool) -> (settled: String, tail: String) {
        guard streaming else { return (text, "") }
        let cut = cut(text)
        return (String(text[..<cut]), String(text[cut...]))
    }
}
