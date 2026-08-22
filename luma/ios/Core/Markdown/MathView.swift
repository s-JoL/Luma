import SwiftMath
import SwiftUI

/// A display formula: its own line, horizontally scrollable because a long
/// equation is wider than a phone and shrinking it to fit is how a formula
/// becomes unreadable rather than merely long.
struct MathBlock: View, Equatable {
    let latex: String

    nonisolated static func == (lhs: MathBlock, rhs: MathBlock) -> Bool {
        lhs.latex == rhs.latex
    }

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            MathLabel(latex: latex, fontSize: 19, mode: .display)
                .padding(.horizontal, Space.md)
                .padding(.vertical, Space.sm)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.mutedFill.opacity(0.5), in: RoundedRectangle(cornerRadius: Radius.md))
        // The rendered glyphs are drawn in `Color.fg`, which resolves against the
        // trait collection at draw time — but the view is not rebuilt by a trait
        // change on its own, so the scheme is read here to force one.
        .id(scheme)
    }
}

/// `MTMathUILabel` sized to its own content. SwiftMath is UIKit and lays out in
/// TextKit's terms, so the bridge is a plain representable rather than anything
/// clever: what SwiftUI needs from it is an intrinsic size, and the label already
/// computes one.
struct MathLabel: UIViewRepresentable {
    let latex: String
    var fontSize: CGFloat
    var mode: MTMathUILabelMode

    func makeUIView(context: Context) -> MTMathUILabel {
        let label = MTMathUILabel()
        label.labelMode = mode
        label.textAlignment = .left
        label.contentInsets = .zero
        label.setContentHuggingPriority(.required, for: .horizontal)
        label.setContentHuggingPriority(.required, for: .vertical)
        label.setContentCompressionResistancePriority(.required, for: .horizontal)
        return label
    }

    func updateUIView(_ label: MTMathUILabel, context: Context) {
        if label.latex != latex { label.latex = latex }
        label.fontSize = fontSize
        label.textColor = UIColor(Color.fg)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: MTMathUILabel, context: Context) -> CGSize? {
        let size = uiView.intrinsicContentSize
        guard size.width > 0, size.height > 0 else { return nil }
        return size
    }
}

/// A paragraph with formulas in the middle of its sentences.
///
/// MarkdownUI renders a paragraph as a tree of SwiftUI views and offers no way to
/// put a foreign view inside a line of it, so a paragraph carrying inline math is
/// drawn here instead: the prose through the same inline-only `AttributedString`
/// parser the streaming tail uses, and each formula rasterised and concatenated
/// into the same `Text`. Concatenation is what makes it wrap like prose — a
/// formula in the middle of a sentence breaks with the sentence rather than
/// sitting on a line of its own.
///
/// The trade is that such a paragraph loses MarkdownUI's block features. That is
/// the right way round: a sentence with a formula in it is a sentence, and
/// showing `$\frac{a}{b}$` as literal source was the alternative.
struct InlineMathText: View, Equatable {
    let text: String

    nonisolated static func == (lhs: InlineMathText, rhs: InlineMathText) -> Bool {
        lhs.text == rhs.text
    }

    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        composed
            .font(.body)
            .foregroundStyle(Color.fg)
            .proseLeading()
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var composed: Text {
        Math.runs(in: text).reduce(Text(verbatim: "")) { result, run in
            switch run {
            case .text(let prose):
                return result + Text(Self.inline(prose))
            case .math(let latex):
                guard let formula = MathRaster.image(latex, fontSize: fontSize, colour: UIColor(Color.fg))
                else {
                    // A formula SwiftMath cannot parse is shown as its source
                    // rather than dropped: wrong-looking beats absent, and the
                    // reader can still see what the model wrote.
                    return result + Text(verbatim: latex).font(.code)
                }
                return result
                    + Text(Image(uiImage: formula.image)).baselineOffset(-formula.baseline)
            }
        }
    }

    private var fontSize: CGFloat {
        UIFontMetrics(forTextStyle: .body).scaledValue(for: 17)
    }

    private static func inline(_ prose: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: false,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        return (try? AttributedString(markdown: prose, options: options)) ?? AttributedString(prose)
    }
}

/// A formula as a bitmap, for the one place a view cannot go: inside a `Text`.
///
/// Cached because a paragraph is re-composed on every body pass and rasterising
/// is not free. Keyed on the appearance as well as the formula, since the glyphs
/// are drawn in the foreground colour and that changes with the system theme.
@MainActor
enum MathRaster {
    private struct Key: Hashable {
        let latex: String
        let fontSize: CGFloat
        let dark: Bool
    }

    private static var cache: [Key: UIImage] = [:]
    private static var order: [Key] = []
    private static let limit = 200

    static func image(_ latex: String, fontSize: CGFloat, colour: UIColor) -> BaselineImage? {
        let dark = UITraitCollection.current.userInterfaceStyle == .dark
        let key = Key(latex: latex, fontSize: fontSize, dark: dark)
        if let hit = cache[key] { return BaselineImage(hit) }

        let label = MTMathUILabel()
        label.labelMode = .text
        label.fontSize = fontSize
        label.textColor = colour
        label.contentInsets = .zero
        label.latex = latex
        guard label.error == nil else { return nil }

        let size = label.intrinsicContentSize
        guard size.width > 0.5, size.height > 0.5, size.width < 4000, size.height < 2000 else {
            return nil
        }
        label.frame = CGRect(origin: .zero, size: size)
        label.layoutIfNeeded()

        let format = UIGraphicsImageRendererFormat.preferred()
        format.opaque = false
        let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
            // Flipped, and this is not optional. SwiftMath draws with Core Text,
            // whose origin is at the bottom; a live view gets the compensating
            // flip from UIKit when `draw(_:)` is called, and `CALayer.render(in:)`
            // does not. Without this the formula comes out mirrored — which is
            // invisible for `=`, `0` and `+` and unmistakable for anything else,
            // so it renders as plausible-looking nonsense rather than as an
            // obvious failure.
            let cg = context.cgContext
            cg.translateBy(x: 0, y: size.height)
            cg.scaleBy(x: 1, y: -1)
            label.layer.render(in: cg)
        }.withRenderingMode(.alwaysOriginal)

        cache[key] = image
        order.append(key)
        if order.count > limit { cache.removeValue(forKey: order.removeFirst()) }
        return BaselineImage(image)
    }

    static func purge() {
        cache.removeAll(keepingCapacity: false)
        order.removeAll(keepingCapacity: false)
    }
}

/// An image and the offset that puts it on the text baseline. SwiftMath draws
/// with the formula's own baseline a fixed fraction from the bottom for the
/// `text` mode used inline, which is close enough that a single ratio reads
/// correctly across sizes.
struct BaselineImage {
    let image: UIImage
    let baseline: CGFloat

    init(_ image: UIImage) {
        self.image = image
        baseline = image.size.height * 0.22
    }
}
