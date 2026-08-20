import SwiftUI

/// A fenced block with a header: the language on the left, copy on the right.
///
/// No syntax highlighting, deliberately — the web client has none either, and
/// adding it to one client would split the two. What the header buys instead is
/// the thing people actually reach for on a phone, where selecting a long run of
/// monospaced text by hand is miserable.
struct CodeBlockView: View {
    let language: String?
    let content: String

    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            ScrollView(.horizontal, showsIndicators: false) {
                Text(content)
                    .font(.code)
                    .foregroundStyle(Color.fg)
                    .textSelection(.enabled)
                    .padding(.horizontal, Space.md)
                    .padding(.vertical, Space.md)
            }
        }
        .background(Color.mutedFill, in: RoundedRectangle(cornerRadius: Radius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.lg)
                .strokeBorder(Color.hairline.opacity(0.7), lineWidth: 1)
        )
    }

    private var header: some View {
        HStack(spacing: Space.sm) {
            Text(label)
                .font(.caption2.weight(.medium))
                .foregroundStyle(Color.mutedFg)
                .textCase(.lowercase)

            Spacer(minLength: Space.sm)

            Button {
                UIPasteboard.general.string = content
                withAnimation(Motion.quick) { copied = true }
                Task {
                    try? await Task.sleep(for: .seconds(1.4))
                    withAnimation(Motion.quick) { copied = false }
                }
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 10, weight: .semibold))
                    Text(copied ? "已复制" : "复制")
                        .font(.caption2.weight(.medium))
                }
                .foregroundStyle(copied ? Color.ok : Color.mutedFg)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(copied ? "已复制代码" : "复制代码")
        }
        .padding(.horizontal, Space.md)
        .frame(height: 30)
        .background(Color.secondaryFill.opacity(0.5))
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.hairline.opacity(0.7)).frame(height: 1)
        }
    }

    private var label: String {
        let named = (language ?? "").trimmingCharacters(in: .whitespaces)
        return named.isEmpty ? "代码" : named
    }
}
