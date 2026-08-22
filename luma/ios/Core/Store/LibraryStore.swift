import Foundation
import Observation

/// The file library: filters, search, notes, upload, and the memory snapshot.
@MainActor
@Observable
final class LibraryStore {
    private(set) var items: [FileRecord] = []
    private(set) var facets: FileFacets = FileFacets(kinds: [:], sources: [])
    private(set) var total = 0
    private(set) var isLoading = false
    private(set) var hits: [FileHit]?
    private(set) var isSearching = false

    var kind = "all"
    var source = "all"
    var needle = ""

    private let api: APIClient
    private weak var app: AppModel?

    init(api: APIClient) {
        self.api = api
    }

    func attach(_ model: AppModel) { app = model }

    func reset() {
        items = []
        total = 0
        hits = nil
        needle = ""
        kind = "all"
        source = "all"
    }

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await api.send(
                .files(kind: kind, source: source, q: needle, limit: 80),
                as: FileLibrary.self
            )
            items = page.items
            facets = page.facets
            total = page.total
        } catch let failure as APIError {
            // Keep what is on screen, but say why it did not change: a list that
            // silently stays stale cannot be told apart from one that is right.
            app?.handle(failure)
        } catch {}
    }

    func search(_ query: String) async throws {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            hits = nil
            return
        }
        isSearching = true
        defer { isSearching = false }
        let result = try await api.send(.searchFiles(text), as: FileSearchResult.self)
        hits = result.results
    }

    /// Back to browsing. Emptying the search field is not a search for nothing,
    /// and leaving the last hits on screen under an empty field is how a list
    /// ends up showing results for a query that is no longer there.
    func clearSearch() {
        hits = nil
        isSearching = false
    }

    func createNote(name: String, text: String) async throws {
        _ = try await api.send(.createNote(name: name, text: text), as: FileRecord.self)
        await load()
    }

    func saveNote(_ id: FileId, name: String, text: String) async throws {
        _ = try await api.send(.saveFileText(id, name: name, text: text), as: FileRecord.self)
        await load()
    }

    func fileText(_ id: FileId) async throws -> FileText {
        try await api.send(.fileText(id), as: FileText.self)
    }

    func delete(_ id: FileId) async throws {
        try await api.send(.deleteFile(id))
        items.removeAll { $0.id == id }
        total = max(0, total - 1)
    }

    func reindex(_ id: FileId) async throws {
        _ = try await api.send(.reindexFile(id), as: FileRecord.self)
        await load()
    }

    func upload(data: Data, filename: String, mime: String) async throws {
        _ = try await api.upload(data: data, filename: filename, mime: mime)
        await load()
    }

    var hasPending: Bool { items.contains { $0.embeddingStatus == .pending } }
}

@MainActor
@Observable
final class MemoryStore {
    private(set) var snapshot: MemorySnapshot?
    var drafts: [String: String] = [:]
    private(set) var added: [String] = []
    private let api: APIClient

    init(api: APIClient) {
        self.api = api
    }

    func reset() {
        snapshot = nil
        drafts = [:]
        added = []
    }

    func load() async throws {
        snapshot = try await api.send(.memory(), as: MemorySnapshot.self)
    }

    func save(key: String) async throws {
        let stored = snapshot?.items.first { $0.key == key }?.value ?? ""
        let value = (drafts[key] ?? stored).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        snapshot = try await api.send(.setMemory(key: key, value: value), as: MemorySnapshot.self)
        drafts[key] = nil
        added.removeAll { $0 == key }
    }

    func delete(key: String) async throws {
        snapshot = try await api.send(.deleteMemory(key: key), as: MemorySnapshot.self)
        drafts[key] = nil
        added.removeAll { $0 == key }
    }

    func addKey(_ key: String) {
        let name = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard MemoryKey.isValid(name) else { return }
        if !(added.contains(name) || snapshot?.items.contains { $0.key == name } == true) {
            added.append(name)
        }
    }

    var keys: [String] {
        let stored = snapshot?.items.map(\.key) ?? []
        let suggested = snapshot?.suggestedKeys ?? []
        var seen = Set<String>()
        return (stored + added + suggested).filter { seen.insert($0).inserted }
    }
}

enum MemoryKey {
    static func isValid(_ key: String) -> Bool {
        key.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil
    }
}
