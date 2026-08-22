import Foundation
import Observation

/// One open conversation. The only thing that appends to `turns`: the event
/// stream hands it events and it decides what they mean.
///
/// Two cursors, and confusing them is the classic bug here. `messageSeq` walks
/// the message log and drives `?after=` on `/messages`; `eventSeq` walks the run's
/// event log and drives `?after=` on `/runs/:id/events`. They are different
/// counters over different tables.
@MainActor
@Observable
final class TranscriptStore {
    let id: ConversationId

    private(set) var turns: [Turn] = []
    /// The streaming turn, republished at 20 Hz rather than on every delta.
    private(set) var live: Turn?
    /// Whether there *is* a streaming turn, as a property of its own.
    ///
    /// Observation invalidates a view when a property it read changes, so any
    /// view that asked `live != nil` was rebuilt twenty times a second for the
    /// length of a run — including the one holding the `ForEach` over every
    /// settled turn, which then deep-compared each of them against an identical
    /// copy. The whole transcript was being re-diffed to answer a question whose
    /// answer changes twice per run. This is that question, stored separately so
    /// asking it is free.
    private(set) var hasLive = false
    /// Bumped once per published frame. The tail-follower watches this instead of
    /// `live` so that following the stream costs an integer comparison rather
    /// than a deep comparison of the whole turn.
    private(set) var liveTick = 0
    private(set) var citations = CitationIndex()

    private(set) var title: String = ""
    private(set) var modelId: ModelId?
    private(set) var isLoading = false
    private(set) var isPagingBack = false
    private(set) var hasMoreHistory = false
    private(set) var isRunning = false
    private(set) var connection: Connection = .idle
    private(set) var error: String?

    /// Shown immediately so the send tap feels instant, replaced by the persisted
    /// user message when the transcript is topped up.
    private(set) var pending: PendingSend?

    enum Connection: Equatable {
        case idle
        case streaming
        case reconnecting(attempt: Int)
        case polling

        /// What to tell the reader, or nothing. Streaming is what a working run
        /// looks like and idle is no run at all, so neither is worth a word; the
        /// other two are the states where the app is doing something the screen
        /// would otherwise not account for.
        var notice: String? {
            switch self {
            case .idle, .streaming: nil
            case .reconnecting: "正在重连…"
            case .polling: "正在同步"
            }
        }
    }

    struct PendingSend: Equatable {
        let text: String
        let attachments: [String]
        var failed: Bool = false
        /// The message watermark when this was sent. The persisted copy is the
        /// first user message to appear above it.
        var afterSeq: Int = -1
    }

    /// The tail-follow target of last resort, when there is no turn to aim at.
    static let bottomAnchor = "transcript.bottom"

    /// What to scroll to when following the tail. **Not the sentinel.** The
    /// bottom anchor is a 1pt view at the end of a `LazyVStack`, and a lazy stack
    /// does not create views far outside the visible range — so with the keyboard
    /// up and 140pt of answer hidden behind it, scrolling to it was asking for an
    /// id that did not exist yet and silently did nothing. The last *turn* is a
    /// large, realised view, and anchoring to its bottom lands in the same place.
    ///
    /// Read from event handlers rather than from a body, which is what keeps it
    /// off the dependency graph despite touching two observed properties.
    var tailId: String {
        if hasLive { return Turn.liveId }
        return turns.last?.id ?? Self.bottomAnchor
    }

    private let api: APIClient
    private weak var app: AppModel?

    private var messageSeq = -1
    private var earliestSeq: Int?
    private var eventSeq = 0
    private var runId: RunId?

    private var liveTurn: LiveTurn?
    private var follower: Task<Void, Never>?
    private var publisher: Task<Void, Never>?
    private var background: Task<Void, Never>?
    /// Set by an applied event, cleared by the tick that publishes it.
    private var dirty = false

    init(id: ConversationId, api: APIClient, app: AppModel?) {
        self.id = id
        self.api = api
        self.app = app
    }

    /// Called when the LRU evicts this store. There is no `deinit` counterpart
    /// because a `deinit` cannot touch main-actor state; both tasks capture
    /// `self` weakly, so a dropped store's loops fall out on their own.
    func detach() {
        follower?.cancel()
        follower = nil
        publisher?.cancel()
        publisher = nil
        background?.cancel()
        background = nil
    }

