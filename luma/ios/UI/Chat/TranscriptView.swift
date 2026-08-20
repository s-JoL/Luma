import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The screen the app is for. Everything here serves one thing: text that is
/// comfortable to read while it is still being written.
struct TranscriptView: View {
    let id: ConversationId

    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass

    @State private var store: TranscriptStore?
    @State private var draft = ""
    @State private var atBottom = true
    @State private var pendingCount = 0
    /// The reader deliberately left the tail, as opposed to the layout moving.
    @State private var scrolledAway = false
    /// Bumped when something should force the view to the tail.
    @State private var scrollRequests = 0
    /// A finger is on the glass, so a change in position is the reader's doing.
    @State private var dragging = false
    @State private var viewer: ImageId?
    @State private var playing: PlayingVideo?
    @State private var opened: OpenedDocument?
    @State private var showingModels = false
    @State private var regenerating: Turn?
    /// The user turn being rewritten, by seq. Nothing else identifies it after
    /// the rewind, which renumbers everything from that point on.
    @State private var editingSeq: Int?
    @State private var attachments: [DraftAttachment] = []
    @State private var uploading = false
    @State private var showingAttach = false
    @State private var pickingPhotos = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var importing = false

    private static let contentWidth: CGFloat = 768
    /// Scrolling up this far releases the pin to the tail.
    private static let followSlack: CGFloat = 40
    /// Far enough that only a person could have done it, not a relayout.
    private static let deliberateScroll: CGFloat = 200

