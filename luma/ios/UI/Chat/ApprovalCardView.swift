import SwiftUI

/// Inline where the tool block will go, never a sheet or an alert: the reader
/// needs the tool calls above the card to judge what the model is doing, and a
/// modal that covers them turns the decision into a guess.
struct ApprovalCardView: View {
    let approval: Approval
    let decide: (Bool) -> Void

    @State private var submitting = false
    @State private var pulse = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var accent: Color {
        switch approval.status {
        case .pending: .warn
        case .approved: .ok
        case .rejected, .expired: .danger
        }
    }

    private var glyph: String {
        switch approval.action {
        case "delete", "delete_recursive": "trash"
        case "overwrite", "move_overwrite": "square.and.pencil"
        case "shell": "terminal"
        default: "exclamationmark.shield"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            HStack(spacing: Space.md) {
                ZStack {
                    Circle()
                        .fill(accent.opacity(0.14))
                        .frame(width: 30, height: 30)
                    // A pending question breathes. It is the one thing in the app
                    // that blocks work, and a static card in a scrolling
                    // transcript is easy to read past.
                    if approval.status == .pending, !reduceMotion {
                        Circle()
                            .stroke(accent.opacity(0.4), lineWidth: 4)
                            .frame(width: 30, height: 30)
                            .scaleEffect(pulse ? 1.6 : 1)
                            .opacity(pulse ? 0 : 1)
                    }
                    Image(systemName: glyph)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(accent)
                }
                .onAppear {
                    guard approval.status == .pending, !reduceMotion else { return }
                    withAnimation(.easeOut(duration: 1.6).repeatForever(autoreverses: false)) {
                        pulse = true
                    }
                }

                Text(title)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if approval.status != .pending {
                    Badge(text: settledLabel, tone: settledTone)
                }
            }

            // The server writes one sentence naming exactly what will happen.
            // Shown verbatim; the app must not paraphrase it.
            Text(approval.summary)
                .font(.body)
                .foregroundStyle(Color.fg)
                .fixedSize(horizontal: false, vertical: true)

            if !approval.detailRows.isEmpty {
                VStack(alignment: .leading, spacing: Space.xs) {
                    ForEach(approval.detailRows, id: \.key) { row in
                        HStack(alignment: .top, spacing: Space.sm) {
                            Text(row.key)
                                .foregroundStyle(.secondary)
                                .frame(width: 92, alignment: .leading)
                            Text(row.value)
                                .foregroundStyle(Color.fg)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .font(.caption.monospaced())
            }

            if approval.isAnswerable {
                buttons
            }
        }
        .padding(Space.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentCard(approval.status == .pending ? .warning : .raised)
        .opacity(approval.status == .expired ? 0.6 : 1)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("需要确认：\(approval.summary)")
        .accessibilityAddTraits(.isHeader)
    }

    /// Same size and weight, with the destructive one on the left so it is not
    /// the thumb's default. A reject that is harder to hit than an approve is not
    /// a safety control — and there is no "always allow" of any kind, ever.
    private var buttons: some View {
        HStack(spacing: Space.md) {
            Button {
                submit(false)
            } label: {
                Text("拒绝")
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .foregroundStyle(Color.danger)
            }
            .buttonStyle(.bordered)

            Button {
                submit(true)
            } label: {
                Group {
                    if submitting { ProgressView().tint(Color.onBrand) } else { Text("允许") }
                }
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
        }
        .disabled(submitting)
    }

    /// After tapping, both disable and wait: the settled state is whatever the
    /// server says, because a double-tap, a retry and two clients deciding at
    /// once all converge on the row.
    private func submit(_ approved: Bool) {
        guard !submitting else { return }
        submitting = true
        // Distinguishable without looking: approving something destructive
        // should not feel identical to dismissing it.
        approved ? Haptics.warning() : Haptics.tap()
        decide(approved)
    }

    private var title: String {
        switch approval.action {
        case "delete", "delete_recursive": "需要确认：删除文件"
        case "overwrite": "需要确认：覆盖文件"
        case "move_overwrite": "需要确认：移动并覆盖"
        case "shell": "需要确认：执行命令"
        default: "需要确认"
        }
    }

    private var settledLabel: String {
        switch approval.status {
        case .approved: "已允许"
        case .rejected: "已拒绝"
        case .expired: "已过期"
        case .pending: ""
        }
    }

    private var settledTone: Badge.Tone {
        switch approval.status {
        case .approved: .ok
        case .rejected, .expired: .danger
        case .pending: .warn
        }
    }
}
