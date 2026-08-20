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
