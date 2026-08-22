import Foundation

/// A question asked from outside the app, waiting to be picked up inside it.
///
/// An App Intent runs in its own short-lived context and cannot reach the store
/// graph, so the two halves are joined by `UserDefaults`: the intent writes what
/// was asked and opens the app, the app reads it once on the way to the
/// foreground. A single slot rather than a queue, because two questions asked
/// before the app has opened once means the second one is what the owner meant.
enum Handoff {
    private static let key = "luma.pendingAsk"

    static func park(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        UserDefaults.standard.set(trimmed, forKey: key)
    }

    /// Read once and cleared, so a relaunch does not re-ask the same question.
    static func take() -> String? {
        guard let text = UserDefaults.standard.string(forKey: key), !text.isEmpty else { return nil }
        UserDefaults.standard.removeObject(forKey: key)
        return text
    }
}
