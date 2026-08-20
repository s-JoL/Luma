import Testing
@testable import Luma

/// The frame boundary, which is the part that was silently wrong. Reading the
/// stream with `AsyncLineSequence` looked correct and compiled, but that sequence
/// drops empty lines — and the empty line is the *only* thing that ends an SSE
/// frame. Nothing was ever dispatched, so every run showed no text at all until
/// it finished and the transcript was re-read from the message log. Hence a test
/// on the boundary rather than only on the field parsing.
struct SSEParserTests {
    /// Feeds a whole stream through byte by byte, exactly as the reader does.
    private func frames(_ text: String) -> [SSEFrame] {
        var parser = SSEParser()
        var out: [SSEFrame] = []
        for byte in Array(text.utf8) {
            if let frame = parser.consume(byte) { out.append(frame) }
        }
        return out
    }

    @Test("a blank line ends a frame")
    func frameBoundary() {
        let out = frames(
            "event: message.delta\ndata: {\"seq\":1}\n\n"
                + "event: message.delta\ndata: {\"seq\":2}\n\n"
        )
        #expect(out.count == 2)
        #expect(out.map(\.event) == ["message.delta", "message.delta"])
        #expect(out.map(\.data) == ["{\"seq\":1}", "{\"seq\":2}"])
    }

    @Test("frames arrive one at a time rather than all at the end")
    func incremental() {
        var parser = SSEParser()
        var delivered = 0
        var seenAfterFirstFrame = 0
        for byte in Array("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n".utf8) {
            if parser.consume(byte) != nil {
                delivered += 1
                if delivered == 1 { seenAfterFirstFrame = 0 }
            } else if delivered == 1 {
                seenAfterFirstFrame += 1
            }
        }
        #expect(delivered == 2)
        // The first frame landed while the second was still being read, which is
        // the whole point: a stream that only dispatches at the end is a batch.
        #expect(seenAfterFirstFrame > 0)
    }

    @Test("an id line is ignored and does not become part of the payload")
    func ignoresId() {
        let out = frames("event: run.started\ndata: {}\nid: 7\n\n")
        #expect(out.count == 1)
        #expect(out[0].event == "run.started")
        #expect(out[0].data == "{}")
    }

    @Test("several data lines in one frame are joined with newlines")
    func multiLineData() {
        let out = frames("data: one\ndata: two\n\n")
        #expect(out.count == 1)
        #expect(out[0].data == "one\ntwo")
        #expect(out[0].event == "message")
    }

    @Test("CRLF line endings end lines and frames exactly once")
    func carriageReturns() {
        let out = frames("event: a\r\ndata: 1\r\n\r\nevent: b\r\ndata: 2\r\n\r\n")
        #expect(out.map(\.event) == ["a", "b"])
        #expect(out.map(\.data) == ["1", "2"])
    }

    @Test("a heartbeat with an empty payload still arrives, because it proves the connection is alive")
    func heartbeat() {
        let out = frames("event: heartbeat\ndata: \n\n")
        #expect(out.count == 1)
        #expect(out[0].event == "heartbeat")
        #expect(out[0].data.isEmpty)
    }

    @Test("a comment keeps the connection warm without producing a frame")
    func comment() {
        let out = frames(": ping\n\nevent: a\ndata: 1\n\n")
        #expect(out.map(\.event) == ["a"])
    }

    @Test("a partial frame is held until its blank line arrives")
    func partialFrameIsNotDispatched() {
        var parser = SSEParser()
        var out: [SSEFrame] = []
        for byte in Array("event: a\ndata: {\"half\":".utf8) {
            if let frame = parser.consume(byte) { out.append(frame) }
        }
        #expect(out.isEmpty)
        // The rest of the same line, so the payload is one field rather than two.
        for byte in Array("true}\n\n".utf8) {
            if let frame = parser.consume(byte) { out.append(frame) }
        }
        #expect(out.count == 1)
        #expect(out[0].data == "{\"half\":true}")
    }

    @Test("multi-byte characters survive being split across the buffer")
    func utf8() {
        let out = frames("event: message.delta\ndata: {\"delta\":\"潮汐\"}\n\n")
        #expect(out.count == 1)
        #expect(out[0].data == "{\"delta\":\"潮汐\"}")
    }
}
