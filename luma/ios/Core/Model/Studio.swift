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

    func label(for name: String) -> String {
        let known: [String: String] = [
            "aspect_ratio": "画面比例",
            "width": "宽度",
            "height": "高度",
            "resolution": "分辨率",
            "seed": "随机种子",
            "steps": "步数",
            "negative_prompt": "负面提示词",
            "cfg": "CFG",
            "prompt": "提示词",
        ]
        return known[name] ?? title ?? name.replacingOccurrences(of: "_", with: " ")
    }
}