    // MARK: Opening

    /// The four calls that make an open correct, in order. The third matters
    /// most: the approval row is the truth, not the stream, and a
    /// client that was closed when the question was asked has nothing to replay.
    func open() async {
        guard turns.isEmpty, !isLoading else { return }
        isLoading = true
        defer { isLoading = false }

        do {
            async let detail = api.send(.conversation(id), as: ConversationDetail.self)
            async let page = api.send(.messages(id, limit: 60), as: Page<StoredMessage>.self)
            async let approvals = api.send(.approvals(id), as: Page<Approval>.self)

            let conversation = try await detail
            title = conversation.title
            modelId = conversation.modelId

            let messages = try await page
            apply(messages, replacing: true)

            let pendingApprovals = (try? await approvals)?.items ?? []

            if let run = conversation.activeRun, !run.status.isTerminal {
                // The server's own `resumeSeq`, not a number derived from the
                // messages just read: it knows which events it has persisted, and
                // a client that guesses either replays or skips.
                startLive(known: turns.toolCallIds, seeding: pendingApprovals)
                follow(run: run.id, after: run.resumeSeq)
            } else if !pendingApprovals.isEmpty {
                startLive(known: turns.toolCallIds, seeding: pendingApprovals)
                publishNow()
            }
            error = nil
        } catch let failure as APIError {
            error = failure.display
            app?.handle(failure)
        } catch {
            self.error = "打不开这个对话"
        }
    }

    /// Pull to refresh, and the recovery path after a dropped stream: re-read
    /// from the last known seq and never clear what is on screen unless the
    /// re-read succeeded.
    ///
    /// Reports whether the read succeeded, which is not the same question as
    /// whether anything came back: `settle` has to know the difference, because
    /// it is about to drop the live turn on the strength of it.
    @discardableResult
    func topUp() async -> Bool {
        do {
            let page = try await api.send(.messages(id, after: messageSeq), as: Page<StoredMessage>.self)
            apply(page, replacing: false)
            return true
        } catch let failure as APIError where failure.signsOut {
            app?.handle(failure)
            return false
        } catch {
            // Keep the transcript; the next reconnect tries again.
            return false
        }
    }

    /// Loading the page before the one on screen. The view captures its top
    /// visible turn before this lands so the prepend does not jump.
    func pageBack() async {
        guard !isPagingBack, hasMoreHistory, let before = earliestSeq else { return }
        isPagingBack = true
        defer { isPagingBack = false }

        do {
            let page = try await api.send(.messages(id, limit: 60, before: before), as: Page<StoredMessage>.self)
            guard !page.items.isEmpty else {
                hasMoreHistory = false
                return
            }
            let older = TurnBuilder.build(page.items)
            let known = Set(turns.map(\.id))
            turns = older.filter { !known.contains($0.id) } + turns
            earliestSeq = page.items.map(\.seq).min()
            hasMoreHistory = page.nextCursor != nil
            citations = CitationIndex(Citations.collect(from: turns))
            MarkdownCache.warm(older, citations: citations)
        } catch {
            // Leave `hasMoreHistory` set so scrolling up tries again.
        }
    }

    private func apply(_ page: Page<StoredMessage>, replacing: Bool) {
        guard !page.items.isEmpty || replacing else { return }

        if replacing {
            turns = TurnBuilder.build(page.items)
            earliestSeq = page.items.map(\.seq).min()
            hasMoreHistory = page.nextCursor != nil
        } else {
            // A top-up returns whole messages, and a turn can span several, so
            // the tail is rebuilt rather than appended to: the last assistant
            // turn may need to absorb the new rows.
            let rebuilt = TurnBuilder.build(page.items)
            merge(rebuilt)
        }
        messageSeq = max(messageSeq, page.items.map(\.seq).max() ?? messageSeq)
        citations = CitationIndex(Citations.collect(from: turns))
        // Parse the prose the reader has not scrolled to yet, off the main
        // thread, before they do. A block parsed on first sight is parsed during
        // the scroll that revealed it.
        MarkdownCache.warm(turns, citations: citations)
        dropPendingOncePersisted()
        // Sequence numbers are dense from zero within a conversation, so the
        // highest one seen is the count. Told to the list here because this is
        // the only place that learns it — the row it came with was a snapshot
        // from whenever the list was last read.
        app?.conversations.setMessageCount(messageSeq + 1, for: id)
    }

