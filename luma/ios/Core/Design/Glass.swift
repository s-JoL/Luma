import SwiftUI

/// iOS 26's Liquid Glass, with a material fallback for iOS 17–25.
///
/// Apple's rule, and the one thing that keeps this from looking cheap: **glass is
/// for the navigation layer that floats above content, never for content itself.**
/// So the composer, the jump-to-latest pill and the floating actions are glass;
/// tool blocks, approval cards and message bubbles are not. Glass is also never
/// stacked on glass — nested elements go in one `GlassEffectContainer`, which is
/// what lets them sample the same region and morph into each other.
///
/// The system already glasses the navigation bar, tab bar, sheets and menus,
/// because the app is built against the iOS 26 SDK. Nothing here re-does that.
extension View {
    /// A floating surface: Liquid Glass where it exists, a blurred material
    /// with a hairline where it does not. Both read as "above the page".
    /// `InsettableShape` rather than `Shape`, because the pre-26 fallback draws
    /// its hairline with `strokeBorder` so the stroke sits inside the bounds.
    @ViewBuilder
    func floatingGlass<S: InsettableShape>(
        in shape: S,
        tinted tint: Color? = nil,
        interactive: Bool = false
    ) -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(glass(tint: tint, interactive: interactive), in: shape)
        } else {
            background(.regularMaterial, in: shape)
                .overlay(shape.strokeBorder(Color.hairline.opacity(0.6), lineWidth: 1))
        }
    }

    @available(iOS 26.0, *)
    private func glass(tint: Color?, interactive: Bool) -> Glass {
        var glass = Glass.regular
        if let tint { glass = glass.tint(tint) }
        if interactive { glass = glass.interactive() }
        return glass
    }
}

extension View {
    /// Attaches a floating bar that content scrolls beneath. On iOS 26
    /// `safeAreaBar` additionally registers it for the scroll edge effect, so
    /// text dissolves as it passes under instead of colliding with the glass.
    @ViewBuilder
    func composerBar<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        if #available(iOS 26.0, *) {
            safeAreaBar(edge: .bottom, spacing: 0, content: content)
        } else {
            safeAreaInset(edge: .bottom, spacing: 0, content: content)
        }
    }
}

/// Groups nearby glass so it samples one region and can morph between shapes.
/// A no-op below iOS 26, where the fallback material needs no coordination.
struct GlassGroup<Content: View>: View {
    var spacing: CGFloat = 20
    @ViewBuilder var content: Content

    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) { content }
        } else {
            content
        }
    }
}

/// A travelling highlight, for a surface that is waiting on the server. Gemini's
/// loading shimmer is the reference: it reads as "working" without the
/// jitteriness of a spinner, and it costs one animated gradient.
///
/// Respects Reduce Motion by holding still — a moving highlight is exactly the
/// kind of thing that setting exists to stop.
struct Shimmer: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase: CGFloat = -1

    func body(content: Content) -> some View {
        if reduceMotion {
            content
        } else {
            content
                .overlay {
                    GeometryReader { geometry in
                        LinearGradient(
                            colors: [.clear, Color.white.opacity(0.35), .clear],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                        .frame(width: geometry.size.width * 0.6)
                        .offset(x: phase * geometry.size.width * 1.6)
                        .blendMode(.plusLighter)
                    }
                    .allowsHitTesting(false)
                }
                .mask(content)
                .onAppear {
                    withAnimation(.linear(duration: 1.6).repeatForever(autoreverses: false)) {
                        phase = 1
                    }
                }
        }
    }
}

extension View {
    func shimmering() -> some View { modifier(Shimmer()) }
}

/// The block cursor at the end of a streaming answer. Small, quiet, and the
/// clearest possible signal that more text is coming — a spinner beside the
/// paragraph says the same thing while pulling the eye away from the words.
struct StreamingCaret: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var on = true

    var body: some View {
        RoundedRectangle(cornerRadius: 1)
            .fill(Color.brand)
            .frame(width: 2, height: 17)
            .opacity(reduceMotion ? 1 : (on ? 1 : 0.15))
            .animation(
                reduceMotion ? nil : .easeInOut(duration: 0.6).repeatForever(autoreverses: true),
                value: on
            )
            .onAppear { on = false }
            .accessibilityHidden(true)
    }
}

/// A turn arriving in the transcript. Fades and rises a few points rather than
/// popping, which is the difference between an answer that appears and one that
/// lands. Deliberately small: 6pt and 180ms, because a chat that animates
/// theatrically on every turn is tiring by the tenth message.
struct TurnArrival: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .opacity(shown || reduceMotion ? 1 : 0)
            .offset(y: shown || reduceMotion ? 0 : 6)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeOut(duration: 0.18)) { shown = true }
            }
    }
}

extension View {
    func turnArrival() -> some View { modifier(TurnArrival()) }
}

/// The brand gradient, used for exactly two things: the sign-in mark and the
/// send button. Everywhere else a flat `brand` fill is correct — a gradient on
/// every control is how an interface starts looking like a template.
extension LinearGradient {
    static let brandFill = LinearGradient(
        colors: [Color.brand, Color.brand.mix(with: .purple, by: 0.22)],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )
}

extension Color {
    /// `Color.mix(with:by:)` is iOS 18; this is the same idea for the floor.
    func mix(with other: Color, by amount: Double) -> Color {
        let lhs = UIColor(self)
        let rhs = UIColor(other)
        var (r1, g1, b1, a1): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        var (r2, g2, b2, a2): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        lhs.getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
        rhs.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
        let t = CGFloat(min(max(amount, 0), 1))
        return Color(
            red: Double(r1 + (r2 - r1) * t),
            green: Double(g1 + (g2 - g1) * t),
            blue: Double(b1 + (b2 - b1) * t),
            opacity: Double(a1 + (a2 - a1) * t)
        )
    }
}
