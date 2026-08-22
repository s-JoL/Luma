import AppIntents

/// "问 Luma…" from Siri, Spotlight, the Shortcuts app or the Action button.
///
/// Something the browser client structurally cannot offer: on a phone the fastest
/// path to an agent is not opening an app and finding the composer, it is saying
/// the question out loud while doing something else.
///
/// `openAppWhenRun` on purpose. The intent could post the run itself — the API is
/// one call — but then the answer would arrive somewhere the owner is not
/// looking, and an agent run can stop halfway to ask for approval. Opening on the
/// new conversation means the question is asked from the intent and answered
/// where it can be watched, steered and approved.
struct AskLumaIntent: AppIntent {
    static let title: LocalizedStringResource = "问 Luma"
    static let description = IntentDescription("新开一个对话，把问题发给 Luma。")
    static let openAppWhenRun = true

    @Parameter(title: "问题", requestValueDialog: "想问什么？")
    var prompt: String

    @MainActor
    func perform() async throws -> some IntentResult {
        Handoff.park(prompt)
        return .result()
    }
}

struct LumaShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskLumaIntent(),
            phrases: [
                "问 \(.applicationName)",
                "让 \(.applicationName) 回答",
                "Ask \(.applicationName)",
            ],
            shortTitle: "问 Luma",
            systemImageName: "bubble.left.and.bubble.right"
        )
    }
}
