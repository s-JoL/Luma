import SwiftUI

/// Small, dumb, and matched to the web so both clients read the same.
struct Badge: View {
    enum Tone { case neutral, brand, ok, warn, danger }

    let text: String
    var tone: Tone = .neutral

    var body: some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(colour.opacity(0.12), in: RoundedRectangle(cornerRadius: Radius.sm))
            .foregroundStyle(colour)
    }

    private var colour: Color {
        switch tone {
        case .neutral: .mutedFg
        case .brand: .brand
        case .ok: .ok
        case .warn: .warn
        case .danger: .danger
        }
    }
}

struct Chip: View {
    let label: String
    var count: Int?
    var isSelected = false

    var body: some View {
        HStack(spacing: Space.xs) {
            Text(label)
            if let count { Text("\(count)").foregroundStyle(.secondary) }
        }
        .font(.caption)
        .padding(.horizontal, Space.md)
        .frame(height: 32)
        .background(isSelected ? Color.accentFill : Color.secondaryFill, in: Capsule())
        .foregroundStyle(isSelected ? Color.onAccent : Color.onSecondary)
    }
}

/// A run of text that reads as one thing to VoiceOver and never falls below the
/// 44pt hit target when it is tappable.
struct SectionCard<Content: View>: View {
    var title: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            if let title {
                Text(title.uppercased())
                    .font(.footnote.weight(.medium))
                    .tracking(0.4)
                    .foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: Space.md) { content }
                .padding(Space.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.card, in: RoundedRectangle(cornerRadius: Radius.lg))
                .overlay(
                    RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(Color.hairline, lineWidth: 1)
                )
        }
    }
}

/// Bottom overlay, 4s auto-dismiss, swipe to dismiss. Used for a failed
/// *background* action; a failed run shows inline in the transcript instead.
struct ToastHost: ViewModifier {
    @Binding var toast: Toast?
    @State private var dismissal: Task<Void, Never>?

    func body(content: Content) -> some View {
        content.overlay(alignment: .bottom) {
            if let toast {
                Text(toast.message)
                    .font(.callout)
                    .foregroundStyle(toast.isError ? Color.danger : Color.fg)
                    .padding(.horizontal, Space.lg)
                    .padding(.vertical, Space.md)
                    .frame(maxWidth: 420, alignment: .leading)
                    .background(Color.popover, in: RoundedRectangle(cornerRadius: Radius.lg))
                    .overlay(
                        RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(Color.hairline, lineWidth: 1)
                    )
                    .shadow(color: .black.opacity(0.08), radius: 8, y: 2)
                    .padding(Space.lg)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .onTapGesture { self.toast = nil }
                    .accessibilityAddTraits(.isStaticText)
            }
        }
        .animation(Motion.move, value: toast)
        .onChange(of: toast) { _, value in
            dismissal?.cancel()
            guard value != nil else { return }
            dismissal = Task {
                try? await Task.sleep(for: .seconds(4))
                guard !Task.isCancelled else { return }
                toast = nil
            }
        }
    }
}

extension View {
    func toastHost(_ toast: Binding<Toast?>) -> some View {
        modifier(ToastHost(toast: toast))
    }
}

/// A determinate ring where a percentage is known, a small spinner where it is
/// not. Never a full-screen spinner over content that already exists.
struct Spinner: View {
    var progress: Double?

    var body: some View {
        if let progress {
            ProgressView(value: min(max(progress, 0), 1))
                .progressViewStyle(.circular)
                .controlSize(.small)
        } else {
            ProgressView().controlSize(.small)
        }
    }
}

enum Format {
    /// Rounded on purpose. "大约 1 分钟" is the honest shape of a median over a
    /// handful of past renders; "63.4 秒" claims a precision the number does not
    /// have.
    static func roughly(_ duration: Duration) -> String {
        let seconds = Int(duration.components.seconds)
        if seconds < 20 { return "十几秒" }
        if seconds < 90 { return "\(Int((Double(seconds) / 10).rounded()) * 10) 秒" }
        return "\(Int((Double(seconds) / 60).rounded())) 分钟"
    }

