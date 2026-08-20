import XCTest

/// End to end against a real server, which is the only kind of verification this
/// deployment can actually be wrong about. Skipped when no server is configured,
/// so the suite still runs on a machine that has none.
///
/// Point it at one by exporting the address and access code before the test run;
/// `xcodebuild` forwards anything prefixed `TEST_RUNNER_` to the runner process:
///
///     TEST_RUNNER_LUMA_HOST=127.0.0.1:8090 \
///     TEST_RUNNER_LUMA_CODE=XXXX-XXXX-XXXX-XXXX \
///     xcodebuild test -scheme Luma -destination '...'
final class SignInTests: XCTestCase {
    private var host: String? { ProcessInfo.processInfo.environment["LUMA_HOST"] }
    private var code: String? { ProcessInfo.processInfo.environment["LUMA_CODE"] }

    override func setUp() {
        continueAfterFailure = false
    }

    func testSignsInAndListsConversations() throws {
        let host = try XCTUnwrap(host, "set TEST_RUNNER_LUMA_HOST to run this")
        let code = try XCTUnwrap(self.code, "set TEST_RUNNER_LUMA_CODE to run this")

        let app = XCUIApplication()
        // Starts at step one rather than at whatever the last run left behind.
        // `-luma.reset` rather than `-luma.baseURL ""`: a `-key value` argument
        // lands in `UserDefaults`' argument domain, which outranks the domain
        // the app writes to, so an emptied address would also shadow the one
        // typed below for the rest of the launch. It clears the Keychain token
        // too, which no launch argument can reach.
        app.launchArguments += ["-luma.reset", "1"]
        app.launch()

        let address = app.textFields["server.address"]
        XCTAssertTrue(address.waitForExistence(timeout: 10))
        address.tap()
        address.typeText(host)

        app.buttons["server.connect"].tap()

        let accessCode = app.secureTextFields["auth.accessCode"]
        XCTAssertTrue(
            accessCode.waitForExistence(timeout: 15),
            "the access code step should appear once /health answers"
        )
        accessCode.tap()
        accessCode.typeText(code)

        app.buttons["auth.signIn"].tap()

        // The conversation list is the app's front door after a sign-in.
        XCTAssertTrue(
            app.navigationBars["对话"].waitForExistence(timeout: 20),
            "signing in should land on the conversation list"
        )
    }

    /// A wrong code must show the server's own message and keep the app signed
    /// out — never sign the user out of a screen they were never on, and never
    /// discard what they typed.
    func testWrongCodeKeepsTheUserOnTheForm() throws {
        let host = try XCTUnwrap(host, "set TEST_RUNNER_LUMA_HOST to run this")

        let app = XCUIApplication()
        app.launchArguments += ["-luma.reset", "1"]
        app.launch()

        let address = app.textFields["server.address"]
        XCTAssertTrue(address.waitForExistence(timeout: 10))
        address.tap()
        address.typeText(host)
        app.buttons["server.connect"].tap()

        let accessCode = app.secureTextFields["auth.accessCode"]
        XCTAssertTrue(accessCode.waitForExistence(timeout: 15))
        accessCode.tap()
        accessCode.typeText("definitely-not-the-code")
        app.buttons["auth.signIn"].tap()

        XCTAssertTrue(
            app.buttons["auth.signIn"].waitForExistence(timeout: 15),
            "a refusal leaves the form up rather than navigating anywhere"
        )
        XCTAssertFalse(app.navigationBars["对话"].exists)
    }
}
