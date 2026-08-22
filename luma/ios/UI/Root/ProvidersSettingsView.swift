import SwiftUI

/// 设置 → 提供方. Endpoints and credentials, which belong to no one audience: an
/// OpenAI key and a ComfyUI address are the same kind of row, and a gateway
/// answering for both a chat model and an image model is one provider either way.
struct ProvidersSettingsView: View {
    let settings: SettingsStore

    @State private var adding = false
    @State private var deleting: Provider?

    var body: some View {
        List {
            Section {
                ForEach(settings.providers) { provider in
                    NavigationLink {
                        ProviderDetailView(settings: settings, provider: provider)
                    } label: {
                        row(provider)
                    }
                    .swipeActions(edge: .trailing) {
                        Button("删除", role: .destructive) { deleting = provider }
                    }
                }
            } header: {
                SectionHeader(title: "提供方", symbol: "powerplug")
            } footer: {
                Text("一个网关可以同时挂对话、生图和视频。密钥只提交，之后无法再读出来。")
            }
        }
        .formChrome("提供方")
        .overlay {
            if settings.providers.isEmpty {
                if settings.isLoading {
                    ProgressView()
                } else {
                    ContentUnavailableView(
                        "还没有提供方",
                        systemImage: "powerplug",
                        description: Text("先加一个端点，模型才有地方可去。")
                    )
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { adding = true } label: { Label("添加", systemImage: "plus") }
                    .disabled(settings.isWriting)
            }
        }
        .task { await settings.loadCatalogue() }
        .refreshable { await settings.loadCatalogue() }
        .sheet(isPresented: $adding) {
            ProviderFormSheet(settings: settings)
        }
        .alert("删除提供方", isPresented: .constant(deleting != nil), presenting: deleting) { provider in
            Button("取消", role: .cancel) { deleting = nil }
            Button("删除", role: .destructive) {
                let target = provider
                deleting = nil
                Task { await settings.deleteProvider(target.id) }
            }
        } message: { provider in
            Text(lost(provider))
        }
    }

    private func row(_ provider: Provider) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            HStack(spacing: Space.xs) {
                Text(provider.name)
                if provider.isKeyless {
                    Badge(text: "无需密钥")
                } else if provider.hasKey {
                    Badge(text: "已配置", tone: .ok)
                } else {
                    Badge(text: "缺少密钥", tone: .warn)
                }
                if !provider.enabled { Badge(text: "已停用", tone: .warn) }
            }
            Text(provider.baseUrl)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }

    /// Deleting a provider takes its models with it — `models.provider_id`
    /// cascades — and those rows are on a different screen, so the count is said
    /// here rather than discovered afterwards.
    private func lost(_ provider: Provider) -> String {
        let count = settings.catalogue.items.filter { $0.providerId == provider.id }.count
        let models = count > 0 ? "它下面的 \(count) 个模型会一起删除，" : ""
        return "「\(provider.name)」\(models)存的密钥也会清掉。"
    }
}

// MARK: - Detail

private struct ProviderDetailView: View {
    let settings: SettingsStore
    let provider: Provider

    @Environment(\.dismiss) private var dismiss
    @State private var draft: ProviderDraft
    @State private var key = ""
    @State private var deleting = false

    init(settings: SettingsStore, provider: Provider) {
        self.settings = settings
        self.provider = provider
        _draft = State(initialValue: ProviderDraft(provider))
    }

    /// The row this screen was pushed with is a snapshot. Saving reloads the
    /// catalogue, so the badges have to be read back out of the store or 已配置
    /// would still say 缺少密钥 with the key already stored.
    private var current: Provider { settings.provider(provider.id) ?? provider }

    var body: some View {
        Form {
            ProviderFields(draft: $draft)

            if draft.style != Provider.AuthConfig.Style.none {
                Section {
                    SecretRow(
                        title: "密钥",
                        placeholder: current.hasKey ? "替换密钥" : "API key",
                        hasValue: current.hasKey,
                        isWriting: settings.isWriting,
                        draft: $key,
                        save: { Task { await saveKey() } },
                        clear: { Task { await settings.clearProviderKey(provider.id) } }
                    )
                } header: {
                    Text("密钥").textCase(nil)
                } footer: {
                    Text(current.hasKey ? "已经存了一个。填新的会覆盖它。" : "只提交，之后无法再读出来。")
                }
            }

            Section {
                WriteButton(
                    title: "保存",
                    isWriting: settings.isWriting,
                    isEnabled: draft.isReady,
                    action: { Task { await save() } }
                )
                WriteButton(
                    title: "删除提供方",
                    role: .destructive,
                    isWriting: settings.isWriting,
                    action: { deleting = true }
                )
            }
        }
        .formChrome(provider.name)
        .alert("删除提供方", isPresented: $deleting) {
            Button("取消", role: .cancel) {}
            Button("删除", role: .destructive) { Task { await remove() } }
        } message: {
            Text(lost)
        }
    }

