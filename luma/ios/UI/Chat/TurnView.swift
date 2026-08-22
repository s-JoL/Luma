import SwiftUI

/// One turn. `Equatable` on the parts is what keeps a delta from re-rendering
/// every turn on screen — without it a 200-turn transcript drops frames on an
/// A15.
struct TurnView: View, Equatable {
    let turn: Turn
    let citations: CitationIndex
    let isStreaming: Bool
    /// The reader is rewriting this turn, so the bubble is an editor instead.
    var isEditing = false
    var onImage: ((ImageId) -> Void)?
    var onVideo: ((PlayingVideo) -> Void)?
    var onDocument: ((OpenedDocument) -> Void)?
    var onApproval: ((Approval, Bool) -> Void)?
    var onRegenerate: ((Turn) -> Void)?
    var onEdit: ((Turn) -> Void)?
    var onCancelEdit: (() -> Void)?
    var onSubmitEdit: ((Turn, String) -> Void)?

    nonisolated static func == (lhs: TurnView, rhs: TurnView) -> Bool {
        lhs.turn == rhs.turn
            && lhs.isStreaming == rhs.isStreaming
            && lhs.isEditing == rhs.isEditing
            && lhs.citations == rhs.citations
    }

    var body: some View {
        RenderLog.tick(isStreaming ? "TurnView.live" : "TurnView.settled")
        return content.contextMenu { actions }
    }

    @ViewBuilder
    private var content: some View {
        switch turn.role {
        case .user: userTurn
        case .assistant: assistantTurn
        }
    }

    /// Long press on a turn. Copy strips the citation markers, so pasted text is
    /// clean rather than carrying private-use codepoints into someone's notes.
    @ViewBuilder
    private var actions: some View {
        let text = turn.plainText
        if !text.isEmpty {
            Button {
                UIPasteboard.general.string = text
                Haptics.success()
            } label: {
                Label("复制", systemImage: "doc.on.doc")
            }
            ShareLink(item: text) {
                Label("分享", systemImage: "square.and.arrow.up")
            }
        }
        if turn.role == .assistant, !turn.isLive, let onRegenerate {
            Button {
                onRegenerate(turn)
            } label: {
                Label("重新生成", systemImage: "arrow.clockwise")
            }
        }
        if turn.role == .user, !isEditing, let onEdit {
            Button {
                onEdit(turn)
            } label: {
                Label("编辑", systemImage: "pencil")
            }
        }
    }

    // MARK: User

