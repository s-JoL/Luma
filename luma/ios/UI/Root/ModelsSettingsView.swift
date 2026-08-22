import SwiftUI

/// 设置 → 对话模型. The models a conversation can run on, kept apart from the
/// generation backends because almost nothing is shared: a context window and a
/// thinking level mean nothing to an image model, and an aspect ratio means
/// nothing here.
///
/// Unlike the switcher, this list shows disabled and unconfigured rows. Hiding
/// them would hide the one screen where 停用 can be undone and 缺少密钥 can be
/// explained.
struct ModelsSettingsView: View {
    let settings: SettingsStore

    @State private var adding = false
    @State private var deleting: ModelSpec?

    var body: some View {
        List {
            if !settings.providers.isEmpty {
                Section {
                    NavigationLink {
                        DiscoverModelsView(settings: settings)
                    } label: {
                        Label("从提供方拉取", systemImage: "square.and.arrow.down")
                    }
                } footer: {
                    Text("有密钥就能列出网关上的全部模型，勾选后一次加进来。")
                }
            }

            Section {
                ForEach(settings.chatModels) { model in
                    NavigationLink {
                        ModelEditorView(settings: settings, model: model)
                    } label: {
                        ModelRow(
                            model: model,
                            provider: settings.provider(model.providerId),
                            isDefault: model.id.raw == settings.catalogue.defaultModelId
                        )
                    }
                    .swipeActions(edge: .leading) {
                        Button(model.pinned ? "取消固定" : "固定") {
                            Task { await pin(model) }
                        }
                        .tint(Color.warn)
                        Button(model.enabled ? "停用" : "启用") {
                            Task { await enable(model) }
                        }
                        .tint(model.enabled ? Color.mutedFg : Color.ok)
                    }
                    .swipeActions(edge: .trailing) {
                        Button("删除", role: .destructive) { deleting = model }
                    }
                }
            } header: {
                SectionHeader(title: "对话模型", symbol: "cpu")
            } footer: {
                Text("固定的模型出现在对话右上角的切换器里。默认模型是新对话的起点。")
            }
        }
        .formChrome("对话模型")
        .overlay {
            if settings.chatModels.isEmpty {
                if settings.isLoading {
                    ProgressView()
                } else if settings.providers.isEmpty {
                    ContentUnavailableView(
                        "还没有提供方",
                        systemImage: "powerplug",
                        description: Text("先在「提供方」里加一个端点，模型才有地方可去。")
                    )
                } else {
                    ContentUnavailableView(
                        "还没有对话模型",
                        systemImage: "cpu",
                        description: Text("从提供方拉一份列表，或者手动添加一个。")
                    )
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { adding = true } label: { Label("添加", systemImage: "plus") }
                    .disabled(settings.isWriting || settings.providers.isEmpty)
            }
        }
        .task { await settings.loadCatalogue() }
        .refreshable { await settings.loadCatalogue() }
        .sheet(isPresented: $adding) {
            NavigationStack {
                ModelEditorView(settings: settings, model: nil)
            }
        }
        .alert("删除模型", isPresented: .constant(deleting != nil), presenting: deleting) { model in
            Button("取消", role: .cancel) { deleting = nil }
            Button("删除", role: .destructive) {
                let target = model
                deleting = nil
                Task { await settings.deleteModel(target.id) }
            }
        } message: { model in
            Text("「\(model.name)」会从列表和切换器里去掉。已有对话的记录都还在，但停在这个模型上的对话要先换一个才能继续。")
        }
    }

    /// One field per swipe. A whole row would be a merge of a form nobody
    /// filled in, and `PATCH` keeps what it is not sent.
    private func pin(_ model: ModelSpec) async {
        await settings.updateModel(
            model.id,
            ModelInput(pinned: !model.pinned),
            note: model.pinned ? "已取消固定" : "已固定"
        )
    }

    private func enable(_ model: ModelSpec) async {
        await settings.updateModel(
            model.id,
            ModelInput(enabled: !model.enabled),
            note: model.enabled ? "已停用" : "已启用"
        )
    }
}

// MARK: - Editor

/// One model, new or existing. The same form for both: the fields a model needs
/// are the fields it keeps, and a separate "add" form is how the two end up
/// offering different options for the same thing.
private struct ModelEditorView: View {
    let settings: SettingsStore
    let model: ModelSpec?