    var body: some View {
        Group {
            if let store {
                content(store)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color.bg)
        .navigationTitle(ConversationTitle.display(store?.title))
        .navigationBarTitleDisplayMode(.inline)
        // The one screen that hides the tab bar. A composer and a tab bar
        // competing for the bottom safe area is the worst thing that can happen
        // to a chat app's ergonomics, and on a 375pt phone it costs the answer
        // two lines as well.
        .toolbar(.hidden, for: .tabBar)
        .task {
            let opened = app.transcript(for: id)
            store = opened
            await ImageLoader.shared.use(app.api)
            await opened.open()
        }
        .onChange(of: scenePhase) { _, phase in
            guard let store else { return }
            switch phase {
            case .background:
                store.enterBackground()
            case .active:
                Task { await store.enterForeground() }
            default:
                break
            }
        }
        .fullScreenCover(item: $viewer) { id in
            ImageViewer(imageId: id)
        }
        .fullScreenCover(item: $playing) { item in
            VideoViewer(videoId: item.videoId, poster: item.poster)
        }
        .fullScreenCover(item: $opened) { item in
            DocumentViewer(fileId: item.fileId, name: item.name)
        }
        .sheet(isPresented: $showingModels) {
            if let store { ModelPickerSheet(store: store) }
        }
        .confirmationDialog("添加附件", isPresented: $showingAttach, titleVisibility: .visible) {
            Button("相册") { pickingPhotos = true }
            Button("文件") { importing = true }
            Button("取消", role: .cancel) {}
        }
        .photosPicker(
            isPresented: $pickingPhotos,
            selection: $photos,
            maxSelectionCount: max(1, remainingSlots),
            matching: .any(of: [.images, .videos])
        )
        .onChange(of: photos) { _, items in
            guard !items.isEmpty else { return }
            Task { await upload(photos: items); photos = [] }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { Task { await upload(urls: urls) } }
        }
        // Regenerating rewinds, so it says what it will discard rather than
        // warning in the abstract.
        .alert("重新生成", isPresented: .constant(regenerating != nil), presenting: regenerating) { turn in
            Button("取消", role: .cancel) { regenerating = nil }
            Button("重新生成", role: .destructive) {
                if let store {
                    atBottom = true
                    scrolledAway = false
                    Task { await store.regenerate(turn) }
                }
                regenerating = nil
            }
        } message: { turn in
            let after = store?.turnsAfter(turn) ?? 0
            Text(after > 0
                 ? "这会删除这条之后的 \(after) 条内容，然后重新回答。"
                 : "会用同一个问题重新回答一次。")
        }
        .toolbar {
            if let store {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button {
                            showingModels = true
                        } label: {
                            Label("切换模型", systemImage: "arrow.up.arrow.down")
                        }
                        if store.isRunning {
                            Button(role: .destructive) {
                                Task { await store.stop() }
                            } label: {
                                Label("停止", systemImage: Symbols.stop)
                            }
                        } else {
                            Button {
                                Task { await store.continueRun() }
                            } label: {
                                Label("继续", systemImage: "arrow.forward")
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
        }
    }

    /// The composer is a *bar over* the transcript, not a row beneath it. That is
    /// what lets text scroll under the glass and pick up the system's scroll edge
    /// effect; a composer stacked below the scroll view is just a frosted panel
    /// over the page colour, which is the difference between Liquid Glass and a
    /// blur for its own sake.
    @ViewBuilder
    private func content(_ store: TranscriptStore) -> some View {
        transcript(store)
            .composerBar {
                ComposerView(
                    text: $draft,
                    attachments: $attachments,
                    isRunning: store.isRunning,
                    uploading: uploading,
                    modelName: modelName(store),
                    profileName: profileName(store),
                    send: { submit(store) },
                    stop: { Task { await store.stop() } },
                    pickModel: { showingModels = true },
                    attach: { showingAttach = true }
                )
            }
    }

    private func transcript(_ store: TranscriptStore) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Space.xl) {
                    if store.turns.isEmpty && store.live == nil && !store.isLoading {
                        TranscriptWelcome()
                            .frame(maxWidth: .infinity)
                            .padding(.top, 80)
                    }

                    // A transcript being read and an empty conversation are two
                    // different screens, and showing neither for the length of a
                    // round trip is what makes opening one feel like a stall.
                    if store.isLoading && store.turns.isEmpty {
                        HStack { Spacer(); Spinner(); Spacer() }
                            .padding(.top, 80)
                    }

                    if store.hasMoreHistory {
                        HStack {
                            Spacer()
                            Spinner()
                            Spacer()
                        }
                        .task { await store.pageBack() }
                    }

                    ForEach(store.turns) { turn in
                        TurnView(
                            turn: turn,
                            citations: store.citations,
                            isStreaming: false,
                            isEditing: turn.role == .user && turn.seq == editingSeq,
                            onImage: { viewer = $0 },
                            onVideo: { playing = $0 },
                            onDocument: { opened = $0 },
                            onApproval: { approval, ok in
                                Task { await store.decide(approval, approved: ok) }
                            },
                            onRegenerate: { regenerating = $0 },
                            onEdit: store.isRunning ? nil : { editingSeq = $0.seq },
                            onCancelEdit: { editingSeq = nil },
                            onSubmitEdit: { turn, text in submitEdit(store, turn: turn, text: text) }
                        )
                        .equatable()
                        .turnArrival()
                        .id(turn.id)
                    }

                    if let pending = store.pending {
                        PendingBubble(send: pending)
                    }

                    if let live = store.live {
                        TurnView(
                            turn: live,
                            citations: store.citations,
                            isStreaming: true,
                            onImage: { viewer = $0 },
                            onVideo: { playing = $0 },
                            onDocument: { opened = $0 },
                            onApproval: { approval, ok in
                                Task { await store.decide(approval, approved: ok) }
                            }
                        )
                        .equatable()
                        .id(Turn.liveId)
                    }

                    // Below the reader's own message, not instead of it: the
                    // pending bubble says "sent", this says "working".
                    if store.isRunning && store.live == nil {
                        ThinkingIndicator()
                    }

                    if let error = store.error {
                        Text(error)
                            .font(.callout)
                            .foregroundStyle(Color.danger)
                            .padding(Space.md)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(
                                Color.danger.opacity(0.1),
                                in: RoundedRectangle(cornerRadius: Radius.lg)
                            )
                    }

                    // The tail-follow target. A 1pt view is enough, and giving it
                    // the full width keeps it a real layout element rather than
                    // something the lazy stack can collapse away.
                    Color.clear
                        .frame(maxWidth: .infinity)
                        .frame(height: 1)
                        .id(bottomAnchor)
                        // The iOS 17 read on "is the tail on screen": the
                        // sentinel is only laid out when it is near the viewport.
                        .onAppear { if #unavailable(iOS 18.0) { markAtBottom(true) } }
                        .onDisappear { if #unavailable(iOS 18.0) { markAtBottom(false) } }
                }
                .frame(maxWidth: Self.contentWidth, alignment: .leading)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, sizeClass == .compact ? Space.lg : Space.xl)
                .padding(.vertical, Space.xl)
                .transcriptTypeSize()
            }
            .scrollDismissesKeyboard(.interactively)
            .transcriptScrollAnchors()
            // How far the content's bottom sits past the viewport's. This has to
            // come from the scroll view itself: the composer is a `safeAreaBar`,
            // so an outer `GeometryReader` measures a taller box than the one the
            // content actually scrolls in, and the difference — about the height
            // of the composer — is enough to make "at the bottom" always true and
            // yank the view out from under someone reading.
            .trackDragging { dragging = $0 }
            .trackTailDistance { reading in
                let distance = reading.distanceFromTail
                let isNear = distance < Self.followSlack
                atBottom = isNear
                if isNear {
                    pendingCount = 0
                    scrolledAway = false
                } else if dragging {
                    // Leaving the tail is a thing a *person* does. Inferring it
                    // from distance alone was a feedback loop: one scroll that
                    // did not land grew the gap, the gap looked like a reader
                    // who had moved, following stopped, and the gap grew for
                    // good. Only a finger on the glass sets this.
                    scrolledAway = true
                }
            }
            // A run finishing is the moment the answer is complete, and someone
            // who was watching it should end up at the end of it.
            .onChange(of: store.isRunning) { wasRunning, isRunning in
                guard !isRunning, wasRunning, !scrolledAway else { return }
                Task { @MainActor in
                    // After the top-up has replaced the live turn.
                    try? await Task.sleep(for: .milliseconds(120))
                    withAnimation(Motion.move) { proxy.scrollTo(tailId(store), anchor: .bottom) }
                    atBottom = true
                    pendingCount = 0
                }
            }
            // Follow the tail only while the reader has not scrolled up. An
            // answer that yanks the view while someone is reading the middle of
            // it is unusable, which makes this the most important interaction
            // on the screen.
            .onChange(of: scrollRequests) { _, _ in
                Task { @MainActor in
                    // Two passes: the pending bubble first, then whatever the
                    // reply turns out to be once it starts arriving.
                    withAnimation(Motion.move) { proxy.scrollTo(tailId(store), anchor: .bottom) }
                    try? await Task.sleep(for: .milliseconds(250))
                    atBottom = true
                    proxy.scrollTo(tailId(store), anchor: .bottom)
                }
            }
            // Following is gated on intent, not on the measurement. `atBottom`
            // comes from scroll geometry that legitimately reads "not at the
            // bottom" while the keyboard is animating or the composer inset is
            // changing, and using it here meant an answer could start streaming
            // below the fold behind a pill. `scrolledAway` only becomes true
            // when someone drags a real distance, which is the actual question:
            // did the reader leave the tail on purpose?
            .onChange(of: store.live) { _, _ in
                guard !scrolledAway else { return }
                proxy.scrollTo(tailId(store), anchor: .bottom)
            }
            // The pill counts *turns* that arrived while the reader was away, not
            // deltas: a streaming answer publishes sixty times a second and a
            // pill reading "回到最新 400" is noise, not information.
            .onChange(of: store.turns.count) { _, _ in
                guard !scrolledAway else {
                    pendingCount += 1
                    return
                }
                proxy.scrollTo(tailId(store), anchor: .bottom)
            }
            .overlay(alignment: .top) {
                ConnectionNotice(connection: store.connection)
            }
            .overlay(alignment: .bottom) {
                // Nothing to jump to in an empty conversation, whatever the
                // geometry happened to report while the keyboard was animating.
                //
                // Gated on intent for the same reason following is: while an
                // answer streams, the geometry reads "not at the bottom" on
                // most frames simply because the content grew, and a pill over
                // the last two lines of the answer someone is reading is the
                // worst possible place to put one.
                if !atBottom, scrolledAway, !store.turns.isEmpty || store.live != nil {
                    JumpPill(count: pendingCount) {
                        Haptics.tap()
                        withAnimation(Motion.move) {
                            proxy.scrollTo(tailId(store), anchor: .bottom)
                        }
                        atBottom = true
                        pendingCount = 0
                        scrolledAway = false
                    }
                }
            }
            .refreshable { await store.topUp() }
        }
    }

    private let bottomAnchor = "transcript.bottom"

    /// What to scroll to when following the tail. **Not the sentinel.** The
    /// bottom anchor is a 1pt view at the end of a `LazyVStack`, and a lazy stack
    /// does not create views far outside the visible range — so with the keyboard
    /// up and 140pt of answer hidden behind it, `scrollTo(bottomAnchor)` was
    /// asking for an id that did not exist yet and silently did nothing. The last
    /// *turn* is a large, realized view, and anchoring to its bottom lands in the
    /// same place.
    private func tailId(_ store: TranscriptStore) -> String {
        if store.live != nil { return Turn.liveId }
        return store.turns.last?.id ?? bottomAnchor
    }

    private func markAtBottom(_ isNear: Bool) {
        atBottom = isNear
        if isNear { pendingCount = 0 }
    }

    private var remainingSlots: Int {
        max(0, (app.bootstrap?.limits.maxAttachmentsPerMessage ?? 8) - attachments.count)
    }

    private func modelName(_ store: TranscriptStore) -> String? {
        guard let id = store.modelId, let bootstrap = app.bootstrap else { return nil }
        return bootstrap.model(id)?.name
    }

    private func profileName(_ store: TranscriptStore) -> String? {
        let profiles = app.bootstrap?.profiles ?? []
        guard !profiles.isEmpty else { return nil }
        if store.profileId.isEmpty { return "默认设置" }
        return profiles.first { $0.id.raw == store.profileId }?.name ?? store.profileId
    }

    /// A rewind, so it behaves like sending rather than like editing a field:
    /// the reader is taken to their own message, which is now the last one.
    private func submitEdit(_ store: TranscriptStore, turn: Turn, text: String) {
        guard !text.isEmpty else { return }
        editingSeq = nil
        atBottom = true
        scrolledAway = false
        scrollRequests += 1
        Haptics.tap()
        Task { await store.rerun(text: text, fromSeq: turn.seq, attachments: turn.attachmentIds) }
    }

    private func submit(_ store: TranscriptStore) {
        let text = draft
        let ids = attachments.map(\.id)
        draft = ""
        attachments = []
        atBottom = true
        scrolledAway = false
        // Sending takes you to your own message. Setting `atBottom` is not
        // enough: the geometry callback can fire before the reply exists and put
        // it straight back to false, which left the answer streaming below the
        // fold behind a jump pill you had to tap to watch your own question.
        scrollRequests += 1
        Haptics.tap()
        Task { await store.send(text: text, attachments: ids) }
    }

    private func upload(photos: [PhotosPickerItem]) async {
        await upload(items: photos.count) { index in
            let item = photos[index]
            guard let data = try? await item.loadTransferable(type: Data.self) else { return nil }
            return (data, "photo.jpg", "image/jpeg")
        }
    }

    private func upload(urls: [URL]) async {
        await upload(items: urls.count) { index in
            let url = urls[index]
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { return nil }
            let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            return (data, url.lastPathComponent, mime)
        }
    }

    private func upload(items: Int, load: (Int) async -> (Data, String, String)?) async {
        let cap = app.bootstrap?.limits.maxAttachmentsPerMessage ?? 8
        let maxBytes = app.bootstrap?.limits.maxUploadBytes ?? 50_000_000
        let room = max(0, cap - attachments.count)
        if room == 0 {
            app.toast = Toast(message: "一条消息最多附带 \(cap) 个附件，请先移除一些", isError: true)
            return
        }
        uploading = true
        defer { uploading = false }
        for index in 0..<min(items, room) {
            guard let (data, name, mime) = await load(index) else { continue }
            if data.count > maxBytes {
                app.toast = Toast(message: "\(name) 超过上传大小上限", isError: true)
                continue
            }
            do {
                let file = try await app.api.upload(data: data, filename: name, mime: mime, conversationId: id.raw)
                attachments.append(DraftAttachment(id: file.id.raw, name: file.name, mime: file.mime))
            } catch let error as APIError {
                app.handle(error)
            } catch {}
        }
        if items > room {
            app.toast = Toast(message: "一条消息最多附带 \(cap) 个附件，其余未添加", isError: true)
        }
    }
}

/// The first thing in an empty conversation. No suggestion chips: they date
/// badly, they push the composer up, and on a single-user server the owner
/// already knows what their own agent does. No name either — the server has no
/// account and never learns one, so anything personal here would be a string
/// the app made up about the person reading it.
private struct TranscriptWelcome: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var glow = false

