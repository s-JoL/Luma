import Foundation

/// One operation a generation model offers. The form is the adapter's JSON
/// Schema; `modelId` and `op` are what `POST /jobs` wants.
struct StudioTool: Decodable, Sendable, Identifiable {
    var serverId: String
    var serverTitle: String
    var name: String
    var description: String
    var kind: Kind
    var schema: JsonSchema
    var modelId: String
    var op: String
    var local: Bool?
    var configured: Bool?

    var id: String { "\(serverId)/\(name)" }

    enum Kind: String, Decodable, Sendable, Hashable, CaseIterable {
        case generate, edit, video

        init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Kind(rawValue: raw) ?? .generate
        }

        var label: String {
            switch self {
            case .generate: "生成图片"
            case .edit: "编辑图片"
            case .video: "视频"
            }
        }

        var action: String {
            switch self {
            case .generate: "开始生成"
            case .edit: "开始编辑"
            case .video: "开始生成视频"
            }
        }
    }
}

struct StudioTools: Decodable, Sendable {
    var items: [StudioTool]
    var enabled: Bool
}

struct GalleryPage: Decodable, Sendable {
    var items: [GeneratedAsset]
    var total: Int
}

struct JobList: Decodable, Sendable {
    var items: [JobRecord]
}

struct JobInput: Encodable, Sendable {
    var modelId: String
    var op: String?
    var conversationId: String?
    var params: [String: JSONValue]?
    var sources: [String]?

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(modelId, forKey: .modelId)
        if let op, !op.isEmpty { try c.encode(op, forKey: .op) }
        if let conversationId, !conversationId.isEmpty { try c.encode(conversationId, forKey: .conversationId) }
        if let params, !params.isEmpty { try c.encode(params, forKey: .params) }
        if let sources, !sources.isEmpty { try c.encode(sources, forKey: .sources) }
    }

    private enum CodingKeys: String, CodingKey { case modelId, op, conversationId, params, sources }
}

/// Where an asset came from.
///
/// Everything above `job` stands on its own, because `job` is absent for an
/// upload and for anything generated before the queue kept records — a picture
/// with no request behind it still has a size, a model and a date, and the sheet
/// has to be able to say so rather than showing nothing.
struct Provenance: Decodable, Sendable, Equatable {
    let assetId: String
    let kind: GeneratedAsset.Kind
    let mime: String
    let width: Int?
    let height: Int?
    let durationMs: Int?
    let provider: String?
    let model: String?
    /// What it was made from: the source images of an edit, or a video's stills.
    let parents: [String]
    let createdAt: Int
    let job: Job?

    struct Job: Decodable, Sendable, Equatable {
        let id: JobId
        let op: String
        let modelId: ModelId
        let modelName: String
        /// Whether the same request could be sent again — the model row still
        /// exists, is enabled and still runs this operation. A button that would
        /// 404 is worse than no button, and a deleted model is the ordinary way
        /// this goes false.
        let repeatable: Bool
        let params: [String: JSONValue]
        let sources: [String]
        /// Wall time the render took, when both ends were recorded.
        let elapsedMs: Int?

        private enum CodingKeys: String, CodingKey {
            case id, op, modelId, modelName, repeatable, params, sources, elapsedMs
        }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decodeIfPresent(JobId.self, forKey: .id) ?? JobId("")
            op = try c.decodeIfPresent(String.self, forKey: .op) ?? ""
            modelId = try c.decodeIfPresent(ModelId.self, forKey: .modelId) ?? ModelId("")
            modelName = try c.decodeIfPresent(String.self, forKey: .modelName) ?? ""
            repeatable = try c.decodeIfPresent(Bool.self, forKey: .repeatable) ?? false
            params = try c.decodeIfPresent([String: JSONValue].self, forKey: .params) ?? [:]
            sources = try c.decodeIfPresent([String].self, forKey: .sources) ?? []
            elapsedMs = try c.decodeIfPresent(Int.self, forKey: .elapsedMs)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case assetId, kind, mime, width, height, durationMs
        case provider, model, parents, createdAt, job
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        assetId = try c.decodeIfPresent(String.self, forKey: .assetId) ?? ""
        kind = try c.decodeIfPresent(GeneratedAsset.Kind.self, forKey: .kind) ?? .image
        mime = try c.decodeIfPresent(String.self, forKey: .mime) ?? ""
        width = try c.decodeIfPresent(Int.self, forKey: .width)
        height = try c.decodeIfPresent(Int.self, forKey: .height)
        durationMs = try c.decodeIfPresent(Int.self, forKey: .durationMs)
        provider = try c.decodeIfPresent(String.self, forKey: .provider)
        model = try c.decodeIfPresent(String.self, forKey: .model)
        parents = try c.decodeIfPresent([String].self, forKey: .parents) ?? []
        createdAt = try c.decodeIfPresent(Int.self, forKey: .createdAt) ?? 0
        job = try c.decodeIfPresent(Job.self, forKey: .job)
    }

