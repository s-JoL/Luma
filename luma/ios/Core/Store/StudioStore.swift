import Foundation
import Observation

/// Studio catalogue, job queue, and gallery. Jobs are followed over SSE the same
/// way a run is: the row is the state, the stream is just a faster GET.
@MainActor
@Observable
final class StudioStore {
    private(set) var tools: [StudioTool] = []
    private(set) var enabled = true
    private(set) var gallery: [GeneratedAsset] = []
    private(set) var galleryTotal = 0
    private(set) var jobs: [JobRecord] = []
    private(set) var isLoading = false
    private(set) var isSubmitting = false
    var toolKey = ""
    var values: [String: JSONValue] = [:]
    var sourceId = ""

    private let api: APIClient
    private weak var app: AppModel?
    private var watches: [JobId: Task<Void, Never>] = [:]
    private var lastByKind: [StudioTool.Kind: String] = [:]
    private var seededKey = ""

    init(api: APIClient) {
        self.api = api
    }

    func attach(_ model: AppModel) { app = model }

    var tool: StudioTool? { tools.first { $0.id == toolKey } }

    var kinds: [StudioTool.Kind] {
        StudioTool.Kind.allCases.filter { kind in tools.contains { $0.kind == kind } }
    }

    var kindTools: [StudioTool] {
        tools.filter { $0.kind == tool?.kind }
    }

    func reset() {
        tools = []
        gallery = []
        jobs = []
        toolKey = ""
        values = [:]
        sourceId = ""
        seededKey = ""
        for watch in watches.values { watch.cancel() }
        watches.removeAll()
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            async let catalogue = api.send(.studioTools(), as: StudioTools.self)
            async let queued = api.send(.jobs(status: "queued", limit: 12), as: JobList.self)
            async let running = api.send(.jobs(status: "running", limit: 12), as: JobList.self)
            async let page = api.send(.gallery(), as: GalleryPage.self)
            let toolsReply = try await catalogue
            tools = toolsReply.items
            enabled = toolsReply.enabled
            if toolKey.isEmpty, let first = tools.first { toolKey = first.id }
            seedIfNeeded()
            jobs = (try await running).items + (try await queued).items
            let galleryPage = try await page
            gallery = galleryPage.items
            galleryTotal = galleryPage.total
            for job in jobs where !job.status.isFinished { watch(job.id) }
        } catch let failure as APIError {
            // The next appearance retries, but an empty studio with no
            // explanation reads as "this server has no models" rather than as a
            // request that failed.
            app?.handle(failure)
        } catch {}
    }

    func selectKind(_ kind: StudioTool.Kind) {
        if let remembered = lastByKind[kind], tools.contains(where: { $0.id == remembered }) {
            toolKey = remembered
        } else if let fallback = tools.first(where: { $0.kind == kind }) {
            toolKey = fallback.id
        }
        seedIfNeeded()
    }

    func selectTool(_ id: String) {
        toolKey = id
        if let tool { lastByKind[tool.kind] = id }
        seedIfNeeded()
    }

    func seedIfNeeded() {
        guard let tool, seededKey != tool.id else { return }
        seededKey = tool.id
        values = Dictionary(
            uniqueKeysWithValues: tool.schema.properties.compactMap { name, field in
                field.defaultValue.map { (name, $0) }
            }
        )
        sourceId = ""
    }

    func submit() async throws {
        guard let tool else { return }
        isSubmitting = true
        defer { isSubmitting = false }
        var params = values
        if !sourceId.isEmpty { params["source_image_id"] = .string(sourceId) }
        let input = JobInput(
            modelId: tool.modelId,
            op: tool.op,
            conversationId: nil,
            params: params,
            sources: sourceId.isEmpty ? nil : [sourceId]
        )
        let job = try await api.send(.submitJob(input), as: JobRecord.self)
        upsert(job)
        watch(job.id)
    }

    func cancel(_ id: JobId) async throws {
        let job = try await api.send(.cancelJob(id), as: JobRecord.self)
        upsert(job)
    }

    func loadMoreGallery() async {
        guard gallery.count < galleryTotal else { return }
        do {
            let page = try await api.send(.gallery(offset: gallery.count), as: GalleryPage.self)
            let seen = Set(gallery.map(\.assetId))
            gallery.append(contentsOf: page.items.filter { !seen.contains($0.assetId) })
            galleryTotal = page.total
        } catch let failure as APIError {
            // The button stays, because the count still says there is more; what
            // it must not do is look like it was tapped and did nothing.
            app?.handle(failure)
        } catch {}
    }

    func uploadSource(data: Data, filename: String, mime: String) async throws {
        let file = try await api.upload(data: data, filename: filename, mime: mime)
        sourceId = file.id.raw
    }

    private func upsert(_ job: JobRecord) {
        jobs.removeAll { $0.id == job.id }
        if job.status.isFinished {
            if job.status == .succeeded {
                let seen = Set(gallery.map(\.assetId))
                gallery.insert(contentsOf: job.assets.filter { !seen.contains($0.assetId) }, at: 0)
                galleryTotal += job.assets.count
            }
        } else {
            jobs.insert(job, at: 0)
        }
    }

    private func watch(_ id: JobId) {
        guard watches[id] == nil else { return }
        watches[id] = Task { [api] in
            defer { watches[id] = nil }
            do {
                for try await frame in api.frames(.jobEvents(id)) {
                    guard !Task.isCancelled else { return }
                    guard let data = frame.data.data(using: .utf8),
                          let job = try? JSON.decode(JobRecord.self, from: data)
                    else { continue }
                    upsert(job)
                    if job.status.isFinished { return }
                }
            } catch {}
        }
    }
}
