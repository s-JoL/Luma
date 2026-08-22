import SwiftUI

/// 设置 → 能力. What the agent is allowed to do, and what it needs in order to
/// do it.
///
/// Switches write as they are flipped; anything typed is saved by its own
/// section's button. A text field has no blur on iOS, so committing on every
/// keystroke would `PATCH` once per character, and committing on 完成 alone
/// would silently drop what was typed when the reader scrolled instead.
struct CapabilitiesSettingsView: View {
    let settings: SettingsStore

    @State private var draft = CapabilityDraft()
    @State private var tavilyKey = ""
    @State private var embeddingKey = ""

    private var caps: Capabilities? { settings.capabilities }

    var body: some View {
        List {
            if let caps {
                webSection(caps)
                filesSection(caps)
                embeddingSection(caps)
                memorySection(caps)
                studioSection(caps)
                codingSection(caps)
            }
        }
        .formChrome("能力")
        .overlay {
            if caps == nil { ProgressView() }
        }
        .task {
            await settings.loadCapabilities()
            if let caps = settings.capabilities { draft = CapabilityDraft(caps) }
        }
    }

    // MARK: Web

    @ViewBuilder
    private func webSection(_ caps: Capabilities) -> some View {
        Section {
            Toggle("启用 web_search", isOn: bind(caps.web.enabled) {
                CapabilitiesPatch(web: .init(enabled: $0))
            })
            Picker("后端", selection: bind(caps.web.provider) {
                CapabilitiesPatch(web: .init(provider: $0))
            }) {
                ForEach(SearchProviders.all, id: \.id) { option in
                    Text(option.label).tag(option.id)
                }
            }
            if caps.web.provider == "searxng" {
                TextField("http://127.0.0.1:8080", text: $draft.searxngUrl)
                    .keyboardType(.URL)
                    .exactEntry()
                WriteButton(
                    title: "保存地址",
                    isWriting: settings.isWriting,
                    isEnabled: draft.searxngUrl != (caps.web.baseUrl ?? ""),
                    action: {
                        Task { await save(CapabilitiesPatch(web: .init(baseUrl: draft.searxngUrl))) }
                    }
                )
            } else {
                SecretRow(
                    title: "密钥",
                    placeholder: caps.web.hasTavilyKey ? "替换 Tavily 密钥" : "tvly-…",
                    hasValue: caps.web.hasTavilyKey,
                    isWriting: settings.isWriting,
                    draft: $tavilyKey,
                    save: { Task { await saveSecret("tavily", $tavilyKey) } },
                    clear: { Task { await settings.clearSecret("tavily") } }
                )
            }
        } header: {
            HStack {
                Text("联网搜索").textCase(nil)
                Spacer()
                Badge(text: webState(caps).text, tone: webState(caps).tone)
            }
        } footer: {
            Text(caps.web.provider == "searxng"
                 ? "自托管实例的根地址，不需要密钥。"
                 : "Tavily 按查询计费，密钥只提交、不回读。")
        }
    }

    private func webState(_ caps: Capabilities) -> (text: String, tone: Badge.Tone) {
        if caps.web.provider == "searxng" {
            let configured = !(caps.web.baseUrl ?? "").isEmpty
            return (configured ? "已配置实例" : "缺少实例地址", configured ? .ok : .warn)
        }
        return caps.web.hasTavilyKey ? ("已配置", .ok) : ("缺少密钥", .warn)
    }

    // MARK: Files

    private func filesSection(_ caps: Capabilities) -> some View {
        Section {
            Toggle("允许上传文件", isOn: bind(caps.files.enabled) {
                CapabilitiesPatch(files: .init(enabled: $0))
            })
            Toggle("启用 file_search", isOn: bind(caps.files.searchEnabled) {
                CapabilitiesPatch(files: .init(searchEnabled: $0))
            })
            Picker("检索方式", selection: bind(caps.files.mode) {
                CapabilitiesPatch(files: .init(mode: $0))
            }) {
                ForEach(FileSearchModes.all, id: \.id) { option in
                    Text(option.label).tag(option.id)
                }
            }
        } header: {
            Text("文件检索").textCase(nil)
        } footer: {
            Text("混合是语义加关键词。没有嵌入模型时，语义那一半拿不到结果。")
        }
    }

    // MARK: Embedding

