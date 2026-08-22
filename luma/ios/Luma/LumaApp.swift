import SwiftUI

@main
struct LumaApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(.brand)
                // Parsed Markdown is the app's largest recomputable cache, and a
                // long reading session fills it. Everything in it can be rebuilt
                // from the transcript, so under pressure it goes: re-parsing the
                // paragraph on screen is a far better outcome than being killed.
                .task { RenderLog.startHeartbeat() }
                .onReceive(
                    NotificationCenter.default.publisher(
                        for: UIApplication.didReceiveMemoryWarningNotification
                    )
                ) { _ in
                    MarkdownCache.purge()
                }
        }
    }
}
