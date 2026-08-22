import SwiftUI

/// 设置 → 扩展. Third-party tools for the conversation, as a local subprocess or
/// a remote HTTP server.
///
/// Two payloads on one row: the record is what an edit writes back, and only
/// `status` knows whether the thing connected. `bootstrap` carries the status
/// alone, which was enough while this screen could only look.
struct McpSettingsView: View {
    let settings: SettingsStore

    @State private var adding = false
    @State private var deleting: McpServerRecord?

    var body: some View {
        List {
            Section {
                ForEach(settings.mcp.items) { server in
                    NavigationLink {
                        McpEditorView(settings: settings, server: server)
                    } label: {
                        row(server)
                    }
                    .swipeActions(edge: .leading) {
                        Button(server.enabled ? "停用" : "启用") {
                            Task { await toggle(server) }
                        }
                        .tint(server.enabled ? Color.warn : Color.ok)
                    }
                    .swipeActions(edge: .trailing) {
                        Button("删除", role: .destructive) { deleting = server }
                    }
                }
            } header: {
                SectionHeader(title: "MCP 服务器", symbol: "puzzlepiece.extension")
            } footer: {
                Text("停用的服务器不会连，它的工具也不会出现在对话里。")
            }
        }
        .formChrome("扩展")
        .overlay {
            if settings.mcp.items.isEmpty {
                if settings.isLoading {
                    ProgressView()
                } else {
                    ContentUnavailableView(
                        "还没有 MCP 服务器",
                        systemImage: "puzzlepiece.extension",
                        description: Text("本地进程或远程 HTTP 都行。")
                    )
                }
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { Task { await settings.reconnectMcp() } } label: {
                    if settings.isWriting {
                        Spinner()
                    } else {
                        Label("重新连接", systemImage: "arrow.clockwise")
                    }
                }
                .disabled(settings.isWriting)
                Button { adding = true } label: { Label("添加", systemImage: "plus") }
                    .disabled(settings.isWriting)
            }
        }
        .task { await settings.loadMcp() }
        .refreshable { await settings.loadMcp() }
        .sheet(isPresented: $adding) {
            NavigationStack {
                McpEditorView(settings: settings, server: nil)
            }
        }
        .alert("删除服务器", isPresented: .constant(deleting != nil), presenting: deleting) { server in
            Button("取消", role: .cancel) { deleting = nil }
            Button("删除", role: .destructive) {
                let target = server
                deleting = nil
                Task { await settings.deleteMcpServer(target.id) }
            }
        } message: { server in
            Text("「\(server.title)」的命令、参数和环境变量都会删掉，它提供的工具立刻从对话里消失。")
        }
    }

    private func row(_ server: McpServerRecord) -> some View {
        let status = settings.status(server.id)
        return HStack(spacing: Space.md) {
            Circle()
                .fill(dot(server, status))
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Space.xs) {
                    Text(server.title).lineLimit(1)
                    if server.isRemote { Badge(text: "远程") }
                    if !server.enabled { Badge(text: "已停用", tone: .warn) }
                }
                if let error = status?.error, !error.isEmpty, server.enabled {
                    Text(error).font(.caption).foregroundStyle(Color.danger).lineLimit(2)
                } else {
                    Text(detail(server, status))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: Space.sm)
            if status?.studioOnly == true { Badge(text: "仅创作台") }
        }
    }

    private func dot(_ server: McpServerRecord, _ status: McpStatus?) -> Color {
        guard server.enabled else { return .mutedFg }
        return status?.connected == true ? .ok : .warn
    }

    private func detail(_ server: McpServerRecord, _ status: McpStatus?) -> String {
        let address = server.isRemote
            ? (server.url ?? "")
            : ([server.command] + server.args).joined(separator: " ")
        guard server.enabled, let status, status.connected else { return address }
        return "\(status.tools.count) 个工具 · \(address)"
    }

    private func toggle(_ server: McpServerRecord) async {
        await settings.updateMcpServer(
            server.id,
            McpServerInput(enabled: !server.enabled),
            note: server.enabled ? "已停用" : "已启用"
        )
    }
}

// MARK: - Editor

private struct McpEditorView: View {
    let settings: SettingsStore
    let server: McpServerRecord?

    @Environment(\.dismiss) private var dismiss
    @State private var draft: McpDraft
    @State private var deleting = false

    init(settings: SettingsStore, server: McpServerRecord?) {
        self.settings = settings
        self.server = server
        _draft = State(initialValue: server.map(McpDraft.init) ?? McpDraft())
    }

    private var isNew: Bool { server == nil }