    private func embeddingSection(_ caps: Capabilities) -> some View {
        Section {
            LabeledContent("Base URL") {
                TextField("https://api.example.com/v1", text: $draft.embeddingUrl)
                    .multilineTextAlignment(.trailing)
                    .keyboardType(.URL)
                    .exactEntry()
            }
            LabeledContent("模型") {
                TextField("text-embedding-3-small", text: $draft.embeddingModel)
                    .multilineTextAlignment(.trailing)
                    .exactEntry()
            }
            LabeledContent("切片大小") {
                TextField("1200", value: $draft.chunkSize, format: .number)
                    .multilineTextAlignment(.trailing)
                    .keyboardType(.numberPad)
            }
            LabeledContent("切片重叠") {
                TextField("150", value: $draft.chunkOverlap, format: .number)
                    .multilineTextAlignment(.trailing)
                    .keyboardType(.numberPad)
            }
            WriteButton(
                title: "保存嵌入配置",
                isWriting: settings.isWriting,
                isEnabled: draft.embeddingChanged(from: caps),
                action: { Task { await save(draft.embeddingPatch) } }
            )
            SecretRow(
                title: "密钥",
                placeholder: caps.embedding.hasKey ? "替换密钥" : "sk-…",
                hasValue: caps.embedding.hasKey,
                isWriting: settings.isWriting,
                draft: $embeddingKey,
                save: { Task { await saveSecret("embedding", $embeddingKey) } },
                clear: { Task { await settings.clearSecret("embedding") } }
            )
            rebuildRow
        } header: {
            HStack {
                Text("嵌入").textCase(nil)
                Spacer()
                Badge(
                    text: caps.embedding.hasKey ? "已配置" : "缺少密钥",
                    tone: caps.embedding.hasKey ? .ok : .warn
                )
            }
        } footer: {
            Text("切片大小按字符算，一般 1000–1500，重叠取其中一到两成。改完只影响新文件，已经索引过的要按上面的按钮重建。")
        }
    }

