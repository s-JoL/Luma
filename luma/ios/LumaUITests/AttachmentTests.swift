import XCTest

/// A document attached to a turn, read back from the persisted transcript. This
/// is the case a live server is the only witness to: the chip renders from a
/// `file_ref` the server writes into the message, so a client that decoded it
/// wrongly — or a server that never wrote it — both look like a turn that
/// mentions an attachment and shows none.
///
/// Skipped when no server is configured, like the rest of the live tests:
///
///     TEST_RUNNER_LUMA_HOST=127.0.0.1:8090 \
///     TEST_RUNNER_LUMA_CODE=XXXX-XXXX-XXXX-XXXX \
///     TEST_RUNNER_LUMA_CONVERSATION='带附件的对话' \
///     xcodebuild test -scheme Luma -destination '...' -only-testing:LumaUITests/AttachmentTests
final class AttachmentTests: XCTestCase {
    private var host: String? { ProcessInfo.processInfo.environment["LUMA_HOST"] }
    private var code: String? { ProcessInfo.processInfo.environment["LUMA_CODE"] }
    private var conversation: String? { ProcessInfo.processInfo.environment["LUMA_CONVERSATION"] }

    override func setUp() {
        continueAfterFailure = false
    }

    func testADocumentAttachmentSurvivesIntoTheSettledTurn() throws {
        let title = try XCTUnwrap(conversation, "set TEST_RUNNER_LUMA_CONVERSATION to run this")
        let app = try signedInApp()

        let row = app.staticTexts[title]
        XCTAssertTrue(row.waitForExistence(timeout: 15), "expected a conversation named \(title)")
        row.tap()

        // `matching` rather than `containing`: the user turn combines into one
        // accessibility element, so a query for what *contains* the chip returns
        // the whole bubble and taps the message instead of the attachment.
        let chip = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "文档 ")
        ).firstMatch
        XCTAssertTrue(
            chip.waitForExistence(timeout: 20),
            "the user turn should carry the document it was sent with"
        )

        add(screenshot(named: "document chip"))

        // Tapping has to reach the bytes, which means the fetch carried the
        // token: an unauthenticated one fails and the viewer says so instead of
        // showing the file.
        chip.tap()
        XCTAssertTrue(
            app.buttons["完成"].waitForExistence(timeout: 30),
            "the document should open rather than fail to download"
        )
        XCTAssertFalse(app.staticTexts["这个文件打不开"].exists)

        add(screenshot(named: "document open"))
    }

    /// Rewriting the turn re-sends what it carried, so the document has to come
    /// back on the message the rewind writes. This is the same path the composer
    /// takes when a document is attached and sent, minus the file picker: upload
    /// ids in, a settled turn with the ref out.
    func testRewritingTheTurnKeepsTheDocument() throws {
        let title = try XCTUnwrap(conversation, "set TEST_RUNNER_LUMA_CONVERSATION to run this")
        let app = try signedInApp()

        let row = app.staticTexts[title]
        XCTAssertTrue(row.waitForExistence(timeout: 15), "expected a conversation named \(title)")
        row.tap()

        let chip = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "文档 ")
        ).firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: 20))

        let bubble = app.buttons.containing(
            NSPredicate(format: "label BEGINSWITH %@", "我：")
        ).firstMatch
        bubble.press(forDuration: 1.2)
        let edit = app.buttons["编辑"]
        XCTAssertTrue(edit.waitForExistence(timeout: 10), "a user turn should offer an edit")
        edit.tap()

        let editor = app.textFields["turn.editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        editor.tap()
        editor.typeText("（再问一次）")
        app.buttons["turn.editor.send"].tap()

        let send = app.buttons["composer.send"]
        XCTAssertTrue(waitUntil(120) { send.label == "发送" }, "the rerun should settle")

        XCTAssertTrue(
            waitUntil(20) { chip.exists },
            "the document should survive the rewind rather than being dropped from the re-sent turn"
        )

        add(screenshot(named: "document after rewind"))
    }

    private func waitUntil(_ seconds: TimeInterval, _ condition: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if condition() { return true }
            usleep(300_000)
        }
        return condition()
    }

    private func signedInApp() throws -> XCUIApplication {
        let host = try XCTUnwrap(host, "set TEST_RUNNER_LUMA_HOST to run this")
        let code = try XCTUnwrap(self.code, "set TEST_RUNNER_LUMA_CODE to run this")

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
        accessCode.typeText(code)
        app.buttons["auth.signIn"].tap()

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