    var body: some View {
        Form {
            Section {
                TextField("名称", text: $draft.title)
                if isNew {
                    TextField("标识，例如 local-image-generation", text: $draft.id).exactEntry()
                }
                Picker("接入方式", selection: $draft.isRemote) {
                    Text("本地子进程").tag(false)
                    Text("远程 HTTP").tag(true)
                }
            } header: {
                Text("服务器").textCase(nil)
            } footer: {
                Text(draft.isRemote
                     ? "连已发布的服务器，先走 Streamable HTTP，不行再试旧的 SSE。"
                     : "按命令和参数启动一个进程，通过 stdio 通信。")
            }

            if draft.isRemote {
                Section {
                    TextField("https://mcp.example.com/mcp", text: $draft.url)
                        .keyboardType(.URL)
                        .exactEntry()
                } header: {
                    Text("地址").textCase(nil)
                }
                Section {
                    TextEditor(text: $draft.headers)
                        .frame(minHeight: 80)
                        .font(.caption.monospaced())
                        .exactEntry()
                } header: {
                    Text("请求头").textCase(nil)
                } footer: {
                    Text("每行一条 KEY=VALUE。可以用 ${OPENROUTER_API_KEY} 引用服务端已经存好的密钥。")
                }
            } else {
                Section {
                    TextField("python", text: $draft.command).exactEntry()
                    TextEditor(text: $draft.args)
                        .frame(minHeight: 60)
                        .font(.caption.monospaced())
                        .exactEntry()
                } header: {
                    Text("命令与参数").textCase(nil)
                } footer: {
                    Text("参数每行一个。")
                }
                Section {
                    TextEditor(text: $draft.env)
                        .frame(minHeight: 80)
                        .font(.caption.monospaced())
                        .exactEntry()
                } header: {
                    Text("环境变量").textCase(nil)
                } footer: {
                    Text("每行一条 KEY=VALUE。可以引用已存的密钥，以及 ${AIGC_ROOT}、${PROJECT_ROOT}、${NODE_EXE}。")
                }
            }

            Section {
                Toggle("启用", isOn: $draft.enabled)
                WriteButton(
                    title: isNew ? "添加" : "保存",
                    isWriting: settings.isWriting,
                    isEnabled: draft.isReady,
                    action: { Task { await save() } }
                )
                if server != nil {
                    WriteButton(
                        title: "删除服务器",
                        role: .destructive,
                        isWriting: settings.isWriting,
                        action: { deleting = true }
                    )
                }
            } footer: {
                Text("保存之后会立刻重连一次，连接结果就在上一页的列表里。")
            }
        }
        .formChrome(server?.title ?? "新建服务器")
        .toolbar {
            if isNew {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }.disabled(settings.isWriting)
                }
            }
        }
        .interactiveDismissDisabled(settings.isWriting)
        .alert("删除服务器", isPresented: $deleting) {
            Button("取消", role: .cancel) {}
            Button("删除", role: .destructive) { Task { await remove() } }
        } message: {
            Text("「\(server?.title ?? "")」的命令、参数和环境变量都会删掉，它提供的工具立刻从对话里消失。")
        }
    }

    private func save() async {
        let ok: Bool
        if let server {
            ok = await settings.updateMcpServer(server.id, draft.input(isNew: false), note: "已保存")
        } else {
            ok = await settings.createMcpServer(draft.input(isNew: true))
        }
        if ok, isNew { dismiss() }
    }

    private func remove() async {
        guard let server else { return }
        if await settings.deleteMcpServer(server.id) { dismiss() }
    }
}

private struct McpDraft {
    var id = ""
    var title = ""
    var isRemote = false
    var command = ""
    var url = ""
    var args = ""
    var env = ""
    var headers = ""
    var enabled = true

    init() {}

    /// A record written before `url` and `headers` existed puts the endpoint in
    /// `command` and its headers in `env`, which is still how the transport
    /// reaches it. Showing such a row as remote keeps it editable as what it is,
    /// rather than as a command nothing can spawn.
    init(_ server: McpServerRecord) {
        let legacyRemote = !server.isRemote && server.command.lowercased().hasPrefix("http")
        id = server.id
        title = server.title
        isRemote = server.isRemote || legacyRemote
        command = legacyRemote ? "" : server.command
        url = server.url ?? (legacyRemote ? server.command : "")
        args = server.args.joined(separator: "\n")
        env = McpDraft.lines(legacyRemote ? [:] : server.env)
        headers = McpDraft.lines(server.headers ?? (legacyRemote ? server.env : [:]))
        enabled = server.enabled
    }

    var isReady: Bool {
        let named = !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let address = isRemote
            ? url.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().hasPrefix("http")
            : !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return named && address
    }

    /// Both halves are always sent. `command` is `NOT NULL` in the schema, so a
    /// remote server stores an empty one and the URL is what selects the HTTP
    /// transport; an omitted field keeps the stored value, which would leave a
    /// server that was just switched to remote still trying to spawn a process.
    func input(isNew: Bool) -> McpServerInput {
        let trimmedId = id.trimmingCharacters(in: .whitespacesAndNewlines)
        return McpServerInput(
            id: isNew && !trimmedId.isEmpty ? trimmedId : nil,
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            enabled: enabled,
            command: isRemote ? "" : command.trimmingCharacters(in: .whitespacesAndNewlines),
            url: isRemote ? url.trimmingCharacters(in: .whitespacesAndNewlines) : "",
            args: isRemote ? [] : McpDraft.list(args),
            env: isRemote ? [:] : McpDraft.pairs(env),
            headers: isRemote ? McpDraft.pairs(headers) : [:]
        )
    }

    private static func lines(_ pairs: [String: String]) -> String {
        pairs.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: "\n")
    }

    private static func list(_ text: String) -> [String] {
        text.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    /// A value may itself contain `=`, so only the first one separates.
    private static func pairs(_ text: String) -> [String: String] {
        var result: [String: String] = [:]
        for line in list(text) {
            guard let split = line.firstIndex(of: "=") else { continue }
            let key = line[line.startIndex..<split].trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty else { continue }
            result[key] = line[line.index(after: split)...].trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return result
    }
}