    @ViewBuilder
    private var rebuildRow: some View {
        let progress = settings.rebuild
        WriteButton(
            title: "重建全部文档",
            isWriting: progress?.running == true,
            action: { Task { await settings.rebuildIndex() } }
        )
        if let progress {
            if progress.running {
                Text("重建中 \(progress.done)/\(progress.total)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            } else {
                Text("已重建 \(progress.done - progress.failed) 个，失败 \(progress.failed) 个")
                    .font(.caption)
                    .foregroundStyle(progress.failed > 0 ? Color.danger : Color.mutedFg)
                    .monospacedDigit()
            }
        }
    }

    // MARK: Memory

    private func memorySection(_ caps: Capabilities) -> some View {
        Section {
            Toggle("注入到系统提示", isOn: bind(caps.memory.enabled) {
                CapabilitiesPatch(memory: .init(enabled: $0))
            })
            Toggle("允许模型写入", isOn: bind(caps.memory.writeEnabled) {
                CapabilitiesPatch(memory: .init(writeEnabled: $0))
            })
            LabeledContent("Token 上限") {
                TextField("16000", value: $draft.tokenLimit, format: .number)
                    .multilineTextAlignment(.trailing)
                    .keyboardType(.numberPad)
            }
            LabeledContent("单条字符上限") {
                TextField("10000", value: $draft.charLimit, format: .number)
                    .multilineTextAlignment(.trailing)
                    .keyboardType(.numberPad)
            }
            TextField("建议键，逗号分隔", text: $draft.suggestedKeys).exactEntry()
            WriteButton(
                title: "保存记忆设置",
                isWriting: settings.isWriting,
                isEnabled: draft.memoryChanged(from: caps),
                action: { Task { await save(draft.memoryPatch) } }
            )
        } header: {
            Text("记忆").textCase(nil)
        } footer: {
            Text("建议键只是给模型的起点，它仍然可以自己起名。不合法的键会被服务端丢掉。")
        }
    }

    // MARK: Studio

    private func studioSection(_ caps: Capabilities) -> some View {
        Section {
            Toggle("启用创作台", isOn: bind(caps.studio.enabled) {
                CapabilitiesPatch(studio: .init(enabled: $0))
            })
        } header: {
            Text("创作台").textCase(nil)
        }
    }

    // MARK: Coding

    private func codingSection(_ caps: Capabilities) -> some View {
        Section {
            Toggle("读取", isOn: bind(caps.coding.read) {
                CapabilitiesPatch(coding: .init(read: $0))
            })
            Toggle("写入", isOn: bind(caps.coding.write) {
                CapabilitiesPatch(coding: .init(write: $0))
            })
            Toggle("执行命令", isOn: bind(caps.coding.shell) {
                CapabilitiesPatch(coding: .init(shell: $0))
            })
            TextField("工作目录", text: $draft.workspace)
                .font(.caption.monospaced())
                .exactEntry()
            WriteButton(
                title: "保存工作目录",
                isWriting: settings.isWriting,
                isEnabled: draft.workspace != caps.coding.workspace,
                action: {
                    Task { await save(CapabilitiesPatch(coding: .init(workspace: draft.workspace))) }
                }
            )
        } header: {
            HStack {
                Text("代码").textCase(nil)
                Spacer()
                Badge(text: "高权限", tone: .warn)
            }
        } footer: {
            Text("模型可以在这个目录里读文件、改文件、跑命令。只在你清楚风险时打开。")
        }
    }

    // MARK: Writing

    /// A switch reads the server's value and writes a one-field patch. It is not
    /// bound to local state on purpose: an optimistic flip that the server then
    /// refuses would leave the screen claiming a capability is on.
    private func bind<Value>(
        _ value: Value, _ patch: @escaping (Value) -> CapabilitiesPatch
    ) -> Binding<Value> {
        Binding(
            get: { value },
            set: { next in Task { await self.patch(patch(next)) } }
        )
    }

    private func patch(_ body: CapabilitiesPatch) async {
        await settings.patchCapabilities(body, note: "已保存")
    }

    /// A typed section, which reads its own fields back afterwards. The server
    /// clamps a chunk size and drops a malformed memory key, so the draft has to
    /// be told what was actually stored or the 保存 button stays lit against a
    /// value that will never be accepted.
    ///
    /// Only these three do it. Re-reading the draft after a switch was flipped
    /// would throw away a URL someone was half-way through typing in another
    /// section.
    private func save(_ body: CapabilitiesPatch) async {
        if await settings.patchCapabilities(body, note: "已保存"), let caps = settings.capabilities {
            draft = CapabilityDraft(caps)
        }
    }

    private func saveSecret(_ name: String, _ field: Binding<String>) async {
        let value = field.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        if await settings.saveSecret(name, value: value) { field.wrappedValue = "" }
    }
}

/// The typed half of 能力, held apart from the switches. Every field here is
/// something a person is part-way through writing, so it is only read back off
/// the server once a save has landed.
private struct CapabilityDraft {
    var searxngUrl = ""
    var embeddingUrl = ""
    var embeddingModel = ""
    var chunkSize = 0
    var chunkOverlap = 0
    var tokenLimit = 0
    var charLimit = 0
    var suggestedKeys = ""
    var workspace = ""

    init() {}

    init(_ caps: Capabilities) {
        searxngUrl = caps.web.baseUrl ?? ""
        embeddingUrl = caps.embedding.baseUrl
        embeddingModel = caps.embedding.model
        chunkSize = caps.embedding.chunkSize
        chunkOverlap = caps.embedding.chunkOverlap
        tokenLimit = caps.memory.tokenLimit
        charLimit = caps.memory.charLimit
        suggestedKeys = caps.memory.suggestedKeys.joined(separator: ", ")
        workspace = caps.coding.workspace
    }

    func embeddingChanged(from caps: Capabilities) -> Bool {
        embeddingUrl != caps.embedding.baseUrl
            || embeddingModel != caps.embedding.model
            || chunkSize != caps.embedding.chunkSize
            || chunkOverlap != caps.embedding.chunkOverlap
    }

    func memoryChanged(from caps: Capabilities) -> Bool {
        tokenLimit != caps.memory.tokenLimit
            || charLimit != caps.memory.charLimit
            || keys != caps.memory.suggestedKeys
    }

    var embeddingPatch: CapabilitiesPatch {
        CapabilitiesPatch(embedding: .init(
            baseUrl: embeddingUrl.trimmingCharacters(in: .whitespacesAndNewlines),
            model: embeddingModel.trimmingCharacters(in: .whitespacesAndNewlines),
            chunkSize: chunkSize,
            chunkOverlap: chunkOverlap
        ))
    }

    var memoryPatch: CapabilitiesPatch {
        CapabilitiesPatch(memory: .init(
            suggestedKeys: keys,
            tokenLimit: tokenLimit,
            charLimit: charLimit
        ))
    }

    private var keys: [String] {
        suggestedKeys
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }
}