    var body: some View {
        VStack(spacing: Space.md) {
            Image(systemName: "moon.stars.fill")
                .font(.system(size: 40))
                .foregroundStyle(LinearGradient.brandFill)
                .shadow(color: Color.brand.opacity(glow ? 0.45 : 0.2), radius: glow ? 22 : 12, y: 4)
                .onAppear {
                    guard !reduceMotion else { return }
                    withAnimation(.easeInOut(duration: 2.4).repeatForever(autoreverses: true)) {
                        glow = true
                    }
                }

            Text("在想什么？")
                .font(.system(.title3, design: .rounded).weight(.semibold))
                .foregroundStyle(Color.fg)

            Text("搜网页、查文件、画图、做视频，都行。")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The scroll view's geometry, kept as its parts rather than a single number so
/// the tail calculation can be reasoned about instead of tuned by trial.
struct TailReading: Equatable {
    var content: CGFloat = 0
    var offset: CGFloat = 0
    var container: CGFloat = 0
    var insetTop: CGFloat = 0
    var insetBottom: CGFloat = 0

    /// Nothing to scroll: the tail is on screen by definition.
    var isScrollable: Bool { content > container }

    var distanceFromTail: CGFloat {
        guard isScrollable else { return -1 }
        return content - offset - container
    }

    var debug: String {
        String(
            format: "c=%.0f o=%.0f v=%.0f it=%.0f ib=%.0f d=%.0f",
            content, offset, container, insetTop, insetBottom, distanceFromTail
        )
    }
}

private extension View {
    /// Open at the tail, and *stay* at the tail as the answer grows.
    ///
    /// The second half is the part that cannot be done by hand. Following by
    /// calling `scrollTo` on every published frame fails whenever the target is
    /// a lazy view that has not been created yet — which is precisely the case
    /// during streaming, where the growing turn is just off the bottom edge. iOS
    /// 18's `.sizeChanges` anchor is the system doing it from inside the scroll
    /// view, where the geometry is known and nothing has to be realised first.
    @ViewBuilder
    func transcriptScrollAnchors() -> some View {
        if #available(iOS 18.0, *) {
            defaultScrollAnchor(.bottom)
                .defaultScrollAnchor(.bottom, for: .sizeChanges)
        } else {
            defaultScrollAnchor(.bottom)
        }
    }

    /// Whether the reader is actively dragging the transcript, as opposed to the
    /// content moving under them. Below iOS 18 there is no phase to observe, so
    /// the transcript follows the tail unconditionally — the wrong default is
    /// far less annoying that way round.
    @ViewBuilder
    func trackDragging(_ action: @escaping (Bool) -> Void) -> some View {
        if #available(iOS 18.0, *) {
            onScrollPhaseChange { _, phase in
                action(phase == .interacting || phase == .decelerating)
            }
        } else {
            self
        }
    }

    /// Reports how far the content's bottom sits past the viewport's, from the
    /// scroll view's own geometry. iOS 18 says this in one call; below that the
    /// transcript falls back to whether its bottom sentinel is laid out, which
    /// is coarser but never wrong in the dangerous direction.
    @ViewBuilder
    func trackTailDistance(_ action: @escaping (TailReading) -> Void) -> some View {
        if #available(iOS 18.0, *) {
            // No `contentInsets` term: the composer is a `safeAreaBar`, so its
            // height is already laid out into `contentSize`. Adding it again put
            // a permanent ~110pt offset on the reading.
            //
            // Content that does not fill the viewport reports a fixed `-1`
            // rather than an arithmetic result. There is nowhere to scroll, so
            // the answer is "at the bottom" by definition — and computing it
            // instead let one transient layout pass latch the pill on over an
            // empty conversation, where it never got a second reading to correct
            // itself because nothing was ever scrolled.
            onScrollGeometryChange(for: TailReading.self) { geometry in
                TailReading(
                    content: geometry.contentSize.height,
                    offset: geometry.contentOffset.y,
                    container: geometry.containerSize.height,
                    insetTop: geometry.contentInsets.top,
                    insetBottom: geometry.contentInsets.bottom
                )
            } action: { _, reading in
                action(reading)
            }
        } else {
            self
        }
    }
}