    private var lost: String {
        let count = settings.catalogue.items.filter { $0.providerId == provider.id }.count
        let models = count > 0 ? "它下面的 \(count) 个模型会一起删除，" : ""
        return "「\(provider.name)」\(models)存的密钥也会清掉。"
    }

    private func save() async {
        await settings.updateProvider(provider.id, draft.input())
    }

    private func saveKey() async {
        let value = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        if await settings.setProviderKey(provider.id, value: value) { key = "" }
    }

    private func remove() async {
        if await settings.deleteProvider(provider.id) { dismiss() }
    }
}

// MARK: - Add

private struct ProviderFormSheet: View {
    let settings: SettingsStore

    @Environment(\.dismiss) private var dismiss
    @State private var draft = ProviderDraft()
    @State private var key = ""

    var body: some View {
        NavigationStack {
            Form {
                ProviderFields(draft: $draft)
                if draft.style != Provider.AuthConfig.Style.none {
                    Section {
                        SecureField("API key（可以稍后再填）", text: $key)
                            .textContentType(.password)
                    } footer: {
                        Text("只提交，之后无法再读出来。")
                    }
                }
            }
            .formChrome("添加提供方")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }.disabled(settings.isWriting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    WriteButton(
                        title: "添加",
                        isWriting: settings.isWriting,
                        isEnabled: draft.isReady,
                        action: { Task { await add() } }
                    )
                }
            }
        }
        .interactiveDismissDisabled(settings.isWriting)
    }

    private func add() async {
        let typed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if await settings.createProvider(draft.input(apiKey: typed.isEmpty ? nil : typed)) {
            dismiss()
        }
    }
}

// MARK: - Shared fields

/// The fields a provider is made of, so the add sheet and the edit screen cannot
/// drift into disagreeing about what one is.
private struct ProviderFields: View {
    @Binding var draft: ProviderDraft

    var body: some View {
        Section {
            TextField("名称", text: $draft.name)
            TextField("https://api.example.com/v1", text: $draft.baseUrl)
                .keyboardType(.URL)
                .exactEntry()
        } header: {
            Text("端点").textCase(nil)
        }

        Section {
            Picker("鉴权方式", selection: $draft.style) {
                ForEach(Provider.AuthConfig.Style.allCases, id: \.self) { style in
                    Text(style.label).tag(style)
                }
            }
            if draft.style == .header {
                TextField("x-api-key", text: $draft.header).exactEntry()
                TextField("前缀（可选）", text: $draft.prefix).exactEntry()
            }
        } header: {
            Text("鉴权").textCase(nil)
        } footer: {
            if draft.style == .header {
                Text("\(draft.style.hint)。前缀写在密钥前面，例如 Bearer 加一个空格；留空就只发密钥。")
            } else {
                Text(draft.style.hint + "。")
            }
        }
    }
}

private struct ProviderDraft {
    var name = ""
    var baseUrl = ""
    var style = Provider.AuthConfig.Style.bearer
    var header = ""
    var prefix = ""

    init() {}

    init(_ provider: Provider) {
        name = provider.name
        baseUrl = provider.baseUrl
        style = provider.auth?.style ?? .bearer
        header = provider.auth?.header ?? ""
        prefix = provider.auth?.prefix ?? ""
    }

    /// A `header` style naming no header reads as bearer on the server, which
    /// would put the key in a place the gateway never looks and fail every
    /// request with an authentication error nobody can explain.
    var isReady: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !baseUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (style != .header || !header.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    /// Bearer travels as no auth object at all, which is what clears the stored
    /// style back to it.
    private var auth: ProviderAuthInput? {
        switch style {
        case .bearer: nil
        case .none: ProviderAuthInput(style: .none)
        case .header:
            ProviderAuthInput(
                style: .header,
                header: header.trimmingCharacters(in: .whitespacesAndNewlines),
                prefix: prefix
            )
        }
    }

    func input(apiKey: String? = nil) -> ProviderInput {
        ProviderInput(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            baseUrl: baseUrl.trimmingCharacters(in: .whitespacesAndNewlines),
            apiKey: style == Provider.AuthConfig.Style.none ? nil : apiKey,
            auth: auth
        )
    }
}