    /// The optimistic bubble goes when the real one takes its place, and not
    /// before. Matching on "a user turn newer than the watermark at send time"
    /// rather than on the text keeps a repeated question from clearing the
    /// bubble for the copy already on screen.
    private func dropPendingOncePersisted() {
        guard let pending, !pending.failed else { return }
        let persisted = turns.contains { $0.role == .user && $0.seq > pending.afterSeq }
        if persisted { self.pending = nil }
    }

    /// A top-up's first turn continues the transcript's last one when both are
    /// assistant turns, because the server split them across two messages of one
    /// turn rather than starting a new one.
    private func merge(_ incoming: [Turn]) {
        var incoming = incoming
        if let first = incoming.first, first.role == .assistant,
           let lastIndex = turns.indices.last, turns[lastIndex].role == .assistant,
           turns[lastIndex].isLive == false, first.id == turns[lastIndex].id {
            turns[lastIndex].parts = first.parts
            turns[lastIndex].error = first.error
            incoming.removeFirst()
        }
        let known = Set(turns.map(\.id))
        turns += incoming.filter { !known.contains($0.id) }
    }

    // MARK: Sending

    var canSend: Bool { !isRunning && pending == nil }

    func send(text: String, attachments: [String] = []) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty else { return }

        // While a run is active, sending steers it instead of starting a second.
        if isRunning {
            await steer(text: trimmed)
            return
        }

