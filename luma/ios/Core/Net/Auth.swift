import Foundation
import KeychainAccess
import UIKit

/// `GET /auth/challenge`, so the sign-in form asks for the second factor up
/// front rather than learning about it from a rejected attempt.
struct Challenge: Decodable, Sendable {
    let totpRequired: Bool
    /// Seconds the login endpoint stays locked. The button counts this down
    /// rather than letting the user hammer an endpoint that will answer `429`.
    let lockedFor: Int

    private enum CodingKeys: String, CodingKey { case totpRequired, lockedFor }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        totpRequired = try c.decodeIfPresent(Bool.self, forKey: .totpRequired) ?? false
        lockedFor = try c.decodeIfPresent(Int.self, forKey: .lockedFor) ?? 0
    }
}

struct TokenGrant: Decodable, Sendable {
    let token: String
    let expiresAt: Int
}

struct Health: Decodable, Sendable {
    let ok: Bool
    let version: String

    private enum CodingKeys: String, CodingKey { case ok, version }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? true
        version = try c.decodeIfPresent(String.self, forKey: .version) ?? "?"
    }
}

/// The credentials a change that outlives the session needs on the request
/// itself. Sent on one request and never stored.
struct StepUp: Sendable, Equatable {
    var accessCode: String
    /// Omitted entirely when no authenticator is enrolled.
    var totp: String = ""

    var headers: [String: String] {
        var headers = ["x-luma-access-code": accessCode]
        if !totp.isEmpty { headers["x-luma-totp"] = totp }
        return headers
    }
}

/// `afterFirstUnlockThisDeviceOnly` is the right class: a background poll after a
/// resume needs the token without a passcode prompt, and the token must not
/// travel to another device in an iCloud backup.
enum AuthStore {
    /// Built per access rather than held in a `static let`: `Keychain` is not
    /// `Sendable`, and the alternative is an `nonisolated(unsafe)` annotation
    /// that would silence the checker instead of satisfying it. Construction is
    /// just holding a service name.
    private static var keychain: Keychain {
        Keychain(service: "works.earendil.luma")
            .accessibility(.afterFirstUnlockThisDeviceOnly)
    }

    private static let tokenKey = "device-token"

    static var token: String? {
        get { try? keychain.get(tokenKey) }
        set {
            if let newValue {
                try? keychain.set(newValue, key: tokenKey)
            } else {
                try? keychain.remove(tokenKey)
            }
        }
    }

    /// So the session list in 设置 → 安全 reads 「我的 iPhone」 rather than a UUID.
    @MainActor
    static var deviceName: String {
        String(UIDevice.current.name.prefix(40))
    }
}
