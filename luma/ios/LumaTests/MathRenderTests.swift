import SwiftUI
import Testing

@testable import Luma

/// Laid out for real, because the layer that would fail silently is the one no
/// parsing test reaches: `Math` can split a formula out of a sentence perfectly
/// and the reader still sees nothing if SwiftMath is not actually wired up.
@MainActor
struct MathRenderTests {
    private func height(_ view: some View, width: CGFloat = 320) -> CGFloat {
        UIHostingController(rootView: view)
            .sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude))
            .height
    }

    @Test("a formula rasterises")
    func rastersInline() {
        let rendered = MathRaster.image("\\frac{a}{b}", fontSize: 17, colour: .label)
        let formula = try? #require(rendered)
        #expect(formula != nil, "SwiftMath produced nothing for a valid fraction")
        if let formula {
            #expect(formula.image.size.width > 4)
            #expect(formula.image.size.height > 4)
        }
    }

    /// A fraction is taller than a single character, which is the whole reason
    /// inline math needs a baseline offset rather than plain text.
    @Test("a stacked formula is taller than a flat one")
    func stackedIsTaller() {
        let flat = MathRaster.image("x", fontSize: 17, colour: .label)
        let stacked = MathRaster.image("\\frac{a}{b}", fontSize: 17, colour: .label)
        guard let flat, let stacked else {
            Issue.record("both formulas should render")
            return
        }
        #expect(stacked.image.size.height > flat.image.size.height)
    }

    @Test("nonsense does not render as a formula")
    func rejectsGarbage() {
        #expect(MathRaster.image("\\notarealcommand{", fontSize: 17, colour: .label) == nil)
    }

    /// The raster came out upside down, and the way that bug survived being
    /// looked at is the reason this test exists: `=`, `0`, `+` and `−` are
    /// vertically symmetric, so a mirrored formula renders as plausible nonsense
    /// rather than as something obviously broken.
    ///
    /// A capital delta is a triangle standing on its base. Upright, almost all of
    /// its ink is in the bottom half; flipped, almost none of it is.
    @Test("a formula is not rendered upside down")
    func isNotMirrored() {
        guard let rendered = MathRaster.image("\\Delta", fontSize: 40, colour: .black),
              let ink = Self.inkByHalf(rendered.image)
        else {
            Issue.record("the delta should have rendered")
            return
        }
        #expect(
            ink.bottom > ink.top * 1.5,
            "delta has \(ink.top) ink on top and \(ink.bottom) below — it is upside down"
        )
    }

    /// Alpha-weighted coverage of the top and bottom halves.
    private static func inkByHalf(_ image: UIImage) -> (top: Double, bottom: Double)? {
        guard let cg = image.cgImage else { return nil }
        let width = cg.width
        let height = cg.height
        guard width > 0, height > 1 else { return nil }

        var pixels = [UInt8](repeating: 0, count: width * height)
        guard let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.alphaOnly.rawValue
        ) else { return nil }
        context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))

        // Row zero of the buffer is the top of the picture. `CGContext` puts its
        // *coordinate* origin at the bottom left, which invites the opposite
        // assumption, but `draw(_:in:)` writes the image top-down into memory.
        var top = 0.0
        var bottom = 0.0
        for row in 0..<height {
            let start = row * width
            let sum = pixels[start..<(start + width)].reduce(0.0) { $0 + Double($1) }
            if row < height / 2 { top += sum } else { bottom += sum }
        }
        return (top: top, bottom: bottom)
    }

    /// The end-to-end shape: a display formula has to reach `MathBlock` through
    /// the block splitter and take up room on screen.
    @Test("a display formula is laid out as a block")
    func drawsDisplayBlock() {
        let withMath = height(MarkdownText(text: "结论如下。\n\n$$E = mc^2$$", citations: [:]))
        let withoutMath = height(MarkdownText(text: "结论如下。", citations: [:]))
        #expect(withMath > withoutMath + 20, "the formula should add a block of its own")
    }

    @Test("a sentence with a formula in it is still laid out")
    func drawsInlineMath() {
        let text = "面积是 $\\frac{1}{2}bh$ 这么大。"
        #expect(height(MarkdownText(text: text, citations: [:])) > 0)
        #expect(Math.hasFormula(in: text))
    }

    /// The currency case, at the layer that matters: a price must not silently
    /// swallow the sentence between two dollar signs.
    @Test("a price renders as prose")
    func keepsPricesAsProse() {
        let priced = "从 $5 涨到 $10 了。"
        #expect(!Math.hasFormula(in: priced))
        #expect(height(MarkdownText(text: priced, citations: [:])) > 0)
    }
}
