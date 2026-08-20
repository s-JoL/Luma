import SwiftUI

/// `src/web/theme.css` converted to sRGB. Both clients read from the same table
/// so they look like one product.
///
/// These are dynamic colours rather than Asset Catalog colour sets. The effect is
/// identical — UIKit resolves the pair against the trait collection, so the app
/// follows the system appearance with no code at a call site — and keeping the
/// light and dark values on one line is what makes the table reviewable against
/// the document it came from. Only `AccentColor` and `background` are also in the
/// catalog, because the global tint and the launch screen are read before any
/// Swift runs.
///
/// Nothing outside this file names a hex value or a system colour. A screen that
/// does will be wrong in one of the two appearances.
extension Color {
    static let bg = dynamic(light: 0xFB_F9_F8, dark: 0x0F_10_14)
    static let fg = dynamic(light: 0x1C_1F_25, dark: 0xE5_E8_EC)
    static let card = dynamic(light: 0xFF_FF_FF, dark: 0x16_18_1D)
    static let popover = dynamic(light: 0xFF_FF_FF, dark: 0x1B_1D_22)

    /// `primary` collides with SwiftUI's own shape style, hence `brand`.
    static let brand = dynamic(light: 0x3D_68_CA, dark: 0x7B_A3_F6)
    static let onBrand = dynamic(light: 0xFB_FC_FD, dark: 0x0F_14_1D)

    static let secondaryFill = dynamic(light: 0xF1_F2_F5, dark: 0x22_24_29)
    static let onSecondary = dynamic(light: 0x2A_2E_35, dark: 0xE2_E5_E9)
    static let mutedFill = dynamic(light: 0xF2_F4_F6, dark: 0x1F_22_26)
    static let mutedFg = dynamic(light: 0x64_69_71, dark: 0x94_99_A0)
    static let accentFill = dynamic(light: 0xEC_F0_F8, dark: 0x25_2B_38)
    static let onAccent = dynamic(light: 0x32_42_63, dark: 0xCE_D8_EC)

    static let danger = dynamic(light: 0xD3_39_44, dark: 0xEA_69_72)
    static let ok = dynamic(light: 0x2E_90_52, dark: 0x66_CB_79)
    static let warn = dynamic(light: 0xD1_8E_35, dark: 0xEA_B3_5F)

    static let hairline = dynamic(light: 0xE1_E3_E6, dark: 0x2B_2E_33)
    static let fieldBorder = dynamic(light: 0xD9_DB_DE, dark: 0x35_38_3E)
    static let ring = dynamic(light: 0x3D_68_CA, dark: 0x6C_90_DC)

    static let sidebar = dynamic(light: 0xF4_F5_F7, dark: 0x09_0B_0F)
    static let sidebarLine = dynamic(light: 0xE3_E5_E7, dark: 0x24_26_2B)
    static let sidebarSelected = dynamic(light: 0xE9_EB_EF, dark: 0x20_24_2C)

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(rgb: dark) : UIColor(rgb: light) })
    }
}

private extension UIColor {
    convenience init(rgb: UInt32) {
        self.init(
            red: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1
        )
    }
}

/// A 4pt grid. Named for where each step is right rather than for its size, so a
/// screen picks a role and the number follows.
enum Space {
    /// Icon to label inside a chip.
    static let xs: CGFloat = 4
    /// Inside a bubble, between chips.
    static let sm: CGFloat = 8
    /// Screen side margins on iPhone, composer padding.
    static let md: CGFloat = 12
    /// Screen side margins on iPad, card padding.
    static let lg: CGFloat = 16
    /// Between turns in the transcript.
    static let xl: CGFloat = 24
    /// Above an empty state.
    static let xxl: CGFloat = 32
}

/// Mirrors the web's `--radius: 0.625rem` and the steps derived from it.
enum Radius {
    static let sm: CGFloat = 6
    static let md: CGFloat = 8
    static let lg: CGFloat = 10
    static let xl: CGFloat = 14
    static let bubble: CGFloat = 18
}

/// Two curves and nothing else. Streaming text is deliberately not animated: a
/// `withAnimation` around an appended token re-lays out the whole paragraph on
/// every delta and turns a 60 token/second stream into a stutter.
enum Motion {
    static let quick = Animation.easeOut(duration: 0.12)
    static let move = Animation.spring(response: 0.32, dampingFraction: 0.86)
}