        pending = PendingSend(text: trimmed, attachments: attachments, afterSeq: messageSeq)
        let input = RunInput(text: trimmed, attachments: attachments)
        await start(input, key: APIClient.idempotencyKey())
    }

    /// Edit and regenerate both rewind. Because a rewind reuses sequence numbers,
    /// the transcript is refetched from the tail afterwards rather than topped
    /// up — topping up is how a client ends up showing two versions of one turn.
    func rerun(text: String, fromSeq: Int, attachments: [String] = []) async {
        // The rewind puts the new user message back at `fromSeq`, so anything at
        // or after it is the replacement rather than the copy being replaced.
        pending = PendingSend(text: text, attachments: attachments, afterSeq: fromSeq - 1)
        let input = RunInput(text: text, attachments: attachments, fromSeq: fromSeq)
        await start(input, key: APIClient.idempotencyKey(), rewound: true)
    }

    /// Sends the original question again, rewound to where it was asked. There is
    /// no branch: the transcript is the agent's only memory, and a hidden second
    /// history would drift from what the reader sees.
    func regenerate(_ turn: Turn) async {
        guard turn.role == .assistant,
              let index = turns.firstIndex(where: { $0.id == turn.id }), index > 0
        else { return }
        let question = turns[index - 1]
        guard question.role == .user else { return }
        await rerun(
            text: question.plainText,
            fromSeq: question.seq,
            attachments: question.attachmentIds
        )
    }

    /// What regenerating this turn would discard, so the confirmation can say so
    /// rather than warning in the abstract.
    func turnsAfter(_ turn: Turn) -> Int {
        guard let index = turns.firstIndex(where: { $0.id == turn.id }) else { return 0 }
        return max(0, turns.count - index - 1)
    }

    private func start(_ input: RunInput, key: String, rewound: Bool = false) async {
        do {
            let accepted = try await api.send(.run(id, input, key: key), as: RunAccepted.self)
            if rewound { await refetchAfterRewind() }
            // `pending` deliberately stays. It is the reader's own message, and
            // the persisted copy does not arrive until the next top-up — which,
            // for a run that takes a minute, is a minute of the transcript not
            // showing the question that started it.
            startLive(known: turns.toolCallIds, seeding: [])
            follow(run: accepted.runId, after: accepted.seq)
            app?.conversations.touch(id)
        } catch let failure as APIError {
            if failure.isRunActive {
                // Not an error to show: something else already started this run.
                pending = nil
                await open()
                return
            }
            pending?.failed = true
            error = failure.display
            app?.handle(failure)
        } catch {
            pending?.failed = true
        }
    }

    /// `after=-1` rather than the tail page an open uses. A rewind reuses
    /// sequence numbers, so every cursor this store holds is now about messages
    /// that no longer exist; asking for everything from the start is the only
    /// read that cannot come back interleaved with the version being replaced.
    private func refetchAfterRewind() async {
        turns = []
        messageSeq = -1
        earliestSeq = nil
        do {
            let page = try await api.send(.messages(id, after: -1), as: Page<StoredMessage>.self)
            apply(page, replacing: true)
        } catch {
            self.error = "重新载入对话失败，下拉可以再试一次"
        }
    }

    func stop() async {
        guard isRunning else { return }
        do {
            try await api.send(.stop(id))
        } catch let failure as APIError {
            guard !failure.isNoActiveRun else { return }
            app?.handle(failure)
        } catch {}
    }

    func steer(text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        do {
            try await api.send(.steer(id, text: trimmed))
        } catch let failure as APIError {
            app?.handle(failure)
        } catch {}
    }

    func continueRun() async {
        do {
            let accepted = try await api.send(
                .continueRun(id, key: APIClient.idempotencyKey()), as: RunAccepted.self
            )
            startLive(known: turns.toolCallIds, seeding: [])
            follow(run: accepted.runId, after: accepted.seq)
        } catch let failure as APIError {
            app?.handle(failure)
        } catch {}
    }

    func rename(to title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != self.title else { return }
        let previous = self.title
        self.title = trimmed
        do {
            try await app?.conversations.rename(id, to: trimmed)
        } catch {
            self.title = previous
        }
    }

    func setModel(_ model: ModelId) async {
        let previous = modelId
        modelId = model
        do {
            try await api.send(.setConversationModel(id, modelId: model))
        } catch let failure as APIError {
            modelId = previous
            app?.handle(failure)
        } catch {
            modelId = previous
        }
    }

    // MARK: Approvals

    /// Posts, then waits for `tool.approval.resolved` to repaint rather than
    /// assuming its own optimistic state, so two devices watching the same run
    /// agree.
    func decide(_ approval: Approval, approved: Bool) async {
        do {
            try await api.send(.decideApproval(approval.id, approved: approved))
        } catch let failure as APIError {
            app?.handle(failure)
        } catch {}
    }

    // MARK: Following a run

    private func startLive(known: Set<String>, seeding approvals: [Approval]) {
        let turn = LiveTurn(known: known)
        turn.seed(approvals: approvals)
        liveTurn = turn
        // An empty live turn has to stay `nil`. The transcript reads a non-nil
        // `live` as "the answer has started" and hides the thinking indicator on
        // that basis, so publishing an empty one left the reader with no sign at
        // all for the whole of the model's first-token latency — which on a
        // reasoning model is the several seconds most in need of one.
        setLive(turn.isEmpty ? nil : turn.snapshot())
    }

    func follow(run: RunId, after: Int) {
        follower?.cancel()
        runId = run
        eventSeq = after
        isRunning = true
        app?.conversations.setRunning(true, for: id)

        follower = Task { [weak self] in
            await self?.followLoop(run)
        }
    }

    private func followLoop(_ run: RunId) async {
        var attempt = 0

        while !Task.isCancelled {
            connection = attempt == 0 ? .streaming : .reconnecting(attempt: attempt)
            let outcome = await readStream(run)

            switch outcome {
            case .settled:
                await settle(stopFollowing: false)
                return
            case .cancelled:
                return
            case .dropped:
                guard !Task.isCancelled else { return }
                // A dropped stream is not a failed run. Check whether it settled
                // while the connection was down before backing off again.
                if await runHasSettled(run) {
                    await settle(stopFollowing: false)
                    return
                }
                attempt += 1
                try? await Task.sleep(for: Backoff.delay(attempt: attempt - 1))
            }
        }
    }

    private enum Outcome { case settled, dropped, cancelled }

    /// Reads frames, with a watchdog racing alongside. The server heartbeats
    /// every 15 s, so 45 s of silence means the connection is dead in a way TCP
    /// will not report for minutes — a cellular NAT dropping the flow looks
    /// exactly like a model thinking. Whichever finishes first wins and the other
    /// is cancelled.
    private func readStream(_ run: RunId) async -> Outcome {
        let endpoint = Endpoint.events(run, after: eventSeq, poll: false)
        let clock = FrameClock()

        let reader = Task { @MainActor [weak self] () -> Outcome in
            guard let self else { return .cancelled }
            return await self.consume(endpoint, clock: clock)
        }
        let watchdog = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard !Task.isCancelled else { return }
                if await clock.isStale(for: Backoff.watchdog) {
                    await clock.markTimedOut()
                    reader.cancel()
                    return
                }
            }
        }

        let outcome = await withTaskCancellationHandler {
            await reader.value
        } onCancel: {
            reader.cancel()
        }
        watchdog.cancel()

        // A read the watchdog killed reports `cancelled`, but it is a dead
        // connection rather than a deliberate stop, so the loop must reconnect.
        return await clock.didTimeOut() ? .dropped : outcome
    }

    private func consume(_ endpoint: Endpoint, clock: FrameClock) async -> Outcome {
        do {
            for try await frame in api.frames(endpoint) {
                if Task.isCancelled { return .cancelled }
                await clock.beat()
                guard frame.event != "heartbeat", !frame.data.isEmpty else { continue }
                guard let data = frame.data.data(using: .utf8),
                      let event = try? JSON.decode(StoredEvent.self, from: data)
                else { continue }

                if ingest(event) { return .settled }
            }
        } catch {
            return Task.isCancelled ? .cancelled : .dropped
        }
        return Task.isCancelled ? .cancelled : .dropped
    }

    /// Applies one event and reports whether the run is over. Every transition is
    /// keyed on `seq`: an event already applied is dropped, which is what makes
    /// replay safe and the poll and SSE paths interchangeable.
    @discardableResult
    private func ingest(_ event: StoredEvent) -> Bool {
        guard event.seq > eventSeq else { return EventType.terminal.contains(event.type) }
        eventSeq = event.seq

        switch event.type {
        case EventType.conversationTitle:
            let text = event.data.text("title")
            if !text.isEmpty {
                title = text
                app?.conversations.applyTitle(text, to: id)
            }
        case EventType.runFailed:
            let message = event.data.text("message")
            if !message.isEmpty { error = message }
        default:
            liveTurn?.apply(event)
        }

        if EventType.terminal.contains(event.type) { return true }
        schedulePublish()
        return false
    }

    // MARK: Leaving and returning

    /// iOS suspends the app a few seconds after it leaves the screen and kills
    /// the socket with it. The app does not fight that: it drops the stream on
    /// purpose, asks for a short extension, and long-polls instead — a poll is a
    /// request that either answers or does not, which is a far better shape for
    /// a connection about to be frozen than a socket mid-frame.
    func enterBackground() {
        guard isRunning, let run = runId else { return }
        follower?.cancel()
        follower = nil
        publisher?.cancel()
        publisher = nil
        connection = .polling

        background?.cancel()
        background = Task { [weak self] in
            await self?.pollWhileAway(run)
        }
    }

    private func pollWhileAway(_ run: RunId) async {
        let activity = BackgroundActivity(name: "luma.run.\(run.raw)")
        defer { activity.end() }

        // The server holds each poll for up to 25 s, so two cycles is already
        // more background time than iOS usually grants.
        let deadline = ContinuousClock.now + .seconds(50)
        while !Task.isCancelled, isRunning, ContinuousClock.now < deadline {
            do {
                let batch = try await api.poll(run, after: eventSeq)
                var settled = false
                for event in batch.events where ingest(event) { settled = true }
                publishNow()
                if settled || batch.done {
                    await settle()
                    return
                }
            } catch {
                // Suspended mid-request, or the network went away with the
                // screen. Either way the cursor is intact and the next
                // foreground catches up.
                return
            }
        }
    }

    /// Coming back. One poll closes the gap in a single round trip, and only
    /// then is a stream reopened — never from the background, where it would be
    /// killed mid-frame and the reconnect would race the suspend.
    ///
    /// A conversation with no active run is topped up too. A run may have
    /// finished while the app was away, or the same conversation may have moved
    /// on in the browser, and returning to a transcript that silently disagrees
    /// with the server is worse than a moment's loading.
    func enterForeground() async {
        background?.cancel()
        background = nil

        guard isRunning, let run = runId else {
            await topUp()
            return
        }

        await catchUp()
        if isRunning {
            follow(run: run, after: eventSeq)
        }
    }

    /// One poll cycle, used when the app returns to the foreground and when the
    /// stream died: it catches up in a single round trip before a stream is
    /// reopened.
    func catchUp() async {
        guard let run = runId, isRunning else { return }
        connection = .polling
        do {
            let batch = try await api.poll(run, after: eventSeq)
            var settled = false
            for event in batch.events where ingest(event) { settled = true }
            publishNow()
            if settled || batch.done { await settle() }
        } catch {
            // The reconnect below will try again.
        }
    }

    private func runHasSettled(_ run: RunId) async -> Bool {
        guard let status = try? await api.send(.runStatus(run), as: RunSummary.self) else { return false }
        return status.status.isTerminal
    }

    /// The stream is an optimisation; the transcript is the truth. Settling
    /// always ends with a top-up and dropping the live turn.
    ///
    /// - Parameter stopFollowing: `false` when this is called from inside the
    ///   follow loop, which is the usual case. Cancelling the task that is
    ///   executing this function makes the top-up below fail with
    ///   `URLError.cancelled` before it reaches the server — and since the top-up
    ///   is what turns the live turn into persisted turns, the finished answer
    ///   vanishes the instant the run completes. It only looked like it worked
    ///   because a re-run of the same prompt leaves an identical answer already
    ///   on screen from last time.
    private func settle(stopFollowing: Bool = true) async {
        if stopFollowing { follower?.cancel() }
        follower = nil
        publisher?.cancel()
        publisher = nil

        // The top-up is what turns the live turn into a persisted one, so a
        // failed read must be retried before the live turn is dropped — dropping
        // it first is the one way settling can lose an answer the reader watched
        // arrive. Retrying the same idempotent read cannot duplicate anything.
        let watched = live
        if await topUp() == false, watched?.parts.isEmpty == false {
            try? await Task.sleep(for: .milliseconds(500))
            await topUp()
        }

        isRunning = false
        runId = nil
        connection = .idle
        liveTurn = nil
        setLive(nil)
        app?.conversations.setRunning(false, for: id)
        Haptics.settled()

        // A haptic is only felt by someone holding the phone with the app open.
        // A run that finished while it was in a pocket is the case worth telling
        // them about, and `Notifier` decides which of the two this is.
        let failed = error != nil
        let title = self.title
        Task { await Notifier.runFinished(title: title, failed: failed) }

        // A run that stopped to ask something leaves the question in the inbox,
        // and this is the moment the inbox is out of date.
        Task { [weak app] in await app?.approvals.refresh() }
    }

    // MARK: Publishing at 20 Hz

    /// One ticker for the life of the run rather than a task per delta. At 60
    /// tokens a second the per-delta version allocated sixty tasks and published
    /// on whatever irregular cadence the tokens happened to arrive on; a fixed
    /// 20 Hz tick costs one task and, more to the point, *looks* smoother,
    /// because evenly paced text reads as flowing where bursty text reads as
    /// stuttering even at the same average rate.
    private func schedulePublish() {
        dirty = true
        guard publisher == nil else { return }
        // The first frame of a run is not throttled. Everything after it can wait
        // for the tick — it is one token among many — but the first one is the
        // answer arriving, and holding it for up to a tick's worth of nothing is
        // the one delay in a run anybody is actually watching for.
        dirty = false
        publishNow()
        publisher = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(50))
                guard let self, !Task.isCancelled else { return }
                guard self.dirty else { continue }
                self.dirty = false
                self.publishNow()
            }
        }
    }

    private func publishNow() {
        guard let liveTurn else { return }
        setLive(liveTurn.isEmpty ? nil : liveTurn.snapshot())
    }

    /// The one place `live` is assigned, so the two signals derived from it
    /// cannot drift. `hasLive` is only written when it actually flips, because
    /// writing the same value to an observed property still invalidates.
    private func setLive(_ turn: Turn?) {
        live = turn
        if hasLive != (turn != nil) { hasLive = (turn != nil) }
        liveTick &+= 1
    }
}

/// When the last frame arrived, shared between the reader and its watchdog.
private actor FrameClock {
    private var last = ContinuousClock.now
    private var timedOut = false

    func beat() { last = ContinuousClock.now }

    func isStale(for limit: Duration) -> Bool {
        ContinuousClock.now - last > limit
    }

    func markTimedOut() { timedOut = true }
    func didTimeOut() -> Bool { timedOut }
}
