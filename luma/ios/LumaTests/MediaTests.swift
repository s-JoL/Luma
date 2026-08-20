import Foundation
import Testing
@testable import Luma

/// A player fetches media itself, so the token has to leave `APIClient` as a
/// value. Getting this wrong is invisible until a video is tapped and the server
/// answers `401`.
struct MediaTests {
    private let client = APIClient(base: URL(string: "http://mac.local:8090/v1")!, token: "tok_1")

    @Test("a clip's address hangs off the same /v1 root as everything else")
    func videoURL() async throws {
        let source = try await client.mediaSource(.video(VideoId("vid_9")))
        #expect(source.url.absoluteString == "http://mac.local:8090/v1/videos/vid_9")
    }

    @Test("the bearer token travels with the clip")
    func videoCarriesTheToken() async throws {
        let source = try await client.mediaSource(.video(VideoId("vid_9")))
        #expect(source.headers["Authorization"] == "Bearer tok_1")
    }

    /// Signed out there is nothing to send, and an empty `Authorization` header
    /// is a different request from no header at all.
    @Test("no token means no header rather than an empty one")
    func anonymousCarriesNothing() async throws {
        let anonymous = APIClient(base: URL(string: "http://mac.local:8090/v1")!, token: nil)
        let source = try await anonymous.mediaSource(.video(VideoId("vid_9")))
        #expect(source.headers["Authorization"] == nil)
    }
}

/// The transcript says what the stream is doing only when that is not the
/// ordinary thing, because a notice on every run is a notice nobody reads.
@MainActor
struct ConnectionNoticeTests {
    @Test("a working run says nothing")
    func quietWhenOrdinary() {
        #expect(TranscriptStore.Connection.idle.notice == nil)
        #expect(TranscriptStore.Connection.streaming.notice == nil)
    }

    @Test("a dropped or backgrounded stream is announced")
    func announcesTheRest() {
        #expect(TranscriptStore.Connection.reconnecting(attempt: 1).notice != nil)
        #expect(TranscriptStore.Connection.polling.notice != nil)
    }
}