/// The reader's own message, shown from the instant they tap send and kept until
/// the persisted copy replaces it. It is styled like a real user turn rather than
/// a ghost — it is a real message, and the only thing provisional about it is
/// which sequence number it will land on.
private struct PendingBubble: View {
    let send: TranscriptStore.PendingSend

    var body: some View {
        HStack {
            Spacer(minLength: 40)
            VStack(alignment: .trailing, spacing: Space.xs) {
                Text(send.text)
                    .font(.body)
                    .foregroundStyle(Color.onBrand)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(
                        send.failed
                            ? AnyShapeStyle(Color.brand.opacity(0.4))
                            : AnyShapeStyle(LinearGradient.brandFill),
                        in: UnevenRoundedRectangle(
                            topLeadingRadius: Radius.bubble,
                            bottomLeadingRadius: Radius.bubble,
                            bottomTrailingRadius: Radius.sm,
                            topTrailingRadius: Radius.bubble
                        )
                    )
                if send.failed {
                    Label("发送失败", systemImage: Symbols.failed)
                        .font(.caption)
                        .foregroundStyle(Color.danger)
                }
            }
        }
    }
}

/// What the stream is doing, and only when that is not the ordinary thing. A
/// dropped connection otherwise looks exactly like a model thinking, and the
/// reader waits on an answer that is not coming. Glass and one line, because it
/// is a status rather than a failure: nothing has gone wrong yet.
private struct ConnectionNotice: View {
    let connection: TranscriptStore.Connection

