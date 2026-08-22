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
    /// Extra reference images, for the adapters that take them. Separate from
    /// `sourceId` because the first one is the thing being edited and the rest
    /// are only guidance — an adapter that accepts both treats them differently,
    /// and so does the reader.
    var additionalSourceIds: [String] = []

    private let api: APIClient
    private weak var app: AppModel?
    private var watches: [JobId: Task<Void, Never>] = [:]
    private var lastByKind: [StudioTool.Kind: String] = [:]
    private var seededKey = ""
    /// How long finished jobs took, by model and operation. Used to say "about a
    /// minute" instead of showing a spinner with no horizon.
    private var elapsed: [String: [Int]] = [:]

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
        additionalSourceIds = []
        seededKey = ""
        elapsed = [:]
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
            async let done = api.send(.jobs(status: "succeeded", limit: 40), as: JobList.self)
            async let page = api.send(.gallery(), as: GalleryPage.self)
            let toolsReply = try await catalogue
            tools = toolsReply.items
            enabled = toolsReply.enabled
            if toolKey.isEmpty, let first = tools.first { toolKey = first.id }
            seedIfNeeded()
            jobs = (try await running).items + (try await queued).items
            learnTimings(from: (try? await done)?.items ?? [])
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
        if !additionalSourceIds.isEmpty {
            params["additional_source_image_ids"] = .array(additionalSourceIds.map { .string($0) })
        }
        // `sources` is the provenance record — every picture this render was
        // built from, in the order the adapter received them — while `params`
        // is what the adapter reads. The same ids go in both.
        let sources = ([sourceId] + additionalSourceIds).filter { !$0.isEmpty }
        let input = JobInput(
            modelId: tool.modelId,
            op: tool.op,
            conversationId: nil,
            params: params,
            sources: sources.isEmpty ? nil : sources
        )
        let job = try await api.send(.submitJob(input), as: JobRecord.self)
        upsert(job)
        watch(job.id)
    }

    // MARK: Where a picture came from, and what to do about it

    func provenance(ofAsset id: String, kind: GeneratedAsset.Kind) async -> Provenance? {
        let endpoint = kind == .video
            ? Endpoint.videoProvenance(VideoId(id))
            : Endpoint.imageProvenance(ImageId(id))
        return try? await api.send(endpoint, as: Provenance.self)
    }

    /// The same request again, exactly. Not routed through the form: the point
    /// is that nothing was touched, and copying the parameters into the form and
    /// back out again is how a re-run quietly stops being one.
    func again(_ provenance: Provenance) async throws {
        guard let job = provenance.job, job.repeatable else { return }
        let input = JobInput(
            modelId: job.modelId.raw,
            op: job.op,
            conversationId: nil,
            params: job.params,
            sources: job.sources.isEmpty ? nil : job.sources
        )
        let record = try await api.send(.submitJob(input), as: JobRecord.self)
        upsert(record)
        watch(record.id)
    }

    /// Loads a past request into the form so it can be changed and sent again.
    /// Returns whether a tool was found to hold it — a model that has since been
    /// deleted cannot be edited, only read.
    @discardableResult
    func edit(_ provenance: Provenance) -> Bool {
        guard let job = provenance.job,
              let tool = tools.first(where: { $0.modelId == job.modelId.raw && $0.op == job.op })
                ?? tools.first(where: { $0.modelId == job.modelId.raw })
        else { return false }

        toolKey = tool.id
        lastByKind[tool.kind] = tool.id
        // Past the seeding guard deliberately: the values below are the point,
        // and `seedIfNeeded` would replace them with the schema defaults.
        seededKey = tool.id
        values = job.params
        sourceId = job.params["source_image_id"]?.stringValue ?? job.sources.first ?? ""
        additionalSourceIds = (job.params["additional_source_image_ids"]?.arrayValue ?? [])
            .compactMap(\.stringValue)
        return true
    }

    /// Take one setting out of a past render and leave everything else alone.
    ///
    /// Reusing a whole request is the obvious feature and the less useful one.
    /// What a person actually wants is "that seed, with my prompt" or "those
    /// steps, on this model" — and an all-or-nothing 改参数重画 makes them load
    /// the old request and then undo the parts they did not want.
    func adopt(_ name: String, _ value: JSONValue) {
        values[name] = value
    }

    /// The model a past render used, when it is still installed.
    @discardableResult
    func adoptModel(_ provenance: Provenance) -> Bool {
        guard let job = provenance.job,
              let tool = tools.first(where: { $0.modelId == job.modelId.raw && $0.op == job.op })
                ?? tools.first(where: { $0.modelId == job.modelId.raw })
        else { return false }
        selectTool(tool.id)
        // `selectTool` seeds defaults for a tool the reader has not used yet,
        // which would undo an adoption that happened before it.
        seededKey = tool.id
        return true
    }

    /// Take this picture as the thing to edit next.
    @discardableResult
    func useAsSource(_ assetId: String) -> Bool {
        guard tools.contains(where: { $0.kind == .edit }) else { return false }
        selectKind(.edit)
        sourceId = assetId
        additionalSourceIds = []
        return true
    }

    // MARK: How long this usually takes

    /// What this model's last renders took, in the middle. Median rather than
    /// mean because one job that sat behind a cold backend for ten minutes
    /// should not move the estimate for the next one.
    ///
    /// Keyed on the model alone: a job row does not record which operation it
    /// ran, and a model that does both generating and editing takes about as
    /// long either way.
    func estimate(for tool: StudioTool) -> Duration? {
        guard let samples = elapsed[tool.modelId], !samples.isEmpty else { return nil }
        let sorted = samples.sorted()
        return .milliseconds(sorted[sorted.count / 2])
    }

    private func learnTimings(from finished: [JobRecord]) {
        var samples: [String: [Int]] = [:]
        for job in finished {
            guard let started = job.startedAt, let ended = job.finishedAt, ended > started else { continue }
            samples[job.modelId.raw, default: []].append(ended - started)
        }
        elapsed = samples
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
        let wasOpen = jobs.contains { $0.id == job.id }
        jobs.removeAll { $0.id == job.id }
        if job.status.isFinished {
            if job.status == .succeeded {
                let seen = Set(gallery.map(\.assetId))
                gallery.insert(contentsOf: job.assets.filter { !seen.contains($0.assetId) }, at: 0)
                galleryTotal += job.assets.count
            }
            // Only for a job this client was watching. A refresh that reads back
            // forty finished rows must not announce all forty.
            if wasOpen, job.status != .cancelled {
                let name = job.modelName
                let failed = job.status == .failed
                Task { await Notifier.jobFinished(model: name, failed: failed) }
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