    private var userTurn: some View {
        HStack {
            // The editor is a full-width control; the bubble it replaces is not.
            Spacer(minLength: isEditing ? 0 : 40)
            VStack(alignment: .trailing, spacing: Space.sm) {
                ForEach(Array(turn.parts.enumerated()), id: \.offset) { _, part in
                    switch part {
                    case .text(let text):
                        if !isEditing {
                            Text(text)
                                .font(.body)
                                .foregroundStyle(Color.onBrand)
                                .textSelection(.enabled)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 9)
                                .background(LinearGradient.brandFill, in: BubbleShape())
                                .shadow(color: Color.brand.opacity(0.22), radius: 8, y: 3)
                        }
                    case .image(let id):
                        AuthedImage(imageId: id, width: 640)
                            .frame(maxWidth: 200, maxHeight: 200)
                            .clipShape(RoundedRectangle(cornerRadius: Radius.lg))
                            .onTapGesture { onImage?(id) }
                    case .video(let id, let poster, _):
                        VideoPoster(poster: poster, width: 640)
                            .frame(maxWidth: 200, maxHeight: 200)
                            .clipShape(RoundedRectangle(cornerRadius: Radius.lg))
                            .contentShape(Rectangle())
                            .onTapGesture { onVideo?(PlayingVideo(id.raw, poster: poster)) }
                    case .file(let id, let name, let bytes):
                        DocumentChip(name: name, bytes: bytes) {
                            onDocument?(OpenedDocument(id.raw, name: name))
                        }
                    default:
                        EmptyView()
                    }
                }
                if isEditing {
                    MessageEditor(
                        text: turn.plainText,
                        cancel: { onCancelEdit?() },
                        submit: { onSubmitEdit?(turn, $0) }
                    )
                }
            }
        }
        .accessibilityElement(children: isEditing ? .contain : .combine)
        .accessibilityLabel(isEditing ? "编辑这条消息" : "我：\(turn.plainText)")
    }

    // MARK: Assistant

    /// No bubble: an answer with code, a table and a picture inside a chat bubble
    /// is a worse read, and it wastes 15% of a phone's width on the content
    /// people actually came for.
    private var assistantTurn: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            ForEach(Array(turn.parts.enumerated()), id: \.offset) { index, part in
                partView(part, at: index, isLast: index == turn.parts.count - 1)
            }
            if let error = turn.error {
                ErrorCard(
                    title: FailureKind(runError: error).title,
                    message: error,
                    // A settled turn that failed is regenerated, not continued:
                    // the answer it holds is the failure, and continuing would
                    // append to it rather than replace it.
                    actions: onRegenerate.map { regenerate in
                        [.init("重新生成", systemImage: "arrow.clockwise") { regenerate(turn) }]
                    } ?? []
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func partView(_ part: Part, at index: Int, isLast: Bool) -> some View {
        switch part {
        case .text(let text):
            prose(text, at: index, isTail: isLast)
        case .thinking(let text):
            ThinkingBlock(text: text, isStreaming: isStreaming)
        case .image(let id):
            TranscriptPicture(imageId: id) { onImage?(id) }
        case .video(let id, let poster, _):
            VideoPoster(poster: poster)
                .frame(maxHeight: 600)
                .clipShape(RoundedRectangle(cornerRadius: Radius.lg))
                .contentShape(Rectangle())
                .onTapGesture { onVideo?(PlayingVideo(id.raw, poster: poster)) }
        case .file(let id, let name, let bytes):
            DocumentChip(name: name, bytes: bytes) {
                onDocument?(OpenedDocument(id.raw, name: name))
            }
        case .tool(let tool):
            ToolBlockView(tool: tool)
        case .approval(let approval):
            ApprovalCardView(approval: approval) { approved in
                onApproval?(approval, approved)
            }
        case .job(let job):
            JobRow(job: job)
        }
    }

    /// Only the final text part of a streaming turn can hold a half-written
    /// delimiter, and only its tail block is re-parsed per frame.
    ///
    /// The settled side is a *list* of blocks rather than one document. That is
    /// what makes a completed paragraph cost one paragraph: rendered as a single
    /// document it re-parsed the whole answer from the top every time the split
    /// point moved, which is the quadratic that made long answers stutter.
    @ViewBuilder
    private func prose(_ text: String, at index: Int, isTail: Bool) -> some View {
        if isStreaming && isTail {
            // Neither half of the answer is built here. The settled blocks come
            // from a memo keyed on how far the settled prose reaches, and only
            // the tail — one unfinished paragraph — is turned into a string.
            let cut = ProseSplit.cut(text)
            let blocks = MarkdownCache.blocks(
                of: text, upTo: cut, stream: "\(turn.id)#\(turn.generation)#\(index)"
            )
            let tail = String(text[cut...])
            VStack(alignment: .leading, spacing: 0) {
                ProseBlockList(blocks: blocks, citations: citations, onImage: onImage)
                // The caret sits on the last line rather than under the
                // paragraph, so it reads as the writing position it is.
                StreamingText(text: tail, showsCaret: true)
                    .equatable()
                    .padding(.top, blocks.isEmpty || tail.isEmpty ? 0 : ProseBlock.Kind.paragraph.leadingSpace)
            }
        } else {
            MarkdownText(text: text, citations: citations, onImage: onImage).equatable()
        }
    }
}

/// Editing a message is a rewind: sending replaces it and discards everything
/// after it. So the editor takes the bubble's place in the transcript rather
/// than opening a sheet over it — what is about to be thrown away stays visible,
/// in position, while it is rewritten.
private struct MessageEditor: View {
    var cancel: () -> Void
    var submit: (String) -> Void

    @State private var text: String
    @FocusState private var focused: Bool

    init(text: String, cancel: @escaping () -> Void, submit: @escaping (String) -> Void) {
        self.cancel = cancel
        self.submit = submit
        _text = State(initialValue: text)
    }

    private var trimmed: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: Space.sm) {
            TextField("改写这条消息", text: $text, axis: .vertical)
                .font(.body)
                .lineLimit(1...10)
                .focused($focused)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(Color.card, in: RoundedRectangle(cornerRadius: Radius.lg))
                .overlay(
                    RoundedRectangle(cornerRadius: Radius.lg)
                        .strokeBorder(Color.ring.opacity(0.55), lineWidth: 1.5)
                )
                .accessibilityIdentifier("turn.editor")

            HStack(spacing: Space.sm) {
                Button("取消", role: .cancel) { cancel() }
                    .buttonStyle(.bordered)
                Button("发送") { submit(trimmed) }
                    .buttonStyle(.borderedProminent)
                    .disabled(trimmed.isEmpty)
                    .accessibilityIdentifier("turn.editor.send")
            }
            .font(.subheadline)
        }
        .frame(maxWidth: .infinity)
        .onAppear { focused = true }
    }
}