    var body: some View {
        if let notice = connection.notice {
            HStack(spacing: Space.xs) {
                Spinner()
                Text(notice)
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(Color.mutedFg)
            .padding(.horizontal, 12)
            .frame(height: 30)
            .floatingGlass(in: .capsule)
            .padding(.top, Space.sm)
            .shadow(color: .black.opacity(0.1), radius: 8, y: 2)
            .transition(.move(edge: .top).combined(with: .opacity))
            .accessibilityLabel(notice)
        }
    }
}

/// Floats above the transcript, so it is glass rather than a card — the same
/// rule the composer follows.
private struct JumpPill: View {
    let count: Int
    let tap: () -> Void

    var body: some View {
        Button(action: tap) {
            HStack(spacing: Space.xs) {
                Image(systemName: Symbols.jumpToLatest)
                    .font(.system(size: 11, weight: .bold))
                Text(count > 0 ? "回到最新 \(count)" : "回到最新")
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(Color.fg)
            .padding(.horizontal, 14)
            .frame(height: 34)
            .floatingGlass(in: .capsule, interactive: true)
        }
        .buttonStyle(.plain)
        .padding(.bottom, Space.sm)
        .shadow(color: .black.opacity(0.12), radius: 10, y: 3)
        .transition(.scale(scale: 0.9).combined(with: .opacity))
    }
}

/// What the reader sees between sending and the first token. Three dots that
/// breathe, under a shimmering label — enough to say "it heard you" without the
/// spinner's implication that something is stuck.
private struct ThinkingIndicator: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var lit = 0

