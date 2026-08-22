import UIKit
import UserNotifications

/// Tells the owner that something they were waiting for is done.
///
/// The web client posts a browser notification when its tab is hidden. A phone
/// has the stronger version of the same problem and the stronger answer: an agent
/// run or a video render takes minutes, nobody watches a phone for minutes, and
/// iOS suspends the app a few seconds after it leaves the screen — so the run
/// finishing is something the owner would otherwise discover by opening the app
/// and looking.
///
/// Permission is asked for the first time there is something worth saying, not at
/// launch. A prompt that arrives before the app has ever done anything is the one
/// people decline.
@MainActor
enum Notifier {
    private static var asked = false

    /// Only when the app is not on screen. A banner over the transcript that is
    /// already showing the finished answer is noise, and the haptic on settle
    /// already covers that case.
    static var isAway: Bool {
        UIApplication.shared.applicationState != .active
    }

    static func runFinished(title: String, failed: Bool) async {
        await post(
            title: title.isEmpty ? "对话" : title,
            body: failed ? "这次回答失败了" : "回答完成了",
            id: "run"
        )
    }

    static func jobFinished(model: String, failed: Bool) async {
        await post(
            title: model.isEmpty ? "创作台" : model,
            body: failed ? "生成失败了" : "生成完成了",
            id: "job"
        )
    }

    private static func post(title: String, body: String, id: String) async {
        guard isAway, await authorise() else { return }

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.interruptionLevel = .active

        let request = UNNotificationRequest(
            identifier: "\(id).\(UUID().uuidString)",
            content: content,
            // Delivered now. There is no deadline to schedule against — the
            // thing being reported has already happened.
            trigger: nil
        )
        try? await UNUserNotificationCenter.current().add(request)
    }

    /// Asks once per launch at most. A declined prompt is remembered by the
    /// system, so a second `requestAuthorization` is a no-op that returns false
    /// rather than a second banner — but the round trip is still skipped.
    private static func authorise() async -> Bool {
        let centre = UNUserNotificationCenter.current()
        let settings = await centre.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            return true
        case .notDetermined:
            guard !asked else { return false }
            asked = true
            // Provisional as well as alert: a quiet notification that lands in
            // Notification Centre without a prompt is the right first
            // impression for something the owner did not ask to be told about.
            return (try? await centre.requestAuthorization(options: [.alert, .sound, .provisional])) ?? false
        default:
            return false
        }
    }
}
