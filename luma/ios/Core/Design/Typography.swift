import SwiftUI

/// Semantic text styles only, so Dynamic Type works without a parallel scale.
/// The web's 14.5px body becomes `.body` (17pt at the default setting): a phone
/// is held closer than a monitor and the browser number reads as small print.
extension View {
    /// Transcript prose. The web's 1.65 line-height expressed as leading.
    func proseLeading() -> some View { lineSpacing(3) }

    /// Caps Dynamic Type where a larger size stops producing a transcript. The
    /// promise is that everything *works* at accessibility sizes, not that a
    /// 60pt monospace line does not wrap.
    func transcriptTypeSize() -> some View {
        dynamicTypeSize(...DynamicTypeSize.accessibility3)
    }
}

extension Font {
    /// The one non-semantic size in the app: `.callout` monospaced is what keeps
    /// roughly 80 columns readable at the default Dynamic Type setting.
    static let code = Font.system(.callout, design: .monospaced)
    static let codeInline = Font.system(.callout, design: .monospaced)
}
