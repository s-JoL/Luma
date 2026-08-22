import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The screen the app is for. Everything here serves one thing: text that is
/// comfortable to read while it is still being written.
///
/// The shape of this file is the performance story. SwiftUI invalidates a view
/// when state its body read changes, so anything read beside the `ForEach` over
/// the turns is paid for by the whole transcript. Three things change at frame
/// rate — the draft, the scroll position, and the streaming turn — and all three
/// are deliberately read *below* the list rather than above it: by
/// `ComposerBar`, by `JumpPillOverlay` and `TailFollower`, and by `LiveRow`. What
/// is left in the container changes a handful of times per conversation.
struct TranscriptView: View {
    let id: ConversationId

    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass

    @State private var store: TranscriptStore?
    @State private var composer = ComposerState()
    @State private var follow = ScrollFollow()

    // Presentation, which only a tap changes. These stay on the container
    // because a sheet or a cover has to be attached above the thing it covers,
    // and rebuilding the transcript once when someone opens a picture is a cost
    // that is never paid twice in a row.
    @State private var viewer: ImageId?
    @State private var playing: PlayingVideo?
    @State private var opened: OpenedDocument?
    @State private var showingModels = false
    @State private var regenerating: Turn?
    /// The user turn being rewritten, by seq. Nothing else identifies it after
    /// the rewind, which renumbers everything from that point on.
    @State private var editingSeq: Int?

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
        // Regenerating rewinds, so it says what it will discard rather than
        // warning in the abstract.
        .alert("重新生成", isPresented: .constant(regenerating != nil), presenting: regenerating) { turn in
            Button("取消", role: .cancel) { regenerating = nil }
            Button("重新生成", role: .destructive) {
                if let store {
                    follow.returnToTail()
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
                    TranscriptMenu(store: store, pickModel: { showingModels = true })
                }
            }
        }
    }

    /// The composer is a *bar over* the transcript, not a row beneath it. That is
    /// what lets text scroll under the glass and pick up the system's scroll edge
    /// effect; a composer stacked below the scroll view is just a frosted panel
    /// over the page colour, which is the difference between Liquid Glass and a
    /// blur for its own sake.
    private func content(_ store: TranscriptStore) -> some View {
        TranscriptBody(
            store: store,
            follow: follow,
            editingSeq: editingSeq,
            sizeClass: sizeClass,
            onImage: { viewer = $0 },
            onVideo: { playing = $0 },
            onDocument: { opened = $0 },
            onRegenerate: { regenerating = $0 },
            onEdit: { editingSeq = $0.seq },
            onCancelEdit: { editingSeq = nil },
            onSubmitEdit: { turn, text in submitEdit(store, turn: turn, text: text) },
            onPickModel: { showingModels = true }
        )
        .composerBar {
            ComposerBar(
                store: store,
                composer: composer,
                pickModel: { showingModels = true },
                send: { submit(store) }
            )
        }
    }

    /// A rewind, so it behaves like sending rather than like editing a field:
    /// the reader is taken to their own message, which is now the last one.
    private func submitEdit(_ store: TranscriptStore, turn: Turn, text: String) {
        guard !text.isEmpty else { return }
        editingSeq = nil
        follow.returnToTail()
        Haptics.tap()
        Task { await store.rerun(text: text, fromSeq: turn.seq, attachments: turn.attachmentIds) }
    }

    private func submit(_ store: TranscriptStore) {
        let text = composer.draft
        let ids = composer.attachmentIds
        composer.clear()
        // Sending takes you to your own message. Marking the position is not
        // enough: the geometry callback can fire before the reply exists and put
        // it straight back, which left the answer streaming below the fold
        // behind a pill you had to tap to watch your own question.
        follow.returnToTail()
        Haptics.tap()
        Task { await store.send(text: text, attachments: ids) }
    }
}

// MARK: - The list

/// The transcript itself. Reads `turns`, and the handful of flags that change
/// when a run starts or ends — never the streaming turn, the draft or the
/// scroll position.
private struct TranscriptBody: View {
    let store: TranscriptStore
    let follow: ScrollFollow
    let editingSeq: Int?
    let sizeClass: UserInterfaceSizeClass?
    var onImage: (ImageId) -> Void
    var onVideo: (PlayingVideo) -> Void
    var onDocument: (OpenedDocument) -> Void
    var onRegenerate: (Turn) -> Void
    var onEdit: (Turn) -> Void
    var onCancelEdit: () -> Void
    var onSubmitEdit: (Turn, String) -> Void
    var onPickModel: () -> Void

