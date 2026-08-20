import Foundation

/// One row of `GET /files`. The same id is an image or video asset when the mime
/// says so, which is why the gallery and the library can share `AuthedImage`.
struct FileRecord: Decodable, Sendable, Identifiable, Equatable {
    let id: FileId
    let name: String
    let mime: String
    let bytes: Int
    let conversationId: ConversationId?
    let source: String
    let embeddingStatus: EmbeddingStatus
    let embeddingError: String?
    let chunkCount: Int
    let pageCount: Int?
    let width: Int?
    let height: Int?
    let createdAt: Int

    var isImage: Bool { mime.hasPrefix("image/") }
    var isVideo: Bool { mime.hasPrefix("video/") }
    var isText: Bool { mime.hasPrefix("text/") || mime == "application/json" }

    enum EmbeddingStatus: String, Decodable, Sendable, Equatable {
        case none, pending, indexed, ready, failed

        init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = EmbeddingStatus(rawValue: raw) ?? .none
        }

        var label: String {
            switch self {
            case .ready: "已索引"
            case .indexed: "可检索"
            case .pending: "索引中"
            case .failed: "失败"
            case .none: "未索引"
            }
        }
    }
}

struct FileFacets: Decodable, Sendable, Equatable {
    var kinds: [String: Int]
    var sources: [Source]

    struct Source: Decodable, Sendable, Equatable, Identifiable {
        var id: String
        var count: Int
    }

    var kindCount: (all: Int, docs: Int, images: Int, videos: Int) {
        (
            kinds["all"] ?? 0,
            kinds["docs"] ?? 0,
            kinds["images"] ?? 0,
            kinds["videos"] ?? 0
        )
    }
}

struct FileLibrary: Decodable, Sendable {
    var items: [FileRecord]
    var total: Int
    var facets: FileFacets
}

struct FileHit: Decodable, Sendable, Identifiable {
    var chunkId: String
    var fileId: String
    var name: String
    var excerpt: String
    var page: Int?
    var chunk: Int
    var matchType: String
    var retrievalScore: Double
    var semanticScore: Double?

    var id: String { chunkId }

    private enum CodingKeys: String, CodingKey {
        case chunkId, name, excerpt, page, chunk, matchType, retrievalScore, semanticScore
        case fileId = "id"
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        chunkId = try c.decodeIfPresent(String.self, forKey: .chunkId) ?? ""
        fileId = try c.decodeIfPresent(String.self, forKey: .fileId) ?? ""
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        excerpt = try c.decodeIfPresent(String.self, forKey: .excerpt) ?? ""
        page = try c.decodeIfPresent(Int.self, forKey: .page)
        chunk = try c.decodeIfPresent(Int.self, forKey: .chunk) ?? 0
        matchType = try c.decodeIfPresent(String.self, forKey: .matchType) ?? "keyword"
        retrievalScore = try c.decodeIfPresent(Double.self, forKey: .retrievalScore) ?? 0
        semanticScore = try c.decodeIfPresent(Double.self, forKey: .semanticScore)
    }
}

struct FileSearchResult: Decodable, Sendable {
    var mode: String
    var results: [FileHit]
}

struct FileText: Decodable, Sendable {
    var id: String
    var name: String
    var text: String
}

enum FileSourceLabel {
    static func name(_ id: String) -> String {
        switch id {
        case "upload": "上传"
        case "generated": "生成"
        case "note": "自建"
        case "librechat": "迁移"
        default: id
        }
    }
}

struct MemoryRecord: Decodable, Sendable, Identifiable, Equatable {
    var key: String
    var value: String
    var tokens: Int
    var updatedAt: Int
    var id: String { key }
}

struct MemorySnapshot: Decodable, Sendable {
    var items: [MemoryRecord]
    var tokens: Int
    var limit: Int
    var charLimit: Int
    var suggestedKeys: [String]
}