    /// The prompt, pulled out of the parameter bag because it is the one field
    /// the reader came for and the rest are settings.
    var prompt: String {
        job?.params["prompt"]?.stringValue ?? ""
    }

    /// Everything except the prompt and the plumbing, in a stable order so the
    /// sheet does not reshuffle between two pictures made the same way.
    var settings: [(name: String, value: String)] {
        guard let job else { return [] }
        let skipped: Set<String> = ["prompt", "source_image_id", "additional_source_image_ids", "intent"]
        return job.params
            .filter { !skipped.contains($0.key) && !$0.value.shortLabel.isEmpty }
            .sorted { $0.key < $1.key }
            .map { (name: $0.key, value: $0.value.shortLabel) }
    }
}

/// Recursive JSON Schema. A class because Swift forbids a struct that contains
/// itself, and adapters nest `properties` / `items`.
final class JsonSchema: Decodable, @unchecked Sendable {
    let type: String?
    let title: String?
    let description: String?
    let enumValues: [JSONValue]
    let defaultValue: JSONValue?
    let minimum: Double?
    let maximum: Double?
    let maxItems: Int?
    let audience: String?
    let properties: [String: JsonSchema]
    let required: [String]
    let items: JsonSchema?

    init() {
        type = nil
        title = nil
        description = nil
        enumValues = []
        defaultValue = nil
        minimum = nil
        maximum = nil
        maxItems = nil
        audience = nil
        properties = [:]
        required = []
        items = nil
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = try c.decodeIfPresent(String.self, forKey: .type)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        enumValues = try c.decodeIfPresent([JSONValue].self, forKey: .enumValues) ?? []
        defaultValue = try c.decodeIfPresent(JSONValue.self, forKey: .defaultValue)
        minimum = try c.decodeIfPresent(Double.self, forKey: .minimum)
        maximum = try c.decodeIfPresent(Double.self, forKey: .maximum)
        maxItems = try c.decodeIfPresent(Int.self, forKey: .maxItems)
        audience = try c.decodeIfPresent(String.self, forKey: .audience)
        properties = try c.decodeIfPresent([String: JsonSchema].self, forKey: .properties) ?? [:]
        required = try c.decodeIfPresent([String].self, forKey: .required) ?? []
        items = try c.decodeIfPresent(JsonSchema.self, forKey: .items)
    }

    private enum CodingKeys: String, CodingKey {
        case type, title, description, minimum, maximum, maxItems, audience, properties, required, items
        case enumValues = "enum"
        case defaultValue = "default"
    }

    var isStudioOnly: Bool { audience == "studio" }

    /// What to call a parameter in front of a person.
    ///
    /// The adapter's own names are the API's, and some of them are jargon that
    /// only means something if you already know it. `cfg` is the clearest case:
    /// it stands for classifier-free guidance, which explains nothing, and every
    /// tool that has thought about this — Draw Things among them — calls it
    /// guidance in the interface and keeps `cfg` for the value chip.
    func label(for name: String) -> String {
        let known: [String: String] = [
            "aspect_ratio": "画面比例",
            "width": "宽度",
            "height": "高度",
            "resolution": "分辨率",
            "seed": "随机种子",
            "steps": "细节步数",
            "negative_prompt": "不要出现",
            "cfg": "引导强度",
            "cfg_scale": "引导强度",
            "guidance": "引导强度",
            "guidance_scale": "引导强度",
            "sampler": "采样器",
            "scheduler": "调度器",
            "denoise": "重绘幅度",
            "strength": "重绘幅度",
            "batch_size": "张数",
            "duration": "时长",
            "fps": "帧率",
            "prompt": "提示词",
        ]
        return known[name] ?? title ?? name.replacingOccurrences(of: "_", with: " ")
    }
}