    private static let contentWidth: CGFloat = 768

    var body: some View {
        RenderLog.tick("TranscriptBody")
        return ScrollViewReader { proxy in
            // A `List`, not a `LazyVStack`, and the reason is measured.
            //
            // Sampling the app during a scroll put the main thread in
            // `LazyStack.measureEstimates` and `LazySubviewPlacements.placeSubviews`
            // — a lazy stack keeps a whole-content height by estimating every
            // row it has not built, and re-derives placements across the list as
            // it goes. With rows whose heights vary from one line to a screenful
            // of code, that estimation is most of the frame: the heartbeat
            // measured main-thread stalls of 150–185ms while scrolling.
            //
            // `List` has no whole-content-height concept at this level; it asks
            // for the rows it needs and recycles the rest. The cost is that
            // every row has to opt out of the styling below, which is a trade
            // worth making exactly once, here.
            List {
                Group {
                    header

                    ForEach(store.turns) { turn in
                        TurnView(
                            turn: turn,
                            citations: store.citations,
                            isStreaming: false,
                            isEditing: turn.role == .user && turn.seq == editingSeq,
                            onImage: onImage,
                            onVideo: onVideo,
                            onDocument: onDocument,
                            onApproval: { approval, ok in
                                Task { await store.decide(approval, approved: ok) }
                            },
                            onRegenerate: onRegenerate,
                            onEdit: store.isRunning ? nil : onEdit,
                            onCancelEdit: onCancelEdit,
                            onSubmitEdit: onSubmitEdit
                        )
                        .equatable()
                        .id(turn.id)
                    }

                    PendingRow(store: store)
                    LiveRow(store: store, onImage: onImage, onVideo: onVideo, onDocument: onDocument)
                    ErrorRow(store: store, pickModel: onPickModel)

                    // The tail-follow target of last resort. A 1pt view is
                    // enough, and giving it the full width keeps it a real
                    // layout element rather than something the list can collapse
                    // away.
                    Color.clear
                        .frame(maxWidth: .infinity)
                        .frame(height: 1)
                        .id(TranscriptStore.bottomAnchor)
                }
                // Applied to the `Group`, which passes them to each row. This is
                // the price of using a list for something that is not a list of
                // rows: every one of them has to give back the separator, the
                // background and the insets.
                .frame(maxWidth: Self.contentWidth, alignment: .leading)
                .frame(maxWidth: .infinity)
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(
                    top: Space.md,
                    leading: sizeClass == .compact ? Space.lg : Space.xl,
                    bottom: Space.md,
                    trailing: sizeClass == .compact ? Space.lg : Space.xl
                ))
                .transcriptTypeSize()
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 0)
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            // The two events the follow bit turns on. A drag hands control to
            // the reader the instant it starts; coming to rest hands it back,
            // but only if it came to rest at the bottom.
            .onScrollPhaseChange { _, phase in
                switch phase {
                case .interacting:
                    follow.beganDragging()
                case .idle:
                    follow.cameToRest()
                default:
                    break
                }
            }
            // How far the content's bottom sits past the viewport's. This has to
            // come from the scroll view itself: the composer is a `safeAreaBar`,
            // so an outer `GeometryReader` measures a taller box than the one the
            // content actually scrolls in, and the difference — about the height
            // of the composer — is enough to make "at the bottom" always true and
            // yank the view out from under someone reading.
            //
            // No `contentInsets` term: the composer's height is already laid out
            // into `contentSize`. Adding it again put a permanent ~110pt offset
            // on the reading.
            .onScrollGeometryChange(for: TailReading.self) { geometry in
                TailReading(
                    content: geometry.contentSize.height,
                    offset: geometry.contentOffset.y,
                    container: geometry.containerSize.height
                )
            } action: { _, reading in
                follow.report(reading)
            }
            .overlay(alignment: .top) { ConnectionNotice(store: store) }
            .overlay(alignment: .bottom) { JumpPillOverlay(store: store, follow: follow, proxy: proxy) }
            .overlay { TailFollower(store: store, follow: follow, proxy: proxy) }
            .refreshable { await store.topUp() }
        }
    }

    @ViewBuilder
    private var header: some View {
        // A transcript being read and an empty conversation are two different
        // screens, and showing neither for the length of a round trip is what
        // makes opening one feel like a stall.
        if store.turns.isEmpty && !store.hasLive {
            if store.isLoading {
                HStack { Spacer(); Spinner(); Spacer() }
                    .padding(.top, 80)
            } else {
                TranscriptWelcome()
                    .frame(maxWidth: .infinity)
                    .padding(.top, 80)
            }
        }

        if store.hasMoreHistory {
            HStack { Spacer(); Spinner(); Spacer() }
                .task { await store.pageBack() }
        }
    }
}