    @Environment(\.dismiss) private var dismiss
    @State private var draft: ModelDraft
    @State private var deleting = false

    init(settings: SettingsStore, model: ModelSpec?) {
        self.settings = settings
        self.model = model
        _draft = State(initialValue: model.map(ModelDraft.init) ?? ModelDraft(providerId: settings.providers.first?.id.raw ?? ""))
    }

    private var isNew: Bool { model == nil }

    private var isDefault: Bool {
        model?.id.raw == settings.catalogue.defaultModelId
    }

    var body: some View {
        Form {
            Section {
                TextField("显示名称", text: $draft.name)
                if isNew {
                    TextField("标识，例如 grok-4.6", text: $draft.id).exactEntry()
                }
            } header: {
                Text("名称").textCase(nil)
            } footer: {
                if isNew {
                    Text("标识是这台服务器上的唯一名字，创建之后不能再改。留空就按提供方和模型 ID 生成一个。")
                }
            }

            Section {
                Picker("提供方", selection: $draft.providerId) {
                    ForEach(settings.providers) { provider in
                        Text(provider.name).tag(provider.id.raw)
                    }
                }
                TextField("模型 ID", text: $draft.model).exactEntry()
                Picker("接口模式", selection: $draft.apiMode) {
                    ForEach(ApiModes.chat) { mode in
                        Text(mode.label).tag(mode.id)
                    }
                }
            } header: {
                Text("后端").textCase(nil)
            } footer: {
                Text("请求地址：\(endpoint)")
            }

            Section {
                LabeledContent("上下文窗口") {
                    TextField("128000", value: $draft.contextWindow, format: .number)
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.trailing)
                }
                LabeledContent("最大输出") {
                    TextField("8192", value: $draft.maxTokens, format: .number)
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.trailing)
                }
                LabeledContent("温度") {
                    TextField("跟随服务端", text: $draft.temperature)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                }
            } header: {
                Text("上限").textCase(nil)
            } footer: {
                Text("温度留空就用服务端默认，不再覆盖。")
            }

            Section {
                Toggle("启用", isOn: $draft.enabled)
                Toggle("固定到切换器", isOn: $draft.pinned)
                Toggle("推理模型", isOn: $draft.reasoning)
                if draft.reasoning {
                    Picker("思考等级", selection: $draft.thinkingLevel) {
                        ForEach(ThinkingLevels.all, id: \.self) { level in
                            Text(level).tag(level)
                        }
                    }
                }
                Toggle("支持图片输入", isOn: $draft.acceptsImages)
                Toggle("精简请求体", isOn: $draft.librechatCompat)
            } header: {
                Text("行为").textCase(nil)
            } footer: {
                Text("部分网关不接受完整字段，打开「精简请求体」后只发它们认的那些。")
            }

            Section {
                TextEditor(text: $draft.systemPrompt)
                    .frame(minHeight: 80)
            } header: {
                Text("模型专属系统提示").textCase(nil)
            } footer: {
                Text("留空就用「提示词」里的全局提示。")
            }

