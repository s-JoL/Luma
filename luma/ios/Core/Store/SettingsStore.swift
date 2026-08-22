import Foundation
import Observation

/// Everything 设置 administers: providers, models, generation slots, MCP
/// servers, capabilities and prompts.
///
/// It reads its own copies rather than working off `bootstrap`, for two reasons.
/// `bootstrap` is a snapshot taken at launch and filtered for *running* a
/// conversation — it drops nothing, but the screens that add a model need the
/// disabled rows too — and a list that has just been written to has to show the
/// write rather than the state the app started in. Every write still refreshes
/// `bootstrap` afterwards, because the model switcher and the studio read from
/// there and would otherwise keep offering a model that was deleted a second ago.
@MainActor
@Observable
final class SettingsStore {
    private(set) var providers: [Provider] = []
    private(set) var catalogue = ModelCatalogue()
    private(set) var mcp = McpServerList()
    private(set) var capabilities: Capabilities?
    private(set) var prompts: PromptSettings?
    private(set) var promptDefaults: PromptDefaults?

    /// The last catalogue pulled off a provider, and whose it is. Held here
    /// rather than in the picker's own state so that leaving the screen and
    /// coming back does not silently re-list several hundred models.
    private(set) var discovered: [DiscoveredModel] = []
    private(set) var discoveredFor: ProviderId?

    private(set) var isLoading = false
    private(set) var isDiscovering = false
    /// One write at a time, app-wide. Two taps on 保存 are one intent, and the
    /// second one landing as a second `POST` is how a model gets added twice.
    private(set) var isWriting = false
    private(set) var rebuild: RebuildProgress?

    private weak var app: AppModel?

    /// A rebuild is a loop of single-file writes rather than one call, so the
    /// count is the only progress there is to show.
    struct RebuildProgress: Equatable {
        var done = 0
        var total = 0
        var failed = 0
        var running = true
    }

    func attach(_ model: AppModel) { app = model }

    // MARK: Derived views of the catalogue

    /// Every chat model the server knows, disabled ones included. This is the
    /// inventory an administrator edits, which is a different list from the one
    /// the switcher offers.
    var chatModels: [ModelSpec] { catalogue.items.filter { $0.kind == .chat } }

    var chatApiModes: [ApiModeOption] { apiModes(for: .chat) }

    func apiModes(for kind: ModelKind) -> [ApiModeOption] {
        (app?.bootstrap?.apiModes ?? []).filter { $0.kinds.contains(kind) }
    }

    func apiModeLabel(_ id: String) -> String {
        app?.bootstrap?.apiModes?.first { $0.id == id }?.label ?? id
    }

    func apiModePath(_ id: String) -> String {
        app?.bootstrap?.apiModes?.first { $0.id == id }?.path ?? ""
    }

    func generationModels(_ kind: ModelKind, op: GenerationOp? = nil) -> [ModelSpec] {
        catalogue.items.filter { model in
            model.kind == kind && model.enabled && (op.map(model.supports) ?? true)
        }
    }

    func provider(_ id: ProviderId) -> Provider? {
        providers.first { $0.id == id }
    }

    func model(_ id: String) -> ModelSpec? {
        catalogue.items.first { $0.id.raw == id }
    }

    func status(_ id: String) -> McpStatus? {
        mcp.status.first { $0.id == id }
    }

    /// Whether the provider can be asked for a catalogue at all. A keyless one
    /// answers without credentials; anything else is refused with `422` until a
    /// key is stored, and offering the button anyway just produces that refusal.
    func canDiscover(_ provider: Provider) -> Bool {
        provider.isKeyless || provider.hasKey
    }

    // MARK: Loading

