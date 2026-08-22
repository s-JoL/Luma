import SwiftUI

/// Full screen, pinch and double-tap to zoom, drag down to dismiss. The drag is
/// the one that matters: it is how every photo viewer on the platform closes, and
/// an image that can only be dismissed by hunting for an X in the corner feels
/// broken on a phone even though nothing is.
struct ImageViewer: View {
    let imageId: ImageId

    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var zoom: CGFloat = 1
    @State private var committedZoom: CGFloat = 1
    @State private var pan: CGSize = .zero
    @State private var committedPan: CGSize = .zero
    @State private var dismissDrag: CGFloat = 0
    @State private var inspecting = false

    private var isZoomed: Bool { committedZoom > 1.01 }

    var body: some View {
        ZStack {
            Color.black
                .opacity(backdropOpacity)
                .ignoresSafeArea()

            AuthedImage(imageId: imageId, width: 1280)
                .scaledToFit()
                .scaleEffect(zoom)
                .offset(x: pan.width, y: pan.height + dismissDrag)
                .gesture(magnify)
                .simultaneousGesture(drag)
                .onTapGesture(count: 2) { toggleZoom() }
        }
        .overlay(alignment: .topTrailing) { closeButton }
        .overlay(alignment: .topLeading) { infoButton }
        .statusBarHidden()
        .animation(reduceMotion ? nil : Motion.move, value: committedZoom)
        .sheet(isPresented: $inspecting) { AssetDetailView(imageId: imageId) }
    }

    /// The same sheet the gallery opens. A picture in a transcript has a prompt
    /// and a model behind it too, and until now the only way to see either was to
    /// go and find it in the browser.
    private var infoButton: some View {
        Button {
            inspecting = true
        } label: {
            Image(systemName: "info")
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 34, height: 34)
                .floatingGlass(in: .circle, interactive: true)
        }
        .buttonStyle(.plain)
        .padding(Space.lg)
        .opacity(1 - min(1, Double(abs(dismissDrag)) / 160))
        .accessibilityLabel("这张图是怎么来的")
    }

    /// Fades the backdrop as the image is pulled away, so the dismiss reads as
    /// direct manipulation rather than a gesture that either fires or does not.
    private var backdropOpacity: Double {
        isZoomed ? 1 : max(0.25, 1 - Double(abs(dismissDrag)) / 320)
    }

    private var closeButton: some View {
        Button {
            dismiss()
        } label: {
            Image(systemName: "xmark")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 34, height: 34)
                .floatingGlass(in: .circle, interactive: true)
        }
        .buttonStyle(.plain)
        .padding(Space.lg)
        .opacity(1 - min(1, Double(abs(dismissDrag)) / 160))
        .accessibilityLabel("关闭")
    }

    private var magnify: some Gesture {
        MagnifyGesture()
            .onChanged { value in
                zoom = min(max(committedZoom * value.magnification, 1), 4)
            }
            .onEnded { _ in
                committedZoom = zoom
                if !isZoomed { resetPan() }
            }
    }

    /// One gesture serving two jobs: panning a zoomed image, and pulling an
    /// un-zoomed one away to dismiss.
    private var drag: some Gesture {
        DragGesture()
            .onChanged { value in
                if isZoomed {
                    pan = CGSize(
                        width: committedPan.width + value.translation.width,
                        height: committedPan.height + value.translation.height
                    )
                } else {
                    dismissDrag = value.translation.height
                }
            }
            .onEnded { value in
                if isZoomed {
                    committedPan = pan
                    return
                }
                // Distance or a flick, either one: demanding a long drag on a
                // tall phone is how a dismiss starts feeling stubborn.
                if abs(value.translation.height) > 120 || abs(value.predictedEndTranslation.height) > 260 {
                    dismiss()
                } else {
                    withAnimation(reduceMotion ? nil : Motion.move) { dismissDrag = 0 }
                }
            }
    }

    private func toggleZoom() {
        withAnimation(reduceMotion ? nil : Motion.move) {
            if isZoomed {
                committedZoom = 1
                zoom = 1
                resetPan()
            } else {
                committedZoom = 2.5
                zoom = 2.5
            }
        }
    }

    private func resetPan() {
        pan = .zero
        committedPan = .zero
    }
}
