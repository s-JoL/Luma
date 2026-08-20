import XCTest

/// Most of what is worth checking end to end needs a live server, which CI does
/// not have. What is here is the part that needs none: the app launches, and the
/// first screen is the one that asks where the server is rather than a blank
/// window.
final class LaunchTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    /// Both landings are correct and which one happens depends on whether a
    /// device token is already in the Keychain — which survives reinstalling the
    /// app, so a test that demanded one of them would pass or fail on the order
    /// the suite happened to run in.
    func testLaunchesToAUsableScreen() {
        let app = XCUIApplication()
        app.launch()

        let signIn = app.textFields["server.address"]
        // The tab bar rather than the conversation list: it is present on every
        // signed-in destination, so the check does not depend on which one the
        // previous test happened to leave selected.
        let conversations = app.tabBars.firstMatch

        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline, !signIn.exists, !conversations.exists {
            usleep(200_000)
        }

        XCTAssertTrue(
            signIn.exists || conversations.exists,
            "launch should reach either the server form or the conversation list"
        )
    }
}
