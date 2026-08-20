import XCTest

/// Not an assertion suite: this walks the app and attaches a screenshot of each
/// screen, so a visual change can be reviewed rather than described. Runs only
/// when a server is configured, like the rest of the live tests.
final class GalleryTests: XCTestCase {
    private var host: String? { ProcessInfo.processInfo.environment["LUMA_HOST"] }
    private var code: String? { ProcessInfo.processInfo.environment["LUMA_CODE"] }

    override func setUp() {
        continueAfterFailure = false
    }

    func testCapturesEveryScreen() throws {
        let host = try XCTUnwrap(host, "set TEST_RUNNER_LUMA_HOST to run this")
        let code = try XCTUnwrap(self.code, "set TEST_RUNNER_LUMA_CODE to run this")

        let app = XCUIApplication()
        // Start from the server form every time, so the first frame is the one a
        // new owner actually sees.
        app.launchArguments += ["-luma.reset", "1"]
        app.launch()

        let address = app.textFields["server.address"]
        XCTAssertTrue(address.waitForExistence(timeout: 10))
        capture("01-server", app)

        address.tap()
        address.typeText(host)
        app.buttons["server.connect"].tap()

        let accessCode = app.secureTextFields["auth.accessCode"]
        XCTAssertTrue(accessCode.waitForExistence(timeout: 15))
        capture("02-access-code", app)

        accessCode.tap()
        accessCode.typeText(code)
        app.buttons["auth.signIn"].tap()

        let chatTab = app.tabBars.buttons["对话"]
        if chatTab.waitForExistence(timeout: 20) { chatTab.tap() }
        XCTAssertTrue(app.navigationBars["对话"].waitForExistence(timeout: 20))
        capture("03-conversations", app)

        // A conversation with no messages, for the welcome state.
        app.buttons["新对话"].firstMatch.tap()
        _ = app.textFields["composer.text"].waitForExistence(timeout: 10)
        capture("04-welcome", app)

        // Send one, so the tool block and the rendered answer are on the record.
        let composer = app.textFields["composer.text"]
        let send = app.buttons["composer.send"]

        composer.tap()
        composer.typeText("写个五图卡点脚本")
        // Assert rather than hope: a tap that misses the field leaves send
        // disabled, and without this the gallery quietly captures a blank
        // transcript and calls it a pass.
        XCTAssertTrue(send.isEnabled, "typing should enable send")

        send.tap()

        // Two waits, not one. The POST is in flight for a moment after the tap,
        // and a loop that only waits for "发送" exits immediately on the label it
        // started with — which captured an empty transcript and still passed.
        XCTAssertTrue(waitFor(deadline: 20) { send.label == "停止" }, "the run should start")

        // Mid-stream, so the caret and the streaming tail are on the record.
        _ = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", "先定结构")
        ).firstMatch.waitForExistence(timeout: 30)
        capture("05-streaming", app)

        XCTAssertTrue(waitFor(deadline: 120) { send.label == "发送" }, "the run should settle")

        capture("06-answer", app)

        // The tool block and the code block's header are at the top of a long
        // answer, so the tail-anchored view never shows them.
        app.swipeDown()
        app.swipeDown()
        capture("07-tools", app)

        // Back out to the tabs for the rest.
        app.navigationBars.buttons.firstMatch.tap()
        _ = app.navigationBars["对话"].waitForExistence(timeout: 10)

        app.tabBars.buttons["创作台"].tap()
        capture("08-studio", app)

        app.tabBars.buttons["文件"].tap()
        capture("09-files", app)

        app.tabBars.buttons["记忆"].tap()
        capture("10-memory", app)

        app.tabBars.buttons["设置"].tap()
        capture("11-settings", app)
    }

    private func waitFor(deadline seconds: TimeInterval, _ condition: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if condition() { return true }
            usleep(300_000)
        }
        return condition()
    }

    private func capture(_ name: String, _ app: XCUIApplication) {
        // A beat for the entrance animations to finish, so the frame is the
        // resting state rather than something mid-fade.
        Thread.sleep(forTimeInterval: 1.0)
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
