import XCTest

/// Sends a message and watches it stream, which is the acceptance item the whole
/// app exists for. Needs a server with a working chat model; skipped otherwise.
final class TranscriptTests: XCTestCase {
    private var host: String? { ProcessInfo.processInfo.environment["LUMA_HOST"] }
    private var code: String? { ProcessInfo.processInfo.environment["LUMA_CODE"] }
    /// Title of a conversation on that server whose model actually answers.
    private var conversation: String {
        ProcessInfo.processInfo.environment["LUMA_CONVERSATION"] ?? "流式测试"
    }

    override func setUp() {
        continueAfterFailure = false
    }

    func testSendsAndStreamsAnAnswer() throws {
        let app = try signedInApp()

        let row = app.staticTexts[conversation]
        XCTAssertTrue(row.waitForExistence(timeout: 15), "expected a conversation named \(conversation)")
        row.tap()

        let composer = app.textFields["composer.text"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10), "the composer should be up with the transcript")
        composer.tap()
        composer.typeText("写个五图卡点脚本")

        app.buttons["composer.send"].tap()

        // The stub answers with a bold run across a CJK colon, which is exactly
        // the case CommonMark refuses to close and the renderer has to repair.
        let answer = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", "五图卡点")
        ).firstMatch
        XCTAssertTrue(answer.waitForExistence(timeout: 60), "the answer should stream into the transcript")

        add(screenshot(named: "streaming"))

        // The run finishing has to reach the composer: the button goes back to
        // send. A client that streams correctly but never notices the end leaves
        // the reader unable to ask anything else, which is worse than a visual
        // bug and is exactly what a settle path gets wrong quietly.
        let send = app.buttons["composer.send"]
        let deadline = Date().addingTimeInterval(60)
        while Date() < deadline, send.label != "发送" {
            usleep(300_000)
        }
        XCTAssertEqual(send.label, "发送", "the composer should return to send once the run settles")

        add(screenshot(named: "settled"))
    }

    /// The answer must still be there *after* the run settles, in a conversation
    /// that had nothing in it. A fresh conversation is the only place this is
    /// visible: re-running the same prompt in an existing one leaves an identical
    /// answer already on screen from last time, which is what hid a settle path
    /// that dropped the live turn without ever fetching the persisted one.
    func testAnswerSurvivesTheRunSettlingInANewConversation() throws {
        let app = try signedInApp()

        app.buttons["新对话"].firstMatch.tap()

        let composer = app.textFields["composer.text"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap()
        composer.typeText("写个五图卡点脚本")

        let send = app.buttons["composer.send"]
        XCTAssertTrue(send.isEnabled, "typing should enable send")
        send.tap()

        // Both edges, in order. Waiting only for "发送" passes on the label the
        // button already had before the POST resolved.
        XCTAssertTrue(waitUntil(20) { send.label == "停止" }, "the run should start")
        XCTAssertTrue(waitUntil(120) { send.label == "发送" }, "the run should settle")

        let answer = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", "五图卡点")
        ).firstMatch
        XCTAssertTrue(answer.exists, "the answer must survive the run settling, not vanish with the live turn")

        // Following the tail has to actually arrive at the tail. It did not for
        // a while: the scroll target was a 1pt sentinel at the end of a lazy
        // stack, which is not created when it is off screen, so the request was
        // silently dropped and the reader was left short of the last paragraph.
        let end = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", "别把五张图都塞满字")
        ).firstMatch
        XCTAssertTrue(
            waitUntil(10) { end.exists && end.isHittable },
            "the end of the answer should be on screen, not hidden behind the keyboard"
        )
    }

    /// Backgrounding mid-answer and coming back has to land on a complete
    /// transcript: no duplicated text, no missing tail, and no run that looks
    /// like it is still going when it finished while the phone was in a pocket.
    func testBackgroundingMidRunAndReturningLeavesACompleteTranscript() throws {
        let app = try signedInApp()

        app.buttons["新对话"].firstMatch.tap()
        let composer = app.textFields["composer.text"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap()
        composer.typeText("写个五图卡点脚本")

        let send = app.buttons["composer.send"]
        send.tap()
        XCTAssertTrue(waitUntil(20) { send.label == "停止" }, "the run should start")

        // Away while it is still answering, and back a beat later.
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 6)
        app.activate()

        XCTAssertTrue(
            waitUntil(120) { send.label == "发送" },
            "returning should notice the run finished rather than showing stop forever"
        )

        let answer = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", "五图卡点")
        ).firstMatch
        XCTAssertTrue(answer.exists, "the answer should be there after the round trip")

        // The tail is the part a dropped stream loses, so it is what gets checked.
        let tail = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", "别把五张图都塞满字")
        ).firstMatch
        XCTAssertTrue(tail.exists, "the end of the answer should have survived the suspend")
    }

    private func waitUntil(_ seconds: TimeInterval, _ condition: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if condition() { return true }
            usleep(300_000)
        }
        return condition()
    }

    // MARK: Helpers

    private func signedInApp() throws -> XCUIApplication {
        let host = try XCTUnwrap(host, "set TEST_RUNNER_LUMA_HOST to run this")
        let code = try XCTUnwrap(self.code, "set TEST_RUNNER_LUMA_CODE to run this")

        let app = XCUIApplication()
        app.launch()

        // The Keychain survives a reinstall, so the app may already be past the
        // form. Only fill it in when it is actually on screen.
        let address = app.textFields["server.address"]
        if address.waitForExistence(timeout: 5) {
            address.tap()
            address.typeText(host)
            app.buttons["server.connect"].tap()

            let accessCode = app.secureTextFields["auth.accessCode"]
            XCTAssertTrue(accessCode.waitForExistence(timeout: 15))
            accessCode.tap()
            accessCode.typeText(code)
            app.buttons["auth.signIn"].tap()
        }

        // The selected tab is `@SceneStorage`, so a previous run can leave the
        // app anywhere. Go to Chat rather than assuming.
        let chatTab = app.tabBars.buttons["对话"]
        if chatTab.waitForExistence(timeout: 20) { chatTab.tap() }

        XCTAssertTrue(
            app.navigationBars["对话"].waitForExistence(timeout: 20),
            "expected the conversation list"
        )
        return app
    }

    private func screenshot(named name: String) -> XCTAttachment {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        return attachment
    }
}
