import XCTest

/// A clip is the one thing in this app that cannot be checked by reading the
/// code: `AVPlayer` fetches on its own, and a missing bearer token shows up as a
/// black rectangle rather than as anything the app can catch. So this plays a
/// real video off a real server and asserts the player did not give up.
///
/// Skipped when the library has no video, like every other live test here is
/// skipped without a server.
@MainActor
final class VideoTests: XCTestCase {
    private var host: String? { ProcessInfo.processInfo.environment["LUMA_HOST"] }
    private var code: String? { ProcessInfo.processInfo.environment["LUMA_CODE"] }

    override func setUp() {
        continueAfterFailure = false
    }

    func testAVideoInTheLibraryPlays() throws {
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

        XCTAssertTrue(app.tabBars.buttons["文件"].waitForExistence(timeout: 20))
        app.tabBars.buttons["文件"].tap()
        XCTAssertTrue(app.navigationBars["文件"].waitForExistence(timeout: 10))

        let videosFilter = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "视频")
        ).firstMatch
        XCTAssertTrue(videosFilter.waitForExistence(timeout: 10))
        videosFilter.tap()

        let row = app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", ".mp4")
        ).firstMatch
        guard row.waitForExistence(timeout: 5) else {
            throw XCTSkip("no video in this library to play")
        }
        row.tap()

        // The close button is the player's, so its arrival is the cover opening.
        XCTAssertTrue(app.buttons["关闭"].waitForExistence(timeout: 10))

        // A refused fetch settles into this within a second or two; giving it
        // five means a pass is the player really having decoded something.
        Thread.sleep(forTimeInterval: 5)
        XCTAssertFalse(
            app.staticTexts["这个视频打不开"].exists,
            "the clip must play, which it only can if the bearer token reached AVFoundation"
        )

        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "video-playing"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
