import Foundation

/// Open-ended JSON, for the three places the contract genuinely is open-ended: a
/// message's `content`, a tool call's `arguments`, and a studio tool's parameters.
///
/// Decoding is forgiving on purpose. An unknown content part must decode and be
/// ignored rather than throw, or one new server-side part type breaks every build
/// that predates it.
enum JSONValue: Sendable, Equatable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])
}

extension JSONValue: Codable {
    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let items): try container.encode(items)
        case .object(let fields): try container.encode(fields)
        }
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            self = .null
        }
    }
}

extension JSONValue {
    subscript(key: String) -> JSONValue? {
        if case .object(let fields) = self { return fields[key] }
        return nil
    }

    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var boolValue: Bool {
        switch self {
        case .bool(let value): value
        case .number(let value): value != 0
        case .string(let value): value == "true"
        default: false
        }
    }

    var intValue: Int? {
        switch self {
        case .number(let value): Int(value)
        case .string(let value): Int(value)
        default: nil
        }
    }

    var doubleValue: Double? {
        switch self {
        case .number(let value): value
        case .string(let value): Double(value)
        default: nil
        }
    }

    var arrayValue: [JSONValue]? {
        if case .array(let items) = self { return items }
        return nil
    }

    var objectValue: [String: JSONValue]? {
        if case .object(let fields) = self { return fields }
        return nil
    }

    var isNull: Bool {
        if case .null = self { return true }
        return false
    }

    /// Reads a typed payload out of an event's open-ended `data`. Returns nil
    /// rather than throwing: an event whose shape this build does not recognise
    /// is ignored, not fatal.
    func decode<T: Decodable>(_ type: T.Type) -> T? {
        guard let data = try? JSONEncoder().encode(self) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    /// A string field read the way the reference implementation reads it:
    /// `String(part.text ?? "")`, which coerces rather than requiring a string.
    func text(_ key: String) -> String {
        switch self[key] {
        case .string(let value): value
        case .number(let value): value == value.rounded() ? String(Int(value)) : String(value)
        case .bool(let value): String(value)
        case .none, .some(.null): ""
        case .some(let other): other.prettyPrinted
        }
    }

    /// What a tool block shows when expanded. Sorted keys, because an argument
    /// list that reorders itself between renders is unreadable.
    var prettyPrinted: String {
        guard let data = try? JSONSerialization.data(
            withJSONObject: foundationObject,
            options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        ) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    var shortLabel: String {
        switch self {
        case .string(let value): value
        case .number(let value): value == value.rounded() ? String(Int(value)) : String(value)
        case .bool(let value): value ? "true" : "false"
        case .null: ""
        default: prettyPrinted
        }
    }

    private var foundationObject: Any {
        switch self {
        case .null: NSNull()
        case .bool(let value): value
        case .number(let value): value == value.rounded() ? Int(value) as Any : value as Any
        case .string(let value): value
        case .array(let items): items.map(\.foundationObject)
        case .object(let fields): fields.mapValues(\.foundationObject)
        }
    }
}