    var body: some View {
        HStack(spacing: Space.sm) {
            HStack(spacing: 4) {
                ForEach(0..<3, id: \.self) { index in
                    Circle()
                        .fill(Color.brand)
                        .frame(width: 6, height: 6)
                        .opacity(reduceMotion ? 0.6 : (lit == index ? 1 : 0.25))
                        .scaleEffect(reduceMotion ? 1 : (lit == index ? 1.15 : 0.85))
                }
            }
            Text("正在思考")
                .font(.caption)
                .foregroundStyle(.secondary)
                .shimmering()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("正在生成")
        .accessibilityAddTraits(.updatesFrequently)
        .task {
            guard !reduceMotion else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(280))
                withAnimation(.easeInOut(duration: 0.28)) { lit = (lit + 1) % 3 }
            }
        }
    }
}

private struct ModelPickerSheet: View {
    let store: TranscriptStore
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if let profiles = app.bootstrap?.profiles, !profiles.isEmpty {
                    Section {
                        profileRow(id: "", name: "默认设置", hint: "用全局模型与能力")
                        ForEach(profiles) { profile in
                            profileRow(
                                id: profile.id.raw,
                                name: profile.name,
                                hint: describe(profile)
                            )
                        }
                    } header: {
                        Text("预设").textCase(nil)
                    }
                }

