import Foundation

/// One device that can still reach this server. The list is the only way an
/// owner learns a session they do not recognise exists, so it is read back after
/// every write rather than patched locally.
struct SessionRecord: Decodable, Sendable, Identifiable, Equatable {
    let id: String
    let device: String
    let createdAt: Int
    let lastSeen: Int
    let expiresAt: Int

    private enum CodingKeys: String, CodingKey { case id, device, createdAt, lastSeen, expiresAt }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        device = try c.decodeIfPresent(String.self, forKey: .device) ?? "未知设备"
        createdAt = try c.decodeIfPresent(Int.self, forKey: .createdAt) ?? 0
        lastSeen = try c.decodeIfPresent(Int.self, forKey: .lastSeen) ?? 0
        expiresAt = try c.decodeIfPresent(Int.self, forKey: .expiresAt) ?? 0
    }
}

/// `GET /security`, and what every write there answers with. `overTls` is the
/// server's own read of the connection, not the client's guess from its address:
/// behind a tunnel the two disagree, and the one that matters is the one the
/// access code actually travelled over.
struct SecuritySettings: Decodable, Sendable, Equatable {
    let totpEnabled: Bool
    let overTls: Bool
    let trustProxy: Bool
    let sessions: [SessionRecord]
    let currentSessionId: String

    private enum CodingKeys: String, CodingKey {
        case totpEnabled, overTls, trustProxy, sessions, currentSessionId
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        totpEnabled = try c.decodeIfPresent(Bool.self, forKey: .totpEnabled) ?? false
        overTls = try c.decodeIfPresent(Bool.self, forKey: .overTls) ?? false
        trustProxy = try c.decodeIfPresent(Bool.self, forKey: .trustProxy) ?? false
        sessions = try c.decodeIfPresent([SessionRecord].self, forKey: .sessions) ?? []
        currentSessionId = try c.decodeIfPresent(String.self, forKey: .currentSessionId) ?? ""
    }

    /// Sessions other than this one, which is what "revoke the rest" acts on and
    /// what makes the button worth offering at all.
    var otherSessions: Int {
        sessions.filter { $0.id != currentSessionId }.count
    }
}

/// `POST /security/totp`. Shown, never stored: the secret is adopted by the
/// server only once a code generated from it comes back, so this pair is live
/// for exactly as long as the enrolment card is on screen.
struct TotpEnrolment: Decodable, Sendable, Equatable, Identifiable {
    let secret: String
    let uri: String

    var id: String { secret }
}