            Section {
                WriteButton(
                    title: isNew ? "添加" : "保存",
                    isWriting: settings.isWriting,
                    isEnabled: draft.isReady,
                    action: { Task { await save() } }
                )
                if let model, !isDefault {
                    WriteButton(
                        title: "设为默认",
                        isWriting: settings.isWriting,
                        isEnabled: model.enabled,
                        action: { Task { await settings.setDefaultModel(model.id) } }
                    )
                }
                if model != nil {
                    WriteButton(
                        title: "删除模型",
                        role: .destructive,
                        isWriting: settings.isWriting,
                        action: { deleting = true }
                    )
                }
            } footer: {
                if isDefault {
                    Text("这是新对话的默认模型。")
                }
            }
        }
        .formChrome(model?.name ?? "新建模型")
        .toolbar {
            if isNew {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }.disabled(settings.isWriting)
                }
            }
        }
        .interactiveDismissDisabled(settings.isWriting)
        .alert("删除模型", isPresented: $deleting) {
            Button("取消", role: .cancel) {}
            Button("删除", role: .destructive) { Task { await remove() } }
        } message: {
            Text("「\(model?.name ?? "")」会从列表和切换器里去掉。已有对话的记录都还在，但停在这个模型上的对话要先换一个才能继续。")
        }
    }

    private var endpoint: String {
        let base = settings.providers.first { $0.id.raw == draft.providerId }?.baseUrl ?? "…"
        return base + ApiModes.path(draft.apiMode)
    }

    private func save() async {
        let ok: Bool
        if let model {
            ok = await settings.updateModel(model.id, draft.input(isNew: false), note: "已保存")
        } else {
            ok = await settings.createModel(draft.input(isNew: true))
        }
        if ok, isNew { dismiss() }
    }

    private func remove() async {
        guard let model else { return }
        if await settings.deleteModel(model.id) { dismiss() }
    }
}

private struct ModelDraft {
    var id = ""
    var name = ""
    var providerId = ""
    var model = ""
    var apiMode = "openai-chat"
    var contextWindow = 128_000
    var maxTokens = 8192
    var temperature = ""
    var thinkingLevel = "off"
    var enabled = true
    var pinned = true
    var reasoning = false
    var acceptsImages = false
    var librechatCompat = false
    var systemPrompt = ""

    init(providerId: String = "") {
        self.providerId = providerId
    }

    init(_ spec: ModelSpec) {
        id = spec.id.raw
        name = spec.name
        providerId = spec.providerId.raw
        model = spec.model
        apiMode = spec.apiMode
        contextWindow = spec.contextWindow
        maxTokens = spec.maxTokens
        temperature = spec.temperature.map { String($0) } ?? ""
        thinkingLevel = spec.thinkingLevel
        enabled = spec.enabled
        pinned = spec.pinned
        reasoning = spec.reasoning
        acceptsImages = spec.acceptsImages
        librechatCompat = spec.librechatCompat
        systemPrompt = spec.systemPrompt ?? ""
    }

    var isReady: Bool {
        !providerId.isEmpty && !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Only a new row carries an id: `PATCH` takes it from the path, and the
    /// server refuses to rename one anyway.
    func input(isNew: Bool) -> ModelInput {
        let remote = model.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let identifier = id.trimmingCharacters(in: .whitespacesAndNewlines)
        return ModelInput(
            id: isNew && !identifier.isEmpty ? identifier : nil,
            providerId: providerId,
            model: remote,
            name: title.isEmpty ? remote : title,
            kind: .chat,
            enabled: enabled,
            pinned: pinned,
            reasoning: reasoning,
            input: acceptsImages ? ["text", "image"] : ["text"],
            contextWindow: contextWindow,
            maxTokens: maxTokens,
            // A model that is not a reasoning model has no thinking level to
            // send, and leaving a stale one behind is how a plain chat model
            // ends up asking for a budget its endpoint rejects.
            thinkingLevel: reasoning ? thinkingLevel : "off",
            apiMode: apiMode,
            librechatCompat: librechatCompat,
            systemPrompt: systemPrompt.trimmingCharacters(in: .whitespacesAndNewlines),
            temperature: temperatureInput
        )
    }

    /// An emptied field is an instruction to stop overriding, which is the one
    /// thing omitting the field cannot say.
    private var temperatureInput: NumberPatch? {
        let typed = temperature.trimmingCharacters(in: .whitespacesAndNewlines)
        if typed.isEmpty { return .clear }
        guard let value = Double(typed) else { return nil }
        return .set(value)
    }
}

// MARK: - Discovery

/// The provider's live catalogue. An aggregator lists hundreds of models, so
/// this is a filter-and-tick list rather than a picker: narrow it, tick the few
/// you want, add them in one write, adjust the details afterwards.
private struct DiscoverModelsView: View {
    let settings: SettingsStore

    @State private var providerId: ProviderId?
    @State private var needle = ""
    @State private var picked: Set<String> = []

