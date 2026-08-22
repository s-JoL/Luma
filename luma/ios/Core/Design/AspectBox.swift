import SwiftUI

/// A frame the right size for a picture that has not arrived yet.
///
/// The most load-bearing component in a generation app, and the reason is
/// arithmetic: a render is requested at a known aspect ratio, so the app knows
/// exactly how much room it will need *before* it asks for it. Reserving that
/// room means the transcript and the gallery never reflow when bytes land — and
/// reflow during scrolling is most of what "卡顿" turns out to be.
///
/// The ratio comes from whichever source knows first: the generation request,
/// the gallery row's stored dimensions, the provenance reply, or — for a picture
/// the app has only an id for — what `ImageLoader` remembers from last time.
struct AspectBox<Content: View>: View {
    /// Width ÷ height.
    let ratio: Double
    var cornerRadius: CGFloat = Radius.xl
    @ViewBuilder var content: Content

    var body: some View {
        Color.clear
            .aspectRatio(ratio > 0 ? ratio : 1, contentMode: .fit)
            .overlay {
                content
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .clipped()
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }
}

/// A picture that is still being made.
///
/// Occupies exactly the space the finished render will, so the result appears in
/// place rather than pushing the page around. The shimmer is a masked gradient
/// rather than an animated blur or a spinner: it is one compositor-side layer,
/// and it says "working" without implying a stall.
struct ProgressTile: View {
    let ratio: Double
    var progress: Double?
    var note: String?
    /// Some backends stream a partially denoised frame. When one is available it
    /// is far better than any placeholder — the reader watches the picture
    /// arrive instead of watching a bar.
    var preview: ImageId?

    var body: some View {
        AspectBox(ratio: ratio) {
            ZStack {
                if let preview {
                    AuthedImage(imageId: preview, width: 640, contentMode: .fill)
                        .opacity(0.85)
                } else {
                    Color.mutedFill.shimmering()
                }

                VStack(spacing: Space.sm) {
                    if let progress {
                        Text("\(Int(progress * 100))%")
                            .font(.title3.monospacedDigit().weight(.medium))
                            .foregroundStyle(Color.fg)
                    } else {
                        Spinner()
                    }
                    if let note, !note.isEmpty {
                        Text(note)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .padding(Space.sm)
                .background(.ultraThinMaterial, in: Capsule())
            }
        }
        .overlay(
            RoundedRectangle(cornerRadius: Radius.xl, style: .continuous)
                .strokeBorder(Color.hairline, lineWidth: 1)
        )
        .accessibilityLabel(progress.map { "生成中 \(Int($0 * 100))%" } ?? "生成中")
    }
}

/// A value the reader can change, shown as the value itself.
///
/// The studio used to be a form: a column of labelled rows, most of which nobody
/// touches. A chip row says what the settings *are* — `1024×1024`, `28 步`,
/// `cfg 4.5` — in the space of one line, and tapping one opens a sheet for that
/// single parameter. Nobody opens "参数"; they tap the number they want to
/// change. It doubles as the only discovery surface that is ever needed, because
/// everything adjustable is visible.
struct ParamChip: View {
    let label: String
    let value: String
    var isPlaceholder = false

    var body: some View {
        HStack(spacing: Space.xs) {
            Text(label)
                .foregroundStyle(.secondary)
            Text(value)
                .foregroundStyle(isPlaceholder ? Color.mutedFg : Color.fg)
                .monospaced()
        }
        .font(.caption)
        .lineLimit(1)
        .padding(.horizontal, Space.sm)
        .frame(height: 30)
        .background(Color.secondaryFill, in: Capsule())
        .overlay(Capsule().strokeBorder(Color.hairline, lineWidth: 1))
    }
}
