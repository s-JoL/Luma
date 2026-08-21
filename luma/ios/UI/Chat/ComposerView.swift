import SwiftUI

struct DraftAttachment: Identifiable, Equatable {
    let id: String
    let name: String
    let mime: String

    var isImage: Bool { mime.hasPrefix("image/") }
}

/// Floats above the transcript on the keyboard, as Liquid Glass rather than an
/// opaque bar: the text scrolling underneath stays faintly visible, which is
/// what makes the composer read as a layer instead of a wall.
///
/// The whole control is one `GlassGroup`, so the field and the send button
/// sample the same region and merge as the button changes shape — glass cannot
/// sample other glass, and two separate surfaces this close would tear.
struct ComposerView: View {
    @Binding var text: String
    @Binding var attachments: [DraftAttachment]
    let isRunning: Bool
    var uploading = false
    let modelName: String?
    let send: () -> Void
    let stop: () -> Void
    var pickModel: (() -> Void)?
    var attach: (() -> Void)?

    @FocusState private var focused: Bool
    @Namespace private var glass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var canSend: Bool {
        !uploading && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        GlassGroup(spacing: 18) {
            VStack(spacing: Space.sm) {
                if !attachments.isEmpty || uploading {
                    chips
                }
                // Return inserts a newline; there is no send-on-return on a touch
                // keyboard, which has no Shift to distinguish the two.
                TextField("说点什么…", text: $text, axis: .vertical)
                    .font(.body)
                    .lineLimit(1...8)
                    .focused($focused)
                    .padding(.horizontal, 6)
                    .padding(.top, attachments.isEmpty ? 6 : 0)
                    .frame(minHeight: 34)
                    .accessibilityIdentifier("composer.text")

                controls
            }
            .padding(.horizontal, Space.md)
            .padding(.vertical, Space.md)
            .floatingGlass(in: .rect(cornerRadius: 26))
            .overlay(
                RoundedRectangle(cornerRadius: 26)
                    .strokeBorder(Color.ring.opacity(focused ? 0.55 : 0), lineWidth: 1.5)
            )
            .animation(reduceMotion ? nil : Motion.quick, value: focused)
        }
        .padding(.horizontal, Space.md)
        .padding(.bottom, Space.sm)
        // ⌘↩ sends and ⇧↩ is an ordinary newline, for an iPad with a keyboard.
        .onKeyPress(keys: [.return]) { press in
            guard press.modifiers.contains(.command), canSend, !isRunning else { return .ignored }
            send()
            return .handled
        }
    }

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Space.sm) {
                if uploading { Spinner() }
                ForEach(attachments) { file in
                    HStack(spacing: Space.xs) {
                        if file.isImage {
                            AuthedImage(imageId: ImageId(file.id), width: 80)
                                .frame(width: 28, height: 28)
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                        } else {
                            Image(systemName: "doc")
                                .font(.caption)
                                .foregroundStyle(Color.mutedFg)
                        }
                        Text(file.name)
                            .font(.caption)
                            .lineLimit(1)
                        Button {
                            attachments.removeAll { $0.id == file.id }
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.caption)
                                .foregroundStyle(Color.mutedFg)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("移除 \(file.name)")
                    }
                    .padding(.leading, 4)
                    .padding(.trailing, 6)
                    .frame(height: 36)
                    .background(Color.secondaryFill, in: Capsule())
                }
            }
        }
    }

    private var controls: some View {
        HStack(spacing: Space.sm) {
            Button {
                attach?()
            } label: {
                Image(systemName: Symbols.attach)
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(Color.mutedFg)
                    .frame(width: 30, height: 30)
                    .contentShape(Rectangle())
            }
            .frame(minWidth: 44, minHeight: 44)
            .disabled(attach == nil || uploading)
            .accessibilityLabel("添加附件")
            .accessibilityIdentifier("composer.attach")

            if let modelName {
                Button {
                    pickModel?()
                } label: {
                    HStack(spacing: 3) {
                        Text(modelName).lineLimit(1)
                        Image(systemName: Symbols.model).font(.system(size: 9, weight: .semibold))
                    }
                    .font(.caption)
                    .foregroundStyle(Color.mutedFg)
                    .padding(.horizontal, Space.sm)
                    .frame(height: 28)
                    .background(Color.secondaryFill.opacity(0.7), in: Capsule())
                }
                .frame(minHeight: 44)
                .accessibilityLabel("切换模型，当前 \(modelName)")
            }

            Spacer(minLength: Space.sm)

            sendButton
        }
        .frame(height: 34)
    }

    /// One button that morphs between send and stop rather than two that swap.
    /// `glassEffectID` is what makes the circle flow between the two states
    /// instead of cross-fading, and it is the single nicest moment in the app.
    private var sendButton: some View {
        Button {
            isRunning ? stop() : send()
        } label: {
            Image(systemName: isRunning ? Symbols.stop : Symbols.send)
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(Color.onBrand)
                .frame(width: 34, height: 34)
                .background(
                    Group {
                        if isRunning {
                            Circle().fill(Color.danger)
                        } else {
                            Circle().fill(LinearGradient.brandFill)
                        }
                    }
                )
                .opacity(!isRunning && !canSend ? 0.35 : 1)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .frame(minWidth: 44, minHeight: 44)
        .disabled(!isRunning && !canSend)
        .glassMorph(id: "composer.action", in: glass)
        .animation(reduceMotion ? nil : Motion.move, value: isRunning)
        .animation(reduceMotion ? nil : Motion.quick, value: canSend)
        .accessibilityLabel(isRunning ? "停止" : "发送")
        .accessibilityIdentifier("composer.send")
    }
}

private extension View {
    /// Participates in the container's morphing, where the OS supports it.
    @ViewBuilder
    func glassMorph(id: String, in namespace: Namespace.ID) -> some View {
        if #available(iOS 26.0, *) {
            glassEffectID(id, in: namespace)
        } else {
            self
        }
    }
}