    func loadCatalogue() async {
        guard let app else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            async let list = app.api.send(.providers(), as: [Provider].self)
            async let models = app.api.send(.models(), as: ModelCatalogue.self)
            providers = try await list
            catalogue = try await models
        } catch let error as APIError {
            app.handle(error)
        } catch {}
    }

    func loadMcp() async {
        guard let app else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            mcp = try await app.api.send(.mcpServers(), as: McpServerList.self)
        } catch let error as APIError {
            app.handle(error)
        } catch {}
    }

    func loadCapabilities() async {
        guard let app else { return }
        do {
            capabilities = try await app.api.send(.capabilities(), as: Capabilities.self)
        } catch let error as APIError {
            app.handle(error)
        } catch {}
    }

    /// The saved prompts and the shipped pair together: 恢复默认 has nothing to
    /// offer until it knows what shipped, and asking for it only when the button
    /// is pressed would make the button appear to do nothing on a slow link.
    func loadPrompts() async {
        guard let app else { return }
        do {
            async let saved = app.api.send(.prompts(), as: PromptSettings.self)
            async let shipped = app.api.send(.promptDefaults(), as: PromptDefaults.self)
            prompts = try await saved
            promptDefaults = try await shipped
        } catch let error as APIError {
            app.handle(error)
        } catch {}
    }

    // MARK: Providers

    @discardableResult
    func createProvider(_ input: ProviderInput) async -> Bool {
        let ok = await write("已添加提供方") { try await $0.send(.createProvider(input)) }
        if ok { await refreshCatalogue() }
        return ok
    }

    @discardableResult
    func updateProvider(_ id: ProviderId, _ input: ProviderInput) async -> Bool {
        let ok = await write("已保存") { try await $0.send(.updateProvider(id, input)) }
        if ok { await refreshCatalogue() }
        return ok
    }

    @discardableResult
    func deleteProvider(_ id: ProviderId) async -> Bool {
        let ok = await write("已删除") { try await $0.send(.deleteProvider(id)) }
        if ok {
            discardDiscovery(for: id)
            await refreshCatalogue()
        }
        return ok
    }

    @discardableResult
    func setProviderKey(_ id: ProviderId, value: String) async -> Bool {
        let ok = await write("密钥已保存") { try await $0.send(.setProviderKey(id, value: value)) }
        if ok { await refreshCatalogue() }
        return ok
    }

    @discardableResult
    func clearProviderKey(_ id: ProviderId) async -> Bool {
        let ok = await write("密钥已清除") { try await $0.send(.deleteProviderKey(id)) }
        if ok {
            discardDiscovery(for: id)
            await refreshCatalogue()
        }
        return ok
    }

    // MARK: Models

    func discover(_ id: ProviderId) async {
        guard let app, !isDiscovering else { return }
        isDiscovering = true
        defer { isDiscovering = false }
        do {
            discovered = try await app.api.send(.discoverModels(id), as: DiscoveredModels.self).items
            discoveredFor = id
        } catch let error as APIError {
            discovered = []
            discoveredFor = nil
            app.handle(error)
        } catch {}
    }

    @discardableResult
    func createModel(_ input: ModelInput) async -> Bool {
        let ok = await write("已添加模型") { try await $0.send(.createModel(input)) }
        if ok { await refreshCatalogue() }
        return ok
    }

    @discardableResult
    func updateModel(_ id: ModelId, _ input: ModelInput, note: String? = nil) async -> Bool {
        let ok = await write(note) { try await $0.send(.updateModel(id, input)) }
        if ok { await refreshCatalogue() }
        return ok
    }

    @discardableResult
    func deleteModel(_ id: ModelId) async -> Bool {
        let ok = await write("已删除") { try await $0.send(.deleteModel(id)) }
        if ok { await refreshCatalogue() }
        return ok
    }

    @discardableResult
    func setDefaultModel(_ id: ModelId) async -> Bool {
        let ok = await write("已设为默认") { try await $0.send(.setDefaultModel(id)) }
        if ok { await refreshCatalogue() }
        return ok
    }

    /// Reports what the server actually stored rather than what was ticked: an
    /// id already in the catalogue is skipped, and saying 已添加 6 个 when four of
    /// them were already there is the kind of lie that sends someone hunting
    /// through the list for models that were never added.
    @discardableResult
    func importModels(_ input: ModelImport) async -> Bool {
        guard let app else { return false }
        var result = ModelImportResult()
        let ok = await write { api in
            result = try await api.send(.importModels(input), as: ModelImportResult.self)
        }
        guard ok else { return false }
        if result.skipped.isEmpty {
            app.note("已添加 \(result.added.count) 个模型")
        } else {
            app.note("已添加 \(result.added.count) 个，\(result.skipped.count) 个已存在")
        }
        await refreshCatalogue()
        return true
    }

    @discardableResult
    func setGenerationDefaults(_ input: GenerationDefaultsInput) async -> Bool {
        guard let app else { return false }
        var next = GenerationDefaults()
        let ok = await write("已保存") { api in
            next = try await api.send(.setGenerationDefaults(input), as: GenerationDefaults.self)
        }
        guard ok else { return false }
        catalogue.generation = next
        await app.load()
        return true
    }

    // MARK: MCP

    @discardableResult
    func createMcpServer(_ input: McpServerInput) async -> Bool {
        let ok = await write("已添加") { try await $0.send(.createMcpServer(input)) }
        if ok { await refreshMcp() }
        return ok
    }

    @discardableResult
    func updateMcpServer(_ id: String, _ input: McpServerInput, note: String? = nil) async -> Bool {
        let ok = await write(note) { try await $0.send(.updateMcpServer(id, input)) }
        if ok { await refreshMcp() }
        return ok
    }

    @discardableResult
    func deleteMcpServer(_ id: String) async -> Bool {
        let ok = await write("已删除") { try await $0.send(.deleteMcpServer(id)) }
        if ok { await refreshMcp() }
        return ok
    }

    /// A stdio server that died, or a remote one that was down when the process
    /// started, stays disconnected until something asks again.
    @discardableResult
    func reconnectMcp() async -> Bool {
        let ok = await write("已重新连接") { try await $0.send(.reconnectMcp()) }
        if ok { await refreshMcp() }
        return ok
    }

    // MARK: Capabilities

    @discardableResult
    func patchCapabilities(_ patch: CapabilitiesPatch, note: String? = nil) async -> Bool {
        guard let app else { return false }
        var next: Capabilities?
        let ok = await write(note) { api in
            next = try await api.send(.patchCapabilities(patch), as: Capabilities.self)
        }
        guard ok else { return false }
        capabilities = next
        await app.load()
        return true
    }

    @discardableResult
    func saveSecret(_ name: String, value: String) async -> Bool {
        guard let app else { return false }
        var next: Capabilities?
        let ok = await write("密钥已保存") { api in
            next = try await api.send(.putSecret(name, value: value), as: Capabilities.self)
        }
        guard ok else { return false }
        capabilities = next
        await app.load()
        return true
    }

    @discardableResult
    func clearSecret(_ name: String) async -> Bool {
        guard let app else { return false }
        var next: Capabilities?
        let ok = await write("密钥已清除") { api in
            next = try await api.send(.deleteSecret(name), as: Capabilities.self)
        }
        guard ok else { return false }
        capabilities = next
        await app.load()
        return true
    }

    /// Re-slices and re-embeds every document with the chunk parameters that are
    /// saved *now*. Changing them otherwise only affects the next upload, which
    /// makes the library half one setting and half another with nothing on
    /// screen saying so.
    ///
    /// One file at a time, and a failure is counted rather than fatal: handing a
    /// whole library to the embedding provider at once trades the progress count
    /// for rate limits, and the documents that did re-slice have no reason to be
    /// rolled back to stale chunks.
    func rebuildIndex() async {
        guard let app, rebuild?.running != true else { return }
        rebuild = RebuildProgress()
        do {
            let library = try await app.api.send(.files(kind: "docs", limit: 500), as: FileLibrary.self)
            rebuild = RebuildProgress(total: library.items.count)
            for file in library.items {
                if Task.isCancelled { break }
                do {
                    _ = try await app.api.send(.reindexFile(file.id), as: FileRecord.self)
                } catch {
                    rebuild?.failed += 1
                }
                rebuild?.done += 1
            }
            rebuild?.running = false
        } catch let error as APIError {
            rebuild = nil
            app.handle(error)
        } catch {
            rebuild = nil
        }
    }

    // MARK: Prompts

    @discardableResult
    func savePrompts(_ next: PromptSettings) async -> Bool {
        guard let app else { return false }
        var saved: PromptSettings?
        let ok = await write("提示词已保存") { api in
            saved = try await api.send(.savePrompts(next), as: PromptSettings.self)
        }
        guard ok else { return false }
        prompts = saved
        await app.load()
        return true
    }

    // MARK: Plumbing

    /// Every write goes through here. One place turns a refusal into the
    /// server's own sentence, and one flag is what stops a double tap from
    /// sending the same change twice.
    @discardableResult
    private func write(
        _ note: String? = nil, _ body: (APIClient) async throws -> Void
    ) async -> Bool {
        guard let app, !isWriting else { return false }
        isWriting = true
        defer { isWriting = false }
        do {
            try await body(app.api)
            if let note { app.note(note) }
            return true
        } catch let error as APIError {
            app.handle(error)
            return false
        } catch {
            return false
        }
    }

    private func refreshCatalogue() async {
        await loadCatalogue()
        await app?.load()
    }

    private func refreshMcp() async {
        await loadMcp()
        await app?.load()
    }

    /// A pulled list belongs to the provider *and* to its credentials. Once
    /// either is gone the rows are answers to a question nobody can ask again.
    private func discardDiscovery(for id: ProviderId) {
        guard discoveredFor == id else { return }
        discovered = []
        discoveredFor = nil
    }
}
