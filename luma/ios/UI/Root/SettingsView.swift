import SwiftUI

/// Same seven concerns as the web settings, on `/v1`. Keys are write-only.
struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @State private var signingOut = false

    var body: some View {
        List {
            serverSection
            if app.bootstrap != nil {
                Section {
                    NavigationLink { ProvidersSettingsView() } label: {
                        Label("提供方", systemImage: "plug")
                    }
                    NavigationLink { ModelsSettingsView() } label: {
                        Label("对话模型", systemImage: "cpu")
                    }
                    NavigationLink { CapabilitiesSettingsView() } label: {
                        Label("能力", systemImage: "switch.2")
                    }
                    NavigationLink { PromptsSettingsView() } label: {
                        Label("提示词", systemImage: "text.alignleft")
                    }
                    if let mcp = app.bootstrap?.mcp, !mcp.isEmpty {
                        NavigationLink { McpSettingsView() } label: {
                            Label("扩展", systemImage: "puzzlepiece.extension")
                        }
                    }
                    NavigationLink { SecurityView() } label: {
                        Label("安全", systemImage: "lock")
                    }
                } header: {
                    SectionHeader(title: "配置", symbol: "slider.horizontal.3")
                } footer: {
                    Text("密钥只写入、不会读回来。加提供方请用网页。")
                }
            }
            aboutSection
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Color.bg)
        .navigationTitle("设置")
        .navigationBarTitleDisplayMode(.inline)
        .alert("退出登录", isPresented: $signingOut) {
            Button("取消", role: .cancel) {}
            Button("退出", role: .destructive) { Task { await app.signOut() } }
        } message: {
            Text("这台设备的令牌会被清除，下次要重新输入访问码。")
        }
    }

    private var serverSection: some View {
        Section {
            LabeledContent("地址") {
                Text(app.serverURL?.absoluteString ?? "未设置")
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            LabeledContent("版本") {
                Text(app.bootstrap?.version ?? "…").foregroundStyle(.secondary)
            }
            if let millis = app.lastBootstrapMillis {
                LabeledContent("启动往返") {
                    Text("\(millis) ms")
                        .foregroundStyle(millis < 150 ? Color.ok : Color.mutedFg)
                        .monospacedDigit()
                }
            }
            Button(role: .destructive) { signingOut = true } label: {
                Label("退出登录", systemImage: "rectangle.portrait.and.arrow.right")
            }
        } header: {
            SectionHeader(title: "服务器", symbol: "server.rack")
        }
    }

    private var aboutSection: some View {
        Section {
            LabeledContent("客户端") {
                Text(clientVersion).foregroundStyle(.secondary).monospacedDigit()
            }
        } header: {
            SectionHeader(title: "关于", symbol: "info.circle")
        } footer: {
            Text("数据都在这台服务器上。")
        }
    }

    private var clientVersion: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = info?["CFBundleVersion"] as? String ?? "1"
        return "\(short) (\(build))"
    }
}

// MARK: - Providers

private struct ProvidersSettingsView: View {
    @Environment(AppModel.self) private var app
    @State private var editing: Provider?
    @State private var key = ""
    @State private var busy = false