/// The user bubble's tail corner is tightened, matching the web's `rounded-2xl`
/// with one square-ish corner.
private struct BubbleShape: Shape {
    func path(in rect: CGRect) -> Path {
        Path(
            UIBezierPath(
                roundedRect: rect,
                byRoundingCorners: [.topLeft, .topRight, .bottomLeft],
                cornerRadii: CGSize(width: Radius.bubble, height: Radius.bubble)
            ).cgPath
        )
    }
}

/// The model's reasoning, in a box whose height does not depend on how much of it
/// has arrived.
///
/// It used to expand while thinking was the only thing in the turn and collapse
/// itself the moment the first text delta landed. Both halves were wrong. The
/// collapse yanked the answer up the screen mid-stream, and before that the box
/// grew with every reasoning token — so the row kept changing height underneath a
/// lazy stack that had already measured it, which is the other way a transcript
/// loses its place while streaming.
///
/// While the run is live the box is a fixed window onto the *end* of the
/// reasoning, which is the part worth reading and the part that is still moving.
/// Nothing above it ever shifts. Once the run settles it collapses to a line the
/// reader can open deliberately, and a deliberate expansion is allowed to change
/// the layout because the reader asked for it.
private struct ThinkingBlock: View {
    let text: String
    let isStreaming: Bool

    @State private var expanded = false

    /// Tall enough to read a thought, short enough not to push the answer off
    /// screen. Fixed, so the row is measured once.
    private static let windowHeight: CGFloat = 132
    /// What can fit in that window twice over. Truncating before layout keeps a
    /// long reasoning trace from being laid out in full just to be clipped.
    private static let windowCharacters = 400

    var body: some View {
        if isStreaming {
            live
        } else {
            settled
        }
    }

    private var live: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            label
            Text(tail)
                .font(.callout)
                .foregroundStyle(Color.mutedFg)
                .frame(maxWidth: .infinity, alignment: .leading)
                // Bottom-aligned in a fixed box: new text arrives at the last
                // line and the earlier lines slide up inside the window.
                .frame(height: Self.windowHeight, alignment: .bottom)
                .padding(.horizontal, Space.md)
                .padding(.vertical, Space.sm)
                .clipped()
                .mask(fade)
                .background(Color.mutedFill.opacity(0.4), in: RoundedRectangle(cornerRadius: Radius.lg))
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("正在思考")
    }

    private var settled: some View {
        DisclosureGroup(isExpanded: $expanded) {
            Text(text)
                .font(.callout)
                .foregroundStyle(Color.mutedFg)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Space.md)
                .background(Color.mutedFill.opacity(0.4), in: RoundedRectangle(cornerRadius: Radius.lg))
        } label: {
            label
        }
    }

    private var label: some View {
        Text("思考")
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    /// The window shows the end of the reasoning; the top edge fades rather than
    /// cutting a line in half, which is what says "there is more above" without
    /// a control that promises something to tap.
    private var fade: some View {
        LinearGradient(
            stops: [
                .init(color: .clear, location: 0),
                .init(color: .black, location: 0.22),
                .init(color: .black, location: 1)
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    private var tail: String {
        guard text.count > Self.windowCharacters else { return text }
        return String(text.suffix(Self.windowCharacters))
    }
}

private struct JobRow: View {
    let job: JobRecord

    var body: some View {
        HStack(spacing: Space.md) {
            Spinner(progress: job.progress)
            VStack(alignment: .leading, spacing: 2) {
                Text(job.modelName.isEmpty ? "生成中" : job.modelName)
                    .font(.subheadline.weight(.medium))
                if let note = job.note, !note.isEmpty {
                    Text(note).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if let progress = job.progress {
                Text("\(Int(progress * 100))%")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(Space.md)
        .background(Color.card, in: RoundedRectangle(cornerRadius: Radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(Color.hairline, lineWidth: 1))
    }
}
