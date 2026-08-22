import SwiftUI

/// Every screen in the app that is not the transcript.
///
/// The app used to draw its own chrome on each screen — a `Color.card` rectangle
/// with a hairline, a hand-placed section title, whatever text field the author
/// reached for — and five screens built that way are five different-looking
/// screens. Worse, each one had to remember things that are easy to forget: an
/// inset so content does not slide under the tab bar, a way to put the keyboard
/// away, a background that matches.
///
/// So there is one container and it is the platform's. An inset-grouped `List`
/// already draws the card, the separators, the section headers and footers, and
/// it insets itself correctly under a tab bar. What is left for a screen to
/// decide is what goes in the sections, which is the only part that was ever
/// worth deciding.
///
/// Keyboard dismissal lives here rather than in each screen because it was
/// missing from every screen but two, and 创作台 was unusable as a result: the
/// keyboard came up on the prompt field and nothing put it away.
struct FormScreen<Content: View>: View {
    let title: String
    var titleMode: NavigationBarItem.TitleDisplayMode = .inline
    @ViewBuilder var content: Content

    var body: some View {
        List { content }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Color.bg)
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(titleMode)
            .dismissableKeyboard()
    }
}

/// A screen you browse rather than fill in: conversations, files.
///
/// The distinction from `FormScreen` is the platform's own. Settings is grouped
/// because its rows are fields; Mail and Files are plain because their rows are
/// things. Making it two containers rather than a parameter means a new screen
/// has to answer the question — am I a form or a collection — and there is no
/// third answer to invent.
struct BrowseScreen<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        List { content }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Color.bg)
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .dismissableKeyboard()
    }
}

extension View {
    /// The chrome a grouped screen shares, for the ones that build their own
    /// `List` because they need `.overlay`, `.searchable` or a selection binding
    /// that `FormScreen` does not take.
    ///
    /// It exists because the recipe was copied into eight settings screens by
    /// hand, and every copy left out the same two lines — so every settings
    /// editor had a keyboard that could not be dismissed, exactly as 创作台 did.
    /// A shared modifier is the difference between remembering and not having to.
    func formChrome(_ title: String) -> some View {
        listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Color.bg)
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .dismissableKeyboard()
    }

    /// A 完成 key above the keyboard, and the resign that goes with it.
    ///
    /// Deliberately not built on `@FocusState`: that needs one enum per screen
    /// and one `.focused` per field, and the failure mode when a field is missed
    /// is a keyboard that cannot be dismissed. Asking the responder chain to give
    /// up first responder works for every field on every screen, including the
    /// ones inside `SchemaForm` that are generated from a server schema and have
    /// no compile-time identity to focus on.
    func dismissableKeyboard() -> some View {
        toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("完成") { Keyboard.dismiss() }
                    .fontWeight(.medium)
            }
        }
    }
}

enum Keyboard {
    static func dismiss() {
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil
        )
    }
}

// MARK: - Content surfaces

/// What a block inside the transcript is made of.
///
/// The transcript is the one place that cannot use a `List` — it is a stream of
/// prose with things embedded in it, not rows — so it draws its own containers.
/// It was drawing five of them: a tool block, an approval card, a code block, an
/// error and a picture, each with its own fill, its own radius and its own
/// hairline opacity, none of them quite matching. The tone is the only thing any
/// of them actually needed to vary.
enum CardTone {
    /// Something the model produced that the reader acts on: a tool, a card.
    case raised
    /// Something quoted verbatim — code, a parameter dump.
    case sunken
    /// A question that is blocking work.
    case warning
    case danger

    var fill: Color {
        switch self {
        case .raised: .card
        case .sunken: .mutedFill
        case .warning: .card
        case .danger: Color.danger.opacity(0.08)
        }
    }

    var border: Color {
        switch self {
        case .raised, .sunken: .hairline
        case .warning: .warn
        case .danger: Color.danger.opacity(0.3)
        }
    }

    /// Only a question that stops the agent earns a heavier edge.
    var width: CGFloat {
        self == .warning ? 1.5 : 1
    }
}

extension View {
    func contentCard(_ tone: CardTone = .raised) -> some View {
        background(tone.fill, in: RoundedRectangle(cornerRadius: Radius.lg))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.lg)
                    .strokeBorder(tone.border, lineWidth: tone.width)
            )
    }
}

// MARK: - The rows a form is built from

/// A label with its value on the right, which is what most settings rows are.
/// `LabeledContent` does this natively; this exists so the truncation and the
/// secondary colour are decided once.
struct FactRow: View {
    let name: String
    let value: String

    init(_ name: String, _ value: String) {
        self.name = name
        self.value = value
    }

    var body: some View {
        LabeledContent(name) {
            Text(value)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing)
                .lineLimit(2)
                .truncationMode(.middle)
        }
    }
}

/// A field with its name above it rather than beside it. Used where the value is
/// long enough that a trailing field would be a few characters wide — a prompt,
/// a URL, a workspace path.
struct StackedField<Field: View>: View {
    let name: String
    var help: String?
    @ViewBuilder var field: Field

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(name)
                .font(.footnote)
                .foregroundStyle(.secondary)
            field
            if let help {
                Text(help)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

/// The one prominent action on a screen, as a full-width row.
///
/// A `.borderedProminent` button inside a list row sits in a grey capsule that
/// reads as disabled next to the list's own fills, which is what 开始生成 looked
/// like. This fills the row instead, so the primary action is the widest and
/// most saturated thing on screen and nothing else has to compete.
struct PrimaryRow: View {
    let title: String
    var systemImage: String?
    var isBusy = false
    var isEnabled = true
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.sm) {
                Spacer()
                if isBusy {
                    ProgressView().tint(Color.onBrand)
                } else if let systemImage {
                    Image(systemName: systemImage).font(.subheadline.weight(.semibold))
                }
                Text(title).font(.body.weight(.semibold))
                Spacer()
            }
            .foregroundStyle(Color.onBrand)
            .frame(height: 26)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isBusy || !isEnabled)
        .listRowBackground(Group {
            if isEnabled && !isBusy {
                LinearGradient.brandFill
            } else {
                Color.mutedFill
            }
        })
    }
}

/// Nothing here yet, said in the same shape everywhere. `ContentUnavailableView`
/// inside a list row rather than as an overlay, so an empty section still reads
/// as part of the page instead of as a blank screen with a floating message.
struct EmptyRow: View {
    let title: String
    let systemImage: String
    var help: String?

    var body: some View {
        VStack(spacing: Space.sm) {
            Image(systemName: systemImage)
                .font(.system(size: 26))
                .foregroundStyle(Color.mutedFg)
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color.fg)
            if let help {
                Text(help)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Space.xl)
        .listRowBackground(Color.clear)
        // Separators around an empty state draw a box around nothing.
        .listRowSeparator(.hidden)
    }
}
