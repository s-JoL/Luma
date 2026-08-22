import SwiftUI

/// Collapsed by default, showing the model's own `intent` sentence as the status
/// line. The first argument of every tool call is a sentence the model wrote
/// about what it is doing, and it is better than any status string the app could
/// invent.
///
/// Content, not navigation, so no glass here — a card with a hairline. What it
/// does get is a tinted glyph that carries the state, because a reader scanning
/// a long agent turn reads the colour of the icons before any of the words.
struct ToolBlockView: View {
    let tool: ToolPart
    @State private var expanded = false
    @State private var showingAll = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let resultCap = 4000
    /// Head-anchored, unlike a command's output: a tool result is a document and
    /// its first lines are the ones that say what it is.
    private static let panelHeight: CGFloat = 240

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if expanded { detail }
        }
        .contentCard(tool.isError ? .danger : .raised)
        .contextMenu {
            Button {
                UIPasteboard.general.string = tool.result
            } label: {
                Label("复制结果", systemImage: "doc.on.doc")
            }
        }
    }

    private var header: some View {
        Button {
            withAnimation(reduceMotion ? nil : Motion.quick) { expanded.toggle() }
        } label: {
            HStack(spacing: Space.md) {
                glyph

                VStack(alignment: .leading, spacing: 1) {
                    Text(displayName)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Color.fg)
                        .lineLimit(1)
                    if !intent.isEmpty {
                        Text(intent)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }

                Spacer(minLength: Space.sm)

                if hasDetail {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Color.mutedFg)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
            }
            .padding(.horizontal, Space.md)
            .padding(.vertical, Space.sm)
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!hasDetail)
        .accessibilityLabel("工具 \(displayName)，\(statusLabel)")
        .accessibilityHint(hasDetail ? "展开查看参数与结果" : "")
    }

    /// The state lives in the glyph rather than a badge on the far side: one
    /// thing to look at, and it is the thing the eye lands on first.
    private var glyph: some View {
        ZStack {
            Circle()
                .fill(tone.opacity(0.14))
                .frame(width: 28, height: 28)
            if tool.running {
                // One repeating animation handed to the compositor, rather than
                // a loop that wakes up to add another 360° every 0.9s. Core
                // Animation then spins it without the app being involved, and
                // without a state mutation per revolution in a row that is
                // already being rebuilt by the stream.
                Circle()
                    .trim(from: 0, to: 0.7)
                    .stroke(tone, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                    .frame(width: 28, height: 28)
                    .rotationEffect(.degrees(spinning ? 360 : 0))
                    .animation(
                        reduceMotion ? nil : .linear(duration: 0.9).repeatForever(autoreverses: false),
                        value: spinning
                    )
                    .onAppear { spinning = true }
            }
            Image(systemName: symbol)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(tone)
        }
    }

    @State private var spinning = false

    private var symbol: String {
        if tool.isError { return Symbols.failed }
        return Symbols.tool(tool.name)
    }

    private var tone: Color {
        if tool.isError { return .danger }
        if tool.running { return .brand }
        return .ok
    }

    private var statusLabel: String {
        tool.running ? "进行中" : (tool.isError ? "失败" : "已完成")
    }

    /// `web_search` reads better than `web_search` in a sentence of Chinese, but
    /// renaming tools in the client would make the transcript disagree with the
    /// logs, so the raw name stays and only the casing is softened.
    private var displayName: String { tool.name }

    private var hasDetail: Bool { !argumentText.isEmpty || !tool.result.isEmpty }

    private var detail: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Rectangle().fill(Color.hairline).frame(height: 1)

            if !argumentText.isEmpty {
                panel(label: "参数", text: argumentText)
            }
            if !tool.result.isEmpty {
                panel(label: tool.isError ? "错误" : "结果", text: cappedResult)
                if !showingAll {
                    Button("展开全部（共 \(tool.result.count) 字）") { showingAll = true }
                        .font(.caption)
                        .foregroundStyle(Color.brand)
                }
            }
        }
        .padding(Space.md)
        .transition(.opacity)
    }

    /// Horizontal scroll rather than wrapping, and a height cap rather than
    /// whatever the tool happened to return. An unbounded result turns one turn
    /// into several screens of monospaced text that the reader has to scroll past
    /// to reach the answer it was gathered for — and while a run is live, a
    /// result that arrives at full height shoves everything below it down the
    /// screen at once.
    private func panel(label: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Color.mutedFg)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.code)
                    .foregroundStyle(Color.fg)
                    .textSelection(.enabled)
                    .padding(Space.md)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(maxHeight: showingAll ? nil : Self.panelHeight, alignment: .top)
            .clipped()
            .background(Color.mutedFill, in: RoundedRectangle(cornerRadius: Radius.md))
        }
    }

    private var cappedResult: String {
        guard !showingAll, tool.result.count > Self.resultCap else { return tool.result }
        return String(tool.result.prefix(Self.resultCap)) + "\n…"
    }

    /// The model writes `intent` as the first argument of every call.
    private var intent: String {
        tool.args["intent"]?.stringValue ?? ""
    }

    private var argumentText: String {
        guard case .object(var fields) = tool.args else { return tool.args.prettyPrinted }
        // The intent is already the header's status line; repeating it in the
        // argument dump is noise.
        fields.removeValue(forKey: "intent")
        return fields.isEmpty ? "" : JSONValue.object(fields).prettyPrinted
    }
}