    private var listable: [Provider] { settings.providers.filter(settings.canDiscover) }

    private var active: ProviderId? { providerId ?? listable.first?.id }

    /// A pulled list belongs to the provider it came from. Showing it under
    /// another one would offer to add someone else's models to a gateway that
    /// has never heard of them.
    private var isCurrent: Bool { settings.discoveredFor != nil && settings.discoveredFor == active }

    /// What is worth offering.
    ///
    /// A row the server marked `coveredBy` is the other half of a model already
    /// in this list — Seedream lists an edit twin beside the model it belongs to
    /// — and ticking both would put two catalogue rows behind one thing. The
    /// server decides which is the twin; the client only has to not show it.
    private var offerable: [DiscoveredModel] {
        settings.discovered.filter(\.isOfferable)
    }

    private var visible: [DiscoveredModel] {
        let text = needle.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !text.isEmpty else { return offerable }
        return offerable.filter { $0.model.lowercased().contains(text) }
    }

    var body: some View {
        List {
            Section {
                Picker("提供方", selection: Binding(
                    get: { active?.raw ?? "" },
                    set: { providerId = ProviderId($0) }
                )) {
                    ForEach(listable) { provider in
                        Text(provider.name).tag(provider.id.raw)
                    }
                }
                WriteButton(
                    title: isCurrent ? "重新拉取" : "拉取列表",
                    isWriting: settings.isDiscovering,
                    isEnabled: active != nil,
                    action: { Task { await pull() } }
                )
            } footer: {
                Text(listable.count == settings.providers.count
                     ? "类型和上下文先猜一遍，保存后还能在模型页里改。"
                     : "只有已配置密钥或声明不带凭证的提供方能列出模型。")
            }

            if isCurrent {
                Section {
                    ForEach(visible) { item in
                        row(item)
                    }
                } header: {
                    Text("\(offerable.count) 个模型").textCase(nil)
                } footer: {
                    Text("灰掉的已经在列表里了。")
                }
            }
        }
        .formChrome("从提供方拉取")
        .searchable(text: $needle, prompt: "在拉到的列表里筛选")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                WriteButton(
                    title: "添加（\(picked.count)）",
                    isWriting: settings.isWriting,
                    isEnabled: !picked.isEmpty,
                    action: { Task { await add() } }
                )
            }
        }
        .task {
            // Pulling costs a round trip to someone else's API, so a list
            // already in hand for this provider is left alone.
            if !isCurrent { await pull() }
        }
        .onChange(of: active) { _, _ in Task { await pull() } }
    }

    private func row(_ item: DiscoveredModel) -> some View {
        Button {
            if picked.remove(item.model) == nil { picked.insert(item.model) }
        } label: {
            HStack(spacing: Space.md) {
                Image(systemName: picked.contains(item.model) ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(picked.contains(item.model) ? Color.brand : Color.mutedFg)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.model).lineLimit(1).truncationMode(.middle)
                    Text(describe(item.suggestion))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: Space.sm)
                if item.added { Badge(text: "已添加", tone: .ok) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(item.added ? Color.mutedFg : Color.fg)
        .disabled(item.added || settings.isWriting)
    }

    private func describe(_ suggestion: DiscoveredModel.Suggestion) -> String {
        var parts = [suggestion.kind.rawValue, ApiModes.label(suggestion.apiMode)]
        if !suggestion.ops.isEmpty {
            parts.append(suggestion.ops.map(\.rawValue).joined(separator: " / "))
        }
        if suggestion.reasoning { parts.append("推理") }
        if suggestion.input.contains("image") { parts.append("图片输入") }
        return parts.joined(separator: " · ")
    }

    private func pull() async {
        guard let active else { return }
        picked = []
        await settings.discover(active)
    }

    private func add() async {
        guard let active, !picked.isEmpty else { return }
        let chosen = offerable
            .filter { picked.contains($0.model) }
            .map { $0.input(providerId: active) }
        if await settings.importModels(ModelImport(providerId: active.raw, models: chosen)) {
            picked = []
            await settings.discover(active)
        }
    }
}
