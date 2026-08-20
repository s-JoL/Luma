import UIKit

/// Asks iOS for a little more time after the app leaves the screen, so a run
/// that is nearly finished can finish while the phone is in a pocket instead of
/// being discovered minutes later on the next look.
///
/// The window is short and not guaranteed. When it expires the app stops
/// cleanly, records its cursor, and lets the server carry on alone — the run is
/// a server-side object, so nothing is lost by giving up here.
@MainActor
final class BackgroundActivity {
    private var identifier: UIBackgroundTaskIdentifier = .invalid

    init(name: String) {
        identifier = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            // iOS is reclaiming the time; end the assertion before it kills us.
            self?.end()
        }
    }

    func end() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
        identifier = .invalid
    }
}

/// Short, quiet feedback for the three moments that deserve it. A chat app that
/// buzzes on every token is unbearable; one that says nothing when a long answer
/// lands makes you keep checking the screen.
@MainActor
enum Haptics {
    static func tap() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    static func settled() {
        UIImpactFeedbackGenerator(style: .soft).impactOccurred(intensity: 0.7)
    }

    static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    static func warning() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }
}