    var body: some View {
        List {
            ForEach(app.bootstrap?.providers ?? []) { provider in
                VStack(alignment: .leading, spacing: Space.xs) {
                    HStack {
                        Text(provider.name)
                        Spacer()
                        if provider.isKeyless {
                            Badge(text: "无需密钥")
                        } else if provider.hasKey {
                            Badge(text: "已配置", tone: .ok)
                        } else {
                            Badge(text: "缺少密钥", tone: .warn)
                        }
                    }
                    Text(provider.baseUrl)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if !provider.isKeyless {
                        HStack {
                            Button("设置密钥") { editing = provider; key = "" }
                            if provider.hasKey {
                                Button("清除", role: .destructive) {
                                    Task { await clearKey(provider) }
                                }
                            }
                        }
                        .font(.footnote)
                    }
                }
                .disabled(busy)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Color.bg)
        .navigationTitle("提供方")
        .navigationBarTitleDisplayMode(.inline)
        .alert("设置密钥", isPresented: Binding(
            get: { editing != nil },
            set: { if !$0 { editing = nil } }
        )) {
            SecureField("API key", text: $key)
            Button("取消", role: .cancel) { editing = nil; key = "" }
            Button("保存") {
                if let provider = editing { Task { await saveKey(provider) } }
            }
            .disabled(key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: {
            Text("密钥只提交，之后无法再读出来。")
        }
    }

    private func saveKey(_ provider: Provider) async {
        let value = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        busy = true
        defer { busy = false; editing = nil; key = "" }
        do {
            try await app.api.send(.setProviderKey(provider.id, value: value))
            await app.load()
        } catch let error as APIError {
            app.handle(error)
        } catch {}
    }

    private func clearKey(_ provider: Provider) async {
        busy = true
        defer { busy = false }
        do {
            try await app.api.send(.deleteProviderKey(provider.id))
            await app.load()
        } catch let error as APIError {
            app.handle(error)
        } catch {}
    }
}

// MARK: - Models

private struct ModelsSettingsView: View {
    @Environment(AppModel.self) private var app
    @State private var busy = false

    var body: some View {
        List {
            Section {
                ForEach(app.bootstrap?.chatModels ?? []) { model in
                    Button {
                        Task { await setDefault(model.id) }
                    } label: {
                        ModelRow(
                            model: model,
                            provider: app.bootstrap?.providers.first { $0.id == model.providerId },
                            isDefault: model.id == app.bootstrap?.defaultModelId
                        )
                    }
                    .disabled(busy || !model.isUsable)
                }
            } footer: {
                Text("点一下设为默认。新对话从这里开始。")
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Color.bg)
        .navigationTitle("对话模型")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func setDefault(_ id: ModelId) async {
        busy = true
        defer { busy = false }
        do {
            try await app.api.send(.setDefaultModel(id))
            await app.load()
        } catch let error as APIError {
            app.handle(error)
        } catch {}
    }
}

// MARK: - Capabilities

private struct CapabilitiesSettingsView: View {
    @Environment(AppModel.self) private var app
    @State private var tavily = ""
    @State private var embedding = ""
    @State private var busy = false

    private var caps: Capabilities? { app.bootstrap?.capabilities }

    var body: some View {
        List {
            if let caps {
                Section("记忆") {
                    toggle("启用", caps.memory.enabled) { await patch(["memory": ["enabled": $0]]) }
                    toggle("允许写入", caps.memory.writeEnabled) { await patch(["memory": ["writeEnabled": $0]]) }
                }
                Section("文件") {
                    toggle("启用", caps.files.enabled) { await patch(["files": ["enabled": $0]]) }
                    toggle("检索", caps.files.searchEnabled) { await patch(["files": ["searchEnabled": $0]]) }
                    LabeledContent("模式", value: caps.files.mode)
                }
                Section("联网搜索") {
                    toggle("启用", caps.web.enabled) { await patch(["web": ["enabled": $0]]) }
                    LabeledContent("提供方", value: caps.web.provider)
                    if !caps.web.hasTavilyKey {
                        SecureField("Tavily 密钥", text: $tavily)
                        Button("保存密钥") { Task { await saveSecret("tavily", tavily) } }
                            .disabled(tavily.isEmpty || busy)
                    } else {
                        Badge(text: "已配置", tone: .ok)
                    }
                }
                Section("代码") {
                    toggle("读", caps.coding.read) { await patch(["coding": ["read": $0]]) }
                    toggle("写", caps.coding.write) { await patch(["coding": ["write": $0]]) }
                    toggle("命令行", caps.coding.shell) { await patch(["coding": ["shell": $0]]) }
                    LabeledContent("工作区") {
                        Text(caps.coding.workspace).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
                Section("创作台") {
                    toggle("启用", caps.studio.enabled) { await patch(["studio": ["enabled": $0]]) }
                }
                Section("嵌入") {
                    SecureField("嵌入密钥", text: $embedding)
                    Button("保存密钥") { Task { await saveSecret("embedding", embedding) } }
                        .disabled(embedding.isEmpty || busy)
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Color.bg)
        .navigationTitle("能力")
        .navigationBarTitleDisplayMode(.inline)
        .disabled(busy)
    }

    private func toggle(_ title: String, _ on: Bool, _ set: @escaping (Bool) async -> Void) -> some View {
        Toggle(title, isOn: Binding(
            get: { on },
            set: { next in Task { await set(next) } }
        ))
    }

    private func patch(_ body: [String: [String: Bool]]) async {
        busy = true
        defer { busy = false }
        do {
            try await app.api.send(.patchCapabilities(body))
            await app.load()
        } catch let error as APIError {
            app.handle(error)
        } catch {}
    }

    private func saveSecret(_ name: String, _ value: String) async {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        busy = true
        defer { busy = false }
        do {
            try await app.api.send(.putSecret(name, value: trimmed))
            if name == "tavily" { tavily = "" } else { embedding = "" }
            await app.load()
        } catch let error as APIError {
            app.handle(error)
        } catch {}
    }
}

// MARK: - Prompts

private struct PromptsSettingsView: View {
    @Environment(AppModel.self) private var app
    @State private var draft: PromptSettings?
    @State private var busy = false

    var body: some View {
        Form {
            if var prompts = draft ?? app.bootstrap?.prompts {
                Section("全局") {
                    TextEditor(text: Binding(
                        get: { prompts.globalPrompt },
                        set: { prompts.globalPrompt = $0; draft = prompts }
                    ))
                    .frame(minHeight: 120)
                }
                Section("工具") {
                    TextEditor(text: Binding(
                        get: { prompts.toolPrompt },
                        set: { prompts.toolPrompt = $0; draft = prompts }
                    ))
                    .frame(minHeight: 80)
                }
                Section {
                    Toggle("生成标题", isOn: Binding(
                        get: { prompts.titleEnabled },
                        set: { prompts.titleEnabled = $0; draft = prompts }
                    ))
                    Button("保存") { Task { await save(prompts) } }
                        .disabled(busy)
                    Button("恢复默认") { Task { await restore() } }
                        .disabled(busy)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Color.bg)
        .navigationTitle("提示词")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if draft == nil { draft = app.bootstrap?.prompts }
        }
    }

    private func save(_ prompts: PromptSettings) async {
        busy = true
        defer { busy = false }
        do {
            draft = try await app.api.send(.savePrompts(prompts), as: PromptSettings.self)
            await app.load()
        } catch let error as APIError {
            app.handle(error)
        } catch {}
    }

    private func restore() async {
        busy = true
        defer { busy = false }
        do {
            let defaults = try await app.api.send(.promptDefaults(), as: PromptDefaults.self)
            var next = draft ?? app.bootstrap?.prompts
            next?.globalPrompt = defaults.globalPrompt
            next?.toolPrompt = defaults.toolPrompt
            draft = next
        } catch let error as APIError {
            app.handle(error)
        } catch {}
    }
}

// MARK: - MCP (status)

private struct McpSettingsView: View {
    @Environment(AppModel.self) private var app
    @State private var busy = false

    var body: some View {
        List {
            ForEach(app.bootstrap?.mcp ?? []) { server in
                HStack(spacing: Space.md) {
                    Circle()
                        .fill(server.connected ? Color.ok : (server.enabled ? Color.warn : Color.mutedFg))
                        .frame(width: 8, height: 8)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(server.title)
                        if let error = server.error, !error.isEmpty {
                            Text(error).font(.caption).foregroundStyle(Color.danger).lineLimit(2)
                        } else {
                            Text("\(server.tools.count) 个工具").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    if server.studioOnly == true { Badge(text: "仅创作台") }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Color.bg)
        .navigationTitle("扩展")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { await reconnect() }
                } label: {
                    if busy {
                        Spinner()
                    } else {
                        Label("重新连接", systemImage: "arrow.clockwise")
                    }
                }
                .disabled(busy)
            }
        }
    }

    /// A stdio server that died, or a remote one that was down when the process
    /// started, stays disconnected until something asks again. The rows come out
    /// of `bootstrap`, so the status is only visibly new once that is re-read.
    private func reconnect() async {
        busy = true
        defer { busy = false }
        do {
            try await app.api.send(.reconnectMcp())
            await app.load()
            app.note("已重新连接")
        } catch let error as APIError {
            app.handle(error)
        } catch {}
    }
}

private struct SectionHeader: View {
    let title: String
    let symbol: String

    var body: some View {
        Label(title, systemImage: symbol)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(Color.mutedFg)
            .textCase(nil)
    }
}

private struct ModelRow: View {
    let model: ModelSpec
    let provider: Provider?
    let isDefault: Bool

    var body: some View {
        HStack(spacing: Space.md) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Space.xs) {
                    Text(model.name).lineLimit(1)
                    if isDefault { Badge(text: "默认", tone: .brand) }
                }
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: Space.sm)
            if needsKey { Badge(text: "缺少密钥", tone: .warn) }
        }
    }

    private var subtitle: String {
        [provider?.name ?? model.providerId.raw, model.apiMode].joined(separator: " · ")
    }

    private var needsKey: Bool {
        guard let provider else { return false }
        if provider.isKeyless { return false }
        if model.apiMode == "comfy-workflow" { return false }
        return !provider.hasKey
    }
}
