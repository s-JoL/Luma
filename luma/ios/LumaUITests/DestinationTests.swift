import XCTest

/// Walks the five destinations after a live sign-in. The long streaming capture
/// lives in GalleryTests; this is the peer-of-Web check: every tab the web has
/// is a real screen, not a placeholder, and the composer can attach a file.
@MainActor
final class DestinationTests: XCTestCase {
    private var host: String? { ProcessInfo.processInfo.environment["LUMA_HOST"] }
    private var code: String? { ProcessInfo.processInfo.environment["LUMA_CODE"] }

    override func setUp() {
        continueAfterFailure = false
    }

    func testEveryTabIsARealScreen() throws {
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

        XCTAssertTrue(app.tabBars.buttons["对话"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.navigationBars["对话"].waitForExistence(timeout: 20))
        capture("chat", app)

        app.buttons["新对话"].firstMatch.tap()
        XCTAssertTrue(app.textFields["composer.text"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["composer.attach"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["composer.attach"].isEnabled)
        capture("composer", app)
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.navigationBars["对话"].waitForExistence(timeout: 10))

        app.tabBars.buttons["创作台"].tap()
        XCTAssertTrue(app.navigationBars["创作台"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["还在做"].exists)
        _ = app.staticTexts["提示词"].waitForExistence(timeout: 10)
        capture("studio", app)
        app.swipeUp()
        Thread.sleep(forTimeInterval: 1.6)
        capture("studio-gallery", app)

        app.tabBars.buttons["文件"].tap()
        XCTAssertTrue(app.navigationBars["文件"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["还在做"].exists)
        capture("files", app)

        app.tabBars.buttons["记忆"].tap()
        XCTAssertTrue(app.navigationBars["记忆"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["还在做"].exists)
        capture("memory", app)

        app.tabBars.buttons["设置"].tap()
        XCTAssertTrue(app.navigationBars["设置"].waitForExistence(timeout: 10))
        capture("settings", app)
        app.staticTexts["对话模型"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["对话模型"].waitForExistence(timeout: 10))
        capture("settings-models", app)
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.navigationBars["设置"].waitForExistence(timeout: 10))

        // The security screen reads `GET /security`, so an empty one means the
        // request failed rather than that the deployment has nothing to show:
        // this device's own session is always in the list.
        app.staticTexts["安全"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["安全"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["当前设备"].waitForExistence(timeout: 15))
        capture("settings-security", app)
    }

    private func capture(_ name: String, _ app: XCUIApplication) {
        Thread.sleep(forTimeInterval: 0.6)
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
