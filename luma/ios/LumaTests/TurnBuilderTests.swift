import Testing
@testable import Luma

struct TurnBuilderTests {
    @Test("text, tool and more text fold into one assistant turn")
    func foldsAcrossModelCalls() {
        let turns = TurnBuilder.build(Fixtures.messages(Fixtures.searchTurn))

        #expect(turns.count == 2)
        #expect(turns[0].role == .user)
        #expect(turns[1].role == .assistant)
        // thinking, text, tool, text — one turn, not two.
        #expect(turns[1].parts.count == 4)
        #expect(turns[1].seq == 2, "the rewind point is the turn's first message")
    }

    @Test("the encrypted reasoning blob never reaches a thinking part")
    func stripsReasoningMarker() {
        let turns = TurnBuilder.build(Fixtures.messages(Fixtures.searchTurn))
        guard case .thinking(let text) = turns[1].parts[0] else {
            Issue.record("expected a thinking part first")
            return
        }
        #expect(text == "先查一下。")
    }

    @Test("a tool result settles its call by id, however much later it arrives")
    func settlesToolByCallId() {
        let turns = TurnBuilder.build(Fixtures.messages(Fixtures.searchTurn))
        guard case .tool(let tool) = turns[1].parts[2] else {
            Issue.record("expected a tool part")
            return
        }
        #expect(tool.callId.raw == "call_1")
        #expect(tool.running == false)
        #expect(tool.isError == false)
        #expect(tool.result.contains("Search 1"))
        #expect(tool.args["intent"]?.stringValue == "搜索推荐的采样器")
    }

    @Test("a picture the model also embedded in prose is shown once")
    func deduplicatesImages() {
        let turns = TurnBuilder.build(Fixtures.messages(Fixtures.imageTurn))
        let assistant = turns[1]
        let images = assistant.parts.filter { if case .image = $0 { true } else { false } }
        #expect(images.isEmpty, "the standalone copy goes when the prose references it")
        #expect(assistant.plainText.contains("image://img_0123456789abcdef0123456789abcdef"))
    }

    @Test("a failed turn carries the provider's message")
    func errorTurn() {
        let turns = TurnBuilder.build(Fixtures.messages(Fixtures.failedTurn))
        #expect(turns[1].error == "上游返回 429")
    }

    /// The one part a user message can carry that the transcript cannot infer
    /// from anything else. Dropped, the settled turn shows a question about an
    /// attachment with no attachment in sight.
    @Test("a document attached to a message survives into the turn")
    func keepsDocumentRefs() {
        let turns = TurnBuilder.build(Fixtures.messages(Fixtures.documentTurn))
        #expect(turns.count == 1)
        #expect(turns[0].parts.count == 2)
        guard case .file(let id, let name, let bytes) = turns[0].parts[1] else {
            Issue.record("expected the attachment to follow the question")
            return
        }
        #expect(id.raw == "file_e55e0123456789abcdef0123456789ab")
        #expect(name == "report.txt")
        #expect(bytes == 32)
    }

    /// Edit and regenerate re-send `attachmentIds`, so a document missing from
    /// it is a document the rewound turn silently loses.
    @Test("a document is re-sent when the turn is rewritten")
    func documentIsAnAttachment() {
        let turns = TurnBuilder.build(Fixtures.messages(Fixtures.documentTurn))
        #expect(turns[0].attachmentIds == ["file_e55e0123456789abcdef0123456789ab"])
    }

    @Test("an unknown content part is dropped rather than thrown")
    func ignoresUnknownParts() {
        let turns = TurnBuilder.build(Fixtures.messages(Fixtures.unknownPart))
        #expect(turns.count == 1)
        #expect(turns[0].parts.count == 1)
        #expect(turns[0].plainText == "前后", "adjacent text merges across the dropped part")
    }

    @Test("citations resolve from tool output alone")
    func collectsCitations() {
        let turns = TurnBuilder.build(Fixtures.messages(Fixtures.searchTurn))
        let citations = Citations.collect(from: turns)
        #expect(citations.count == 1)
        #expect(citations.values.first?.url?.absoluteString == "https://example.com/a")
    }

    @Test("tool call ids are what a reattaching client passes to the live turn")
    func exposesToolCallIds() {
        let turns = TurnBuilder.build(Fixtures.messages(Fixtures.searchTurn))
        #expect(turns.toolCallIds == ["call_1"])
    }
}