// MARK: - The rows that change on their own

/// The streaming turn, and the only view in the app that reads `store.live`.
///
/// It being its own view is the point: `live` is republished twenty times a
/// second, and every view that reads it is rebuilt that often. Keeping the read
/// down here means a frame of the stream costs one turn instead of the whole
/// transcript.
private struct LiveRow: View {
    let store: TranscriptStore
    var onImage: (ImageId) -> Void
    var onVideo: (PlayingVideo) -> Void
    var onDocument: (OpenedDocument) -> Void

    var body: some View {
        if let live = store.live {
            TurnView(
                turn: live,
                citations: store.citations,
                isStreaming: true,
                onImage: onImage,
                onVideo: onVideo,
                onDocument: onDocument,
                onApproval: { approval, ok in
                    Task { await store.decide(approval, approved: ok) }
                }
            )
            .equatable()
            .id(Turn.liveId)
        } else if store.isRunning {
            // Below the reader's own message, not instead of it: the pending
            // bubble says "sent", this says "working".
            ThinkingIndicator()
        }
    }
}

private struct PendingRow: View {
    let store: TranscriptStore

    var body: some View {
        if let pending = store.pending {
            PendingBubble(send: pending)
        }
    }
}

/// A run that failed, and what to do about it.
///
/// Retrying is `continueRun` rather than re-sending: the reader's message is
/// already persisted, so what failed was the answer to it, and sending the text
/// again would put the same question in the transcript twice.
private struct ErrorRow: View {
    let store: TranscriptStore
    var pickModel: () -> Void

    var body: some View {
        if let error = store.error {
            ErrorCard(
                title: FailureKind(runError: error).title,
                message: error,
                actions: [
                    .init("重试", systemImage: "arrow.clockwise") {
                        Task { await store.continueRun() }
                    },
                    .init("换个模型", systemImage: "arrow.up.arrow.down", run: pickModel),
                ]
            )
        }
    }
}

/// Keeps the view at the end of a growing answer, and renders nothing.
///
/// Following has to happen on every published frame, so whatever watches for one
/// is rebuilt twenty times a second — which is fine for a view whose body is a
/// zero-sized `Color.clear`, and was not fine when it was the transcript. It
/// watches `liveTick` rather than `live` for the same reason: an integer
/// comparison instead of a deep comparison of every part of the turn.
private struct TailFollower: View {
    let store: TranscriptStore
    let follow: ScrollFollow
    let proxy: ScrollViewProxy

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .allowsHitTesting(false)
            // Following is one bit, and only a drag clears it. Geometry is not
            // consulted here: it legitimately reads "not at the bottom" while
            // the keyboard is animating or the composer inset is changing, and
            // letting that stop the follow meant an answer could start streaming
            // below the fold behind a pill.
            .onChange(of: store.liveTick) { _, _ in
                guard follow.isFollowing else { return }
                proxy.scrollTo(store.tailId, anchor: .bottom)
            }
            .onChange(of: store.turns.count) { _, _ in
                guard follow.noteArrival() else { return }
                proxy.scrollTo(store.tailId, anchor: .bottom)
            }
            // A run finishing is the moment the answer is complete, and someone
            // who was watching it should end up at the end of it.
            .onChange(of: store.isRunning) { wasRunning, isRunning in
                guard !isRunning, wasRunning, follow.isFollowing else { return }
                Task { @MainActor in
                    // After the top-up has replaced the live turn.
                    try? await Task.sleep(for: .milliseconds(120))
                    withAnimation(Motion.move) { proxy.scrollTo(store.tailId, anchor: .bottom) }
                    follow.settleAtTail()
                }
            }
            .onChange(of: follow.requests) { _, _ in
                Task { @MainActor in
                    // Two passes: the pending bubble first, then whatever the
                    // reply turns out to be once it starts arriving.
                    withAnimation(Motion.move) { proxy.scrollTo(store.tailId, anchor: .bottom) }
                    try? await Task.sleep(for: .milliseconds(250))
                    proxy.scrollTo(store.tailId, anchor: .bottom)
                    follow.settleAtTail()
                }
            }
    }
}

private struct JumpPillOverlay: View {
    let store: TranscriptStore
    let follow: ScrollFollow
    let proxy: ScrollViewProxy