                Section {
                    ForEach(app.bootstrap?.pinnedChatModels ?? []) { model in
                        row(model)
                    }
                } header: {
                    Text("固定").textCase(nil)
                } footer: {
                    Text("换模型和预设只影响下一次回答，上面已经写好的不会重写。")
                }

                // An aggregator exposes hundreds and a person reaches for four,
                // so the unpinned ones are reachable but never the first thing.
                let others = (app.bootstrap?.allChatModels ?? []).filter { !$0.pinned }
                if !others.isEmpty {
                    Section {
                        ForEach(others) { model in row(model) }
                    } header: {
                        Text("全部模型（\(others.count)）").textCase(nil)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Color.bg)
            .navigationTitle("模型和预设")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func profileRow(id: String, name: String, hint: String) -> some View {
        let selected = store.profileId == id
        return Button {
            Task { await store.setProfile(id) }
        } label: {
            HStack(spacing: Space.md) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).foregroundStyle(Color.fg).lineLimit(1)
                    if !hint.isEmpty {
                        Text(hint)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: Space.sm)
                if selected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Color.brand)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private func describe(_ profile: Profile) -> String {
        let names = [
            app.bootstrap?.models.first { $0.id.raw == profile.chatModelId }?.name,
            app.bootstrap?.models.first { $0.id.raw == profile.imageModelId }?.name,
        ].compactMap { $0 }.filter { !$0.isEmpty }
        return names.joined(separator: " · ")
    }

    private func row(_ model: ModelSpec) -> some View {
        let selected = store.modelId == model.id
        return Button {
            Task { await store.setModel(model.id) }
            dismiss()
        } label: {
            HStack(spacing: Space.md) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: Space.xs) {
                        Text(model.name).foregroundStyle(Color.fg).lineLimit(1)
                        if model.reasoning { Badge(text: "推理", tone: .brand) }
                    }
                    Text(providerName(model))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: Space.sm)
                if selected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Color.brand)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private func providerName(_ model: ModelSpec) -> String {
        let provider = app.bootstrap?.providers.first { $0.id == model.providerId }
        return provider?.name ?? model.providerId.raw
    }
}