    static func bytes(_ count: Int) -> String {
        let value = Double(count)
        if value < 1024 { return "\(count) B" }
        if value < 1024 * 1024 { return String(format: "%.1f KB", value / 1024) }
        if value < 1024 * 1024 * 1024 { return String(format: "%.1f MB", value / (1024 * 1024)) }
        return String(format: "%.1f GB", value / (1024 * 1024 * 1024))
    }
}

/// A picture in an answer, whichever way it arrived: the part the transcript
/// kept from a tool result, or the `image://` reference the model wrote into its
/// prose. One view for both, because a reader cannot tell those apart and the
/// two must not drift into looking different. Sized like the web's
/// `max-h-150 w-fit rounded-lg border`, and tapping opens the full-size viewer.
struct TranscriptPicture: View {
    let imageId: ImageId
    var onTap: (() -> Void)?

    var body: some View {
        AuthedImage(imageId: imageId, width: 1280)
            .frame(maxHeight: 600)
            .clipShape(RoundedRectangle(cornerRadius: Radius.lg))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(Color.hairline, lineWidth: 1)
            )
            .contentShape(Rectangle())
            .onTapGesture { onTap?() }
    }
}

struct ZoomedImage: Identifiable {
    let id: String
    var imageId: ImageId { ImageId(id) }
    init(_ raw: String) { id = raw }
}

/// Something went wrong, said in the two parts that make a failure actionable:
/// what kind of thing failed, and the one thing that would fix it.
///
/// The transcript used to render a run failure as the server's sentence alone in
/// a red box — "Connection error." with nothing to press. That is accurate and
/// useless: it does not say whether the network, the server or the model is the
/// problem, and it leaves the reader to guess that the fix is to send the same
/// message again. The server's own wording is kept, because it is the only part
/// that knows what actually happened; it is the title and the buttons that are
/// added here.
struct ErrorCard: View {
    let title: String
    let message: String
    var actions: [Action] = []

    struct Action: Identifiable {
        let id = UUID()
        let label: String
        let systemImage: String
        let run: () -> Void

        init(_ label: String, systemImage: String, run: @escaping () -> Void) {
            self.label = label
            self.systemImage = systemImage
            self.run = run
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Label(title, systemImage: Symbols.failed)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.danger)

            if !message.isEmpty {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(Color.fg)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if !actions.isEmpty {
                HStack(spacing: Space.sm) {
                    ForEach(actions) { action in
                        Button(action: action.run) {
                            Label(action.label, systemImage: action.systemImage)
                                .font(.subheadline.weight(.medium))
                                .lineLimit(1)
                                .padding(.horizontal, Space.md)
                                .frame(height: 34)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Color.fg)
                        .background(Color.secondaryFill, in: Capsule())
                    }
                }
                .padding(.top, 2)
            }
        }
        .padding(Space.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentCard(.danger)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(title)。\(message)")
    }
}

/// Which failure this is, from the only evidence a client reliably has.
///
/// Deliberately coarse. The server writes one sentence for people and the app
/// does not try to re-derive it; all this decides is the heading and which
/// buttons make sense, and getting that wrong in the safe direction — offering a
/// retry that was not needed — costs nothing.
enum FailureKind {
    case network
    case model
    case server

    init(runError message: String) {
        let text = message.lowercased()
        if text.contains("connection") || text.contains("timeout") || text.contains("timed out")
            || text.contains("network") || text.contains("econnrefused") {
            self = .network
        } else if text.contains("模型") || text.contains("model") || text.contains("api key")
            || text.contains("quota") || text.contains("rate limit") {
            self = .model
        } else {
            self = .server
        }
    }

    var title: String {
        switch self {
        case .network: "连不上模型服务"
        case .model: "模型没能回答"
        case .server: "这次运行失败了"
        }
    }
}