    var body: some View {
        // Nothing to jump to in an empty conversation, whatever the geometry
        // happened to report while the keyboard was animating.
        //
        // Gated on intent for the same reason following is: while an answer
        // streams, the geometry reads "not at the bottom" on most frames simply
        // because the content grew, and a pill over the last two lines of the
        // answer someone is reading is the worst possible place to put one.
        if follow.isAway, !store.turns.isEmpty || store.hasLive {
            JumpPill(count: follow.pendingCount) {
                Haptics.tap()
                withAnimation(Motion.move) {
                    proxy.scrollTo(store.tailId, anchor: .bottom)
                }
                follow.returnToTail()
            }
        }
    }
}

// MARK: - The composer

/// Owns the draft, so typing invalidates this and not the transcript.
private struct ComposerBar: View {
    let store: TranscriptStore
    @Bindable var composer: ComposerState
    var pickModel: () -> Void
    var send: () -> Void

    @Environment(AppModel.self) private var app

    var body: some View {
        ComposerView(
            text: $composer.draft,
            attachments: $composer.attachments,
            isRunning: store.isRunning,
            uploading: composer.uploading,
            modelName: modelName,
            send: send,
            stop: { Task { await store.stop() } },
            pickModel: pickModel,
            attach: { composer.showingAttach = true }
        )
        .confirmationDialog("添加附件", isPresented: $composer.showingAttach, titleVisibility: .visible) {
            Button("相册") { composer.pickingPhotos = true }
            Button("文件") { composer.importing = true }
            Button("取消", role: .cancel) {}
        }
        .photosPicker(
            isPresented: $composer.pickingPhotos,
            selection: $composer.photos,
            maxSelectionCount: max(1, remainingSlots),
            matching: .any(of: [.images, .videos])
        )
        .onChange(of: composer.photos) { _, items in
            guard !items.isEmpty else { return }
            Task { await upload(photos: items); composer.photos = [] }
        }
        .fileImporter(
            isPresented: $composer.importing,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            if case .success(let urls) = result { Task { await upload(urls: urls) } }
        }
    }

    private var modelName: String? {
        guard let id = store.modelId, let bootstrap = app.bootstrap else { return nil }
        return bootstrap.model(id)?.name
    }

    private var remainingSlots: Int {
        max(0, (app.bootstrap?.limits.maxAttachmentsPerMessage ?? 8) - composer.attachments.count)
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
        let room = max(0, cap - composer.attachments.count)
        if room == 0 {
            app.toast = Toast(message: "一条消息最多附带 \(cap) 个附件，请先移除一些", isError: true)
            return
        }
        composer.uploading = true
        defer { composer.uploading = false }
        for index in 0..<min(items, room) {
            guard let (data, name, mime) = await load(index) else { continue }
            if data.count > maxBytes {
                app.toast = Toast(message: "\(name) 超过上传大小上限", isError: true)
                continue
            }
            do {
                let file = try await app.api.upload(
                    data: data, filename: name, mime: mime, conversationId: store.id.raw
                )
                composer.attachments.append(
                    DraftAttachment(id: file.id.raw, name: file.name, mime: file.mime)
                )
            } catch let error as APIError {
                app.handle(error)
            } catch {}
        }
        if items > room {
            app.toast = Toast(message: "一条消息最多附带 \(cap) 个附件，其余未添加", isError: true)
        }
    }
}

private struct TranscriptMenu: View {
    let store: TranscriptStore
    var pickModel: () -> Void

    var body: some View {
        Menu {
            Button {
                pickModel()
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

// MARK: - Small pieces

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

    /// Nothing to scroll: the tail is on screen by definition.
    var isScrollable: Bool { content > container }

    /// Content that does not fill the viewport reports a fixed `-1` rather than
    /// an arithmetic result. There is nowhere to scroll, so the answer is "at the
    /// bottom" by definition — and computing it instead let one transient layout
    /// pass latch the pill on over an empty conversation, where it never got a
    /// second reading to correct itself because nothing was ever scrolled.
    var distanceFromTail: CGFloat {
        guard isScrollable else { return -1 }
        return content - offset - container
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
    let store: TranscriptStore

    var body: some View {
        if let notice = store.connection.notice {
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
                Section {
                    ForEach(app.bootstrap?.pinnedChatModels ?? []) { model in
                        row(model)
                    }
                } header: {
                    Text("固定").textCase(nil)
                } footer: {
                    Text("换模型只影响下一次回答，上面已经写好的不会重写。")
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
            .formChrome("模型")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
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
