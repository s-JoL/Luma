import SwiftUI

/// The way in. A list of threads, with anything the agent is blocked on pinned
/// above them.
struct ConversationListView: View {
    @Environment(AppModel.self) private var app
    /// Bound on iPad, where the list is a column rather than a stack root.
    var selection: Binding<ConversationId?>?

    @State private var query = ""
    @State private var renaming: ConversationSummary?
    @State private var draftTitle = ""
    @State private var deleting: ConversationSummary?
    @State private var pushed: ConversationId?

    private var store: ConversationsStore { app.conversations }

    var body: some View {
        List(selection: selection) {
            if query.isEmpty {
                waiting
                threads
            } else {
                searchResults
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Color.bg)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("对话")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "搜索对话")
        .task(id: query) {
            // Debounced rather than issued per keystroke. A blank query clears
            // to the ordinary list and is not an error.
            guard !query.isEmpty else {
                store.clearSearch()
                return
            }
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await store.search(query)
        }
        .refreshable {
            await store.loadFirstPage()
            await app.approvals.refresh()
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    // The tap is answered before the request is even sent: a
                    // haptic now, the spinner on the next frame. Waiting for the
                    // server to reply is what made this button feel dead on any
                    // link slower than a loopback.
                    Haptics.tap()
                    Task { await newConversation() }
                } label: {
                    Label("新对话", systemImage: Symbols.newConversation)
                        .opacity(store.isCreating ? 0 : 1)
                        .overlay { if store.isCreating { Spinner() } }
                }
                .disabled(store.isCreating)
            }
        }
        .overlay { emptyState }
        // With rows already on screen there is nowhere to put this, so it goes to
        // the toast the rest of the app reports background failures through.
        .onChange(of: store.error) { _, message in
            guard let message, !store.items.isEmpty else { return }
            app.toast = Toast(message: message, isError: true)
        }
        .navigationDestination(item: $pushed) { id in
            TranscriptView(id: id)
        }
        // A question asked through Siri arrives as a conversation that already
        // exists and has already been sent to; all that is left is to go there.
        .onChange(of: app.opening) { _, id in
            guard let id else { return }
            open(id)
            app.opening = nil
        }
        .alert("重命名", isPresented: .constant(renaming != nil)) {
            TextField("标题", text: $draftTitle)
            Button("取消", role: .cancel) { renaming = nil }
            Button("保存") {
                if let target = renaming {
                    let title = draftTitle
                    Task { try? await store.rename(target.id, to: title) }
                }
                renaming = nil
            }
        }
        .alert("删除对话", isPresented: .constant(deleting != nil), presenting: deleting) { row in
            Button("取消", role: .cancel) { deleting = nil }
            Button("删除", role: .destructive) {
                Task { await delete(row) }
                deleting = nil
            }
        } message: { row in
            Text("「\(row.displayTitle)」会被永久删除。")
        }
    }

    // MARK: Sections

    /// Questions the agent is blocked on, wherever they were asked.
    ///
    /// At the top of the list rather than behind a tab or a badge, because the
    /// whole problem it solves is that the owner does not know to go looking: a
    /// run stopped halfway through in a conversation that is not on screen looks
    /// exactly like a run that finished.
    @ViewBuilder
    private var waiting: some View {
        if !app.approvals.pending.isEmpty {
            Section {
                ForEach(app.approvals.pending) { approval in
                    VStack(alignment: .leading, spacing: Space.sm) {
                        Button {
                            open(approval.conversationId)
                        } label: {
                            HStack(spacing: 3) {
                                Text(app.approvals.title(for: approval.conversationId))
                                    .font(.caption.weight(.medium))
                                    .lineLimit(1)
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 9, weight: .semibold))
                            }
                            .foregroundStyle(Color.brand)
                        }
                        .buttonStyle(.plain)

                        ApprovalCardView(approval: approval) { approved in
                            Task { await app.approvals.decide(approval, approved: approved) }
                        }
                    }
                    .padding(.vertical, Space.xs)
                    .listRowSeparator(.hidden)
                }
            } header: {
                Label("等你确认（\(app.approvals.count)）", systemImage: "exclamationmark.shield")
                    .foregroundStyle(Color.warn)
                    .textCase(nil)
            }
        }
    }

    @ViewBuilder
    private var threads: some View {
        ForEach(groups, id: \.label) { group in
            Section(group.label) {
                ForEach(group.rows) { row in
                    link(for: row)
                }
            }
        }
        if store.hasMore {
            HStack { Spacer(); Spinner(); Spacer() }
                .listRowSeparator(.hidden)
                .task { await store.loadMore() }
        }
    }

    @ViewBuilder
    private func link(for row: ConversationSummary) -> some View {
        Group {
            if selection == nil {
                Button { pushed = row.id } label: {
                    ConversationRow(row: row, modelName: modelName(row), isRunning: isRunning(row))
                }
                .buttonStyle(.plain)
            } else {
                ConversationRow(row: row, modelName: modelName(row), isRunning: isRunning(row))
                    .tag(row.id)
            }
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { deleting = row } label: {
                Label("删除", systemImage: "trash")
            }
        }
        .swipeActions(edge: .leading) {
            Button {
                draftTitle = row.title
                renaming = row
            } label: {
                Label("重命名", systemImage: "pencil")
            }
            .tint(Color.brand)
        }
        .contextMenu {
            Button {
                draftTitle = row.title
                renaming = row
            } label: {
                Label("重命名", systemImage: "pencil")
            }
            Button {
                UIPasteboard.general.string = row.displayTitle
            } label: {
                Label("复制标题", systemImage: "doc.on.doc")
            }
            Button(role: .destructive) { deleting = row } label: {
                Label("删除", systemImage: "trash")
            }
        }
    }

    @ViewBuilder
    private var searchResults: some View {
        if store.isSearching && store.searchResults.isEmpty {
            HStack { Spacer(); Spinner(); Spacer() }
                .listRowSeparator(.hidden)
        } else if store.searchResults.isEmpty {
            ContentUnavailableView.search(text: query)
                .listRowSeparator(.hidden)
        } else {
            ForEach(store.searchResults) { hit in
                Button {
                    open(hit.conversationId)
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(hit.title.isEmpty ? "新对话" : hit.title)
                            .font(.body)
                            .lineLimit(1)
                        Text(hit.snippet)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    .padding(.vertical, 4)
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if store.items.isEmpty, !store.isLoading, query.isEmpty, app.approvals.pending.isEmpty {
            // An empty list and a list that could not be read look identical,
            // and offering 新对话 against a server that just refused is the
            // wrong next step to suggest.
            if let error = store.error {
                ContentUnavailableView {
                    Label("没能读到对话", systemImage: Symbols.failed)
                } description: {
                    Text(error)
                } actions: {
                    Button("重试") { Task { await store.loadFirstPage() } }
                        .buttonStyle(.borderedProminent)
                }
            } else {
                ContentUnavailableView {
                    Label("还没有对话", systemImage: Symbols.chat)
                } description: {
                    Text("问点什么，或者让它画一张图")
                } actions: {
                    Button(store.isCreating ? "正在新建…" : "开始对话") {
                        Haptics.tap()
                        Task { await newConversation() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(store.isCreating)
                }
            }
        }
    }

    // MARK: Reading a row

    private func isRunning(_ row: ConversationSummary) -> Bool {
        store.running.contains(row.id)
    }

    /// Which model answered here, and only when it is not the usual one. A badge
    /// on every row is a badge on no row.
    private func modelName(_ row: ConversationSummary) -> String? {
        guard let bootstrap = app.bootstrap, row.modelId != bootstrap.defaultModelId else {
            return nil
        }
        return bootstrap.model(row.modelId)?.name
    }

    /// Grouped by day, exactly as the web's `groupByDay`.
    private var groups: [(label: String, rows: [ConversationSummary])] {
        var order: [String] = []
        var buckets: [String: [ConversationSummary]] = [:]
        for row in store.items {
            let label = DayLabel.of(row.updatedAt)
            if buckets[label] == nil {
                buckets[label] = []
                order.append(label)
            }
            buckets[label]?.append(row)
        }
        return order.map { ($0, buckets[$0] ?? []) }
    }

    // MARK: Actions

    private func open(_ id: ConversationId) {
        if let selection {
            selection.wrappedValue = id
        } else {
            pushed = id
        }
    }

    private func newConversation() async {
        do {
            let created = try await store.create(modelId: app.bootstrap?.defaultModelId)
            open(created.id)
        } catch let error as APIError {
            app.handle(error)
        } catch {}
    }

    private func delete(_ row: ConversationSummary) async {
        do {
            try await store.delete(row.id)
            if selection?.wrappedValue == row.id { selection?.wrappedValue = nil }
            if pushed == row.id { pushed = nil }
        } catch let error as APIError {
            // `409 run_active` is a state the reader can resolve, so it is said
            // plainly rather than reported as a failure.
            app.toast = Toast(
                message: error.isRunActive ? "这个对话还在回答，先停下来再删除" : error.display,
                isError: true
            )
        } catch {}
    }
}

// MARK: - Row

private struct ConversationRow: View {
    let row: ConversationSummary
    let modelName: String?
    let isRunning: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    var body: some View {
        HStack(alignment: .center, spacing: Space.md) {
            VStack(alignment: .leading, spacing: 3) {
                Text(row.displayTitle)
                    .font(.body)
                    .foregroundStyle(Color.fg)
                    .lineLimit(1)
                HStack(spacing: Space.xs) {
                    // The count is only shown once there is one. A brand new
                    // conversation reading "0 条消息" was the list telling the
                    // truth about a number it had not been told yet.
                    if row.messageCount > 0 {
                        Text("\(row.messageCount) 条消息")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("还没有消息")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let modelName {
                        Badge(text: modelName, tone: .brand)
                    }
                }
            }
            Spacer(minLength: Space.sm)
            if isRunning {
                // A breathing dot, because the honest answer to "did that
                // finish?" is worth more than a timestamp the reader can infer.
                Circle()
                    .fill(Color.brand)
                    .frame(width: 7, height: 7)
                    .overlay(
                        Circle()
                            .stroke(Color.brand.opacity(0.35), lineWidth: 5)
                            .scaleEffect(pulse ? 1.9 : 1)
                            .opacity(pulse ? 0 : 1)
                    )
                    .onAppear {
                        guard !reduceMotion else { return }
                        withAnimation(.easeOut(duration: 1.4).repeatForever(autoreverses: false)) {
                            pulse = true
                        }
                    }
                    .accessibilityLabel("正在回答")
            } else {
                Text(DayLabel.time(row.updatedAt))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

enum DayLabel {
    static func of(_ millis: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(millis) / 1000)
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "今天" }
        if calendar.isDateInYesterday(date) { return "昨天" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = calendar.isDate(date, equalTo: .now, toGranularity: .year)
            ? "M月d日" : "yyyy年M月d日"
        return formatter.string(from: date)
    }

    static func time(_ millis: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(millis) / 1000)
        let calendar = Calendar.current
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        if calendar.isDateInToday(date) {
            formatter.dateFormat = "HH:mm"
        } else if let week = calendar.dateInterval(of: .weekOfYear, for: .now), week.contains(date) {
            formatter.dateFormat = "EEE"
        } else {
            formatter.dateFormat = "M月d日"
        }
        return formatter.string(from: date)
    }
}
