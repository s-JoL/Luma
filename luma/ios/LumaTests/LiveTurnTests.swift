import Testing
@testable import Luma

/// The most valuable test in the suite: it is what keeps the streaming view and
/// the persisted view from drifting. An event stream is replayed frame by frame
/// and the resulting snapshot must equal what `TurnBuilder` produces from the
/// settled messages of the same turn.
@MainActor
struct LiveTurnTests {
    /// The stream for `Fixtures.searchTurn`'s assistant turn, in wire order.
    private static let stream = """
    [
      { "seq": 1, "runId": "r1", "conversationId": "c1", "createdAt": 1,
        "type": "run.started", "data": { "modelId": "m", "model": "M" } },
      { "seq": 2, "runId": "r1", "conversationId": "c1", "createdAt": 2,
        "type": "message.delta",
        "data": { "assistantMessageEvent": { "type": "thinking_delta", "delta": "先查一下。" } } },
      { "seq": 3, "runId": "r1", "conversationId": "c1", "createdAt": 3,
        "type": "message.delta",
        "data": { "assistantMessageEvent": { "type": "text_delta", "delta": "我查" } } },
      { "seq": 4, "runId": "r1", "conversationId": "c1", "createdAt": 4,
        "type": "message.delta",
        "data": { "assistantMessageEvent": { "type": "text_delta", "delta": "一下。" } } },
      { "seq": 5, "runId": "r1", "conversationId": "c1", "createdAt": 5,
        "type": "tool.execution.start",
        "data": { "toolCallId": "call_1", "toolName": "web_search",
                  "args": { "intent": "搜索推荐的采样器", "query": "sampler" } } },
      { "seq": 6, "runId": "r1", "conversationId": "c1", "createdAt": 6,
        "type": "tool.execution.end",
        "data": { "toolCallId": "call_1", "isError": false,
                  "result": { "content": [{ "type": "text", "text": "# Search 1: \\"Sampler\\"\\nAnchor: \\ue202turn0search0\\nURL: https://example.com/a" }] } } },
      { "seq": 7, "runId": "r1", "conversationId": "c1", "createdAt": 7,
        "type": "message.delta",
        "data": { "assistantMessageEvent": { "type": "text_delta", "delta": "用 dpmpp_2m。" } } }
    ]
    """

    @Test("replaying a run produces the same turn the persisted log does")
    func agreesWithTurnBuilder() {
        let live = LiveTurn()
        for event in Fixtures.events(Self.stream) { live.apply(event) }

        let settled = TurnBuilder.build(Fixtures.messages(Fixtures.searchTurn))
        guard let expected = settled.last else {
            Issue.record("no assistant turn in the fixture")
            return
        }
        // Ids and seqs differ by construction — the live turn has no persisted
        // row — so the parts are what must agree.
        #expect(live.snapshot().parts == expected.parts)
    }

    @Test("deltas accumulate into one text part rather than one per token")
    func mergesDeltas() {
        let live = LiveTurn()
        for event in Fixtures.events(Self.stream) { live.apply(event) }

        let texts = live.snapshot().parts.filter { if case .text = $0 { true } else { false } }
        #expect(texts.count == 2, "one before the tool call and one after")
    }

    @Test("a replayed tool call the transcript already shows is not shown twice")
    func skipsKnownToolCalls() {
        let live = LiveTurn(known: ["call_1"])
        for event in Fixtures.events(Self.stream) { live.apply(event) }

        let tools = live.snapshot().parts.filter { if case .tool = $0 { true } else { false } }
        #expect(tools.isEmpty)
    }

    @Test("an approval card is replaced in place by the tool block it gated")
    func approvalBecomesToolBlock() {
        let live = LiveTurn()
        live.apply(type: EventType.messageDelta, data: delta("text_delta", "我来删。"))
        live.apply(type: EventType.approvalRequired, data: approval(status: "pending"))

        #expect(live.snapshot().parts.count == 2)

        live.apply(type: EventType.toolStart, data: .object([
            "toolCallId": .string("call_del"),
            "toolName": .string("delete_path"),
            "args": .object(["intent": .string("删除旧文件")]),
        ]))

        let parts = live.snapshot().parts
        #expect(parts.count == 2, "the card is replaced, not stacked beneath")
        guard case .tool(let tool) = parts[1] else {
            Issue.record("expected the tool block where the card was")
            return
        }
        #expect(tool.callId.raw == "call_del")
    }

    @Test("a resolved approval updates the existing card rather than adding one")
    func approvalResolvesInPlace() {
        let live = LiveTurn()
        live.apply(type: EventType.approvalRequired, data: approval(status: "pending"))
        live.apply(type: EventType.approvalResolved, data: approval(status: "rejected"))

        let parts = live.snapshot().parts
        #expect(parts.count == 1)
        guard case .approval(let card) = parts[0] else {
            Issue.record("expected one approval part")
            return
        }
        #expect(card.status == .rejected)
    }

    @Test("approvals seeded on open behave like replayed ones")
    func seedingIsIdempotent() {
        let card = approval(status: "pending")["approval"]?.decode(Approval.self)
        guard let card else {
            Issue.record("fixture did not decode")
            return
        }
        let live = LiveTurn()
        live.seed(approvals: [card])
        live.apply(type: EventType.approvalRequired, data: approval(status: "pending"))
        #expect(live.snapshot().parts.count == 1, "the replay must not duplicate the seed")
    }

    @Test("a finished generation drops its progress card, because the image follows")
    func succeededJobIsRemoved() {
        let live = LiveTurn()
        live.apply(type: EventType.jobProgress, data: job(status: "running", progress: 0.4))
        #expect(live.snapshot().parts.count == 1)

        live.apply(type: EventType.jobProgress, data: job(status: "succeeded", progress: 1))
        #expect(live.snapshot().parts.isEmpty)
    }

    @Test("a failed message.end sets the turn's error")
    func errorFromMessageEnd() {
        let live = LiveTurn()
        live.apply(type: EventType.messageEnd, data: .object([
            "message": .object([
                "role": .string("assistant"),
                "stopReason": .string("error"),
                "errorMessage": .string("上游返回 429"),
            ]),
        ]))
        #expect(live.snapshot().error == "上游返回 429")
    }

    // MARK: Payload builders

    private func delta(_ kind: String, _ text: String) -> JSONValue {
        .object(["assistantMessageEvent": .object([
            "type": .string(kind), "delta": .string(text),
        ])])
    }

    private func approval(status: String) -> JSONValue {
        .object(["approval": .object([
            "id": .string("call_del"),
            "runId": .string("r1"),
            "conversationId": .string("c1"),
            "toolName": .string("delete_path"),
            "action": .string("delete"),
            "summary": .string("删除 notes.md（2 KB）"),
            "detail": .object(["path": .string("notes.md")]),
            "status": .string(status),
            "createdAt": .number(1),
            "updatedAt": .number(1),
        ])])
    }

    private func job(status: String, progress: Double) -> JSONValue {
        .object([
            "id": .string("job_1"),
            "kind": .string("image"),
            "modelId": .string("m"),
            "modelName": .string("Lustify"),
            "status": .string(status),
            "progress": .number(progress),
            "assets": .array([]),
            "createdAt": .number(1),
        ])
    }
}
