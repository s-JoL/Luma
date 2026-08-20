import Foundation

/// A generation request. A job's whole state is this row, which is why there is
/// no job event log: a reconnecting client reads the row and knows everything.
struct JobRecord: Decodable, Sendable, Equatable, Identifiable {
    let id: JobId
    let kind: Kind
    let modelId: ModelId
    let modelName: String
    let conversationId: ConversationId?
    let status: Status
    /// 0…1, or nil when the backend reports no progress.
    let progress: Double?
    let note: String?
    let assets: [GeneratedAsset]
    let error: String?
    let createdAt: Int
    let startedAt: Int?
    let finishedAt: Int?

    enum Kind: String, Decodable, Sendable {
        case image, video

        /// An unknown kind must not fail the row. A queue card that renders as an
        /// image is better than a job the app cannot show at all.
        init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Kind(rawValue: raw) ?? .image
        }
    }

    enum Status: String, Decodable, Sendable {
        case queued, running, succeeded, failed, cancelled

        init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Status(rawValue: raw) ?? .failed
        }

        var isFinished: Bool {
            switch self {
            case .succeeded, .failed, .cancelled: true
            case .queued, .running: false
            }
        }
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, modelId, modelName, conversationId, status
        case progress, note, assets, error, createdAt, startedAt, finishedAt
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(JobId.self, forKey: .id)
        kind = try c.decodeIfPresent(Kind.self, forKey: .kind) ?? .image
        modelId = try c.decodeIfPresent(ModelId.self, forKey: .modelId) ?? ModelId("")
        modelName = try c.decodeIfPresent(String.self, forKey: .modelName) ?? ""
        conversationId = try c.decodeIfPresent(ConversationId.self, forKey: .conversationId)
        status = try c.decodeIfPresent(Status.self, forKey: .status) ?? .queued
        progress = try c.decodeIfPresent(Double.self, forKey: .progress)
        note = try c.decodeIfPresent(String.self, forKey: .note)
        assets = try c.decodeIfPresent([GeneratedAsset].self, forKey: .assets) ?? []
        error = try c.decodeIfPresent(String.self, forKey: .error)
        createdAt = try c.decodeIfPresent(Int.self, forKey: .createdAt) ?? 0
        startedAt = try c.decodeIfPresent(Int.self, forKey: .startedAt)
        finishedAt = try c.decodeIfPresent(Int.self, forKey: .finishedAt)
    }
}

/// One asset a job produced. Everything past `kind` is named exactly as the
/// gallery names it, so a finished job renders with the renderer that already
/// exists rather than a synthesised tile with no provenance.
struct GeneratedAsset: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let assetId: String
    let kind: Kind
    let width: Int?
    let height: Int?
    let name: String?
    let posterAssetId: String?

    enum Kind: String, Decodable, Sendable {
        case image, video

        init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Kind(rawValue: raw) ?? .image
        }
    }

    private enum CodingKeys: String, CodingKey {
        case id, assetId, kind, width, height, name, posterAssetId
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
        assetId = try c.decodeIfPresent(String.self, forKey: .assetId) ?? ""
        kind = try c.decodeIfPresent(Kind.self, forKey: .kind) ?? .image
        width = try c.decodeIfPresent(Int.self, forKey: .width)
        height = try c.decodeIfPresent(Int.self, forKey: .height)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        posterAssetId = try c.decodeIfPresent(String.self, forKey: .posterAssetId)
    }

    var aspectRatio: Double? {
        guard let width, let height, width > 0, height > 0 else { return nil }
        return Double(width) / Double(height)
    }

    /// A clip's still, where the backend made one. Empty is the same as absent —
    /// the field is written unconditionally by some adapters.
    var poster: ImageId? {
        guard let posterAssetId, !posterAssetId.isEmpty else { return nil }
        return ImageId(posterAssetId)
    }
}
