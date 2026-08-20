import Foundation

/// Where the server is. Stored in `UserDefaults` rather than the Keychain: it is
/// not a secret, and it has to be readable before first unlock.
enum ServerLocator {
    private static let key = "luma.baseURL"
    private static let resetKey = "luma.reset"

    /// A blank value is *no server*, not a server at the empty address. It reads
    /// as blank rather than as absent whenever something wrote one — a launch
    /// argument, or a cleared field — and letting `URL(string:)` decide leaves
    /// the answer to a parser that has changed its mind about empty input.
    static var baseURL: URL? {
        get {
            let stored = UserDefaults.standard.string(forKey: key) ?? ""
            let trimmed = stored.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : URL(string: trimmed)
        }
        set { UserDefaults.standard.set(newValue?.absoluteString, forKey: key) }
    }

    /// Puts the app back where a fresh install starts, for a UI test that has to
    /// begin at step one.
    ///
    /// It is asked for by its own name rather than by passing `-luma.baseURL ""`,
    /// because iOS folds a `-key value` launch argument into the *argument*
    /// domain, and that domain outranks the one this file writes to: the address
    /// typed during the run would be shadowed by the empty string for the rest of
    /// it. Only the argument domain is read here, so a stored value can never
    /// trigger a reset. The device token goes too — it lives in the Keychain,
    /// which survives reinstalling the app, so clearing the address alone leaves
    /// a launch that is still signed in to a server it no longer knows.
    static func applyLaunchReset() {
        let arguments = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
        guard arguments[resetKey] != nil else { return }
        UserDefaults.standard.removeObject(forKey: key)
        AuthStore.token = nil
    }

    /// Accepts what people actually type and normalises it. Scheme defaults to
    /// `http` for a `.local` name, a bare IPv4, or anything with an explicit
    /// port; `https` for everything else, which is what the tunnel deployment is.
    static func normalise(_ typed: String) -> URL? {
        var text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }

        let hasScheme = text.hasPrefix("http://") || text.hasPrefix("https://")
        if !hasScheme { text = "\(defaultScheme(for: text))://\(text)" }

        guard var components = URLComponents(string: text), let host = components.host, !host.isEmpty
        else { return nil }

        // Accept a pasted `/v1` or a trailing slash and land on the same URL, so
        // copying the address out of a browser works.
        var path = components.path
        while path.hasSuffix("/") { path.removeLast() }
        if path.hasSuffix("/v1") { path.removeLast(3) }
        components.path = path
        components.query = nil
        components.fragment = nil

        return components.url
    }

    private static func defaultScheme(for text: String) -> String {
        let host = text.split(separator: "/").first.map(String.init) ?? text
        let name = host.split(separator: ":").first.map(String.init) ?? host
        if host.contains(":") { return "http" }
        if name.hasSuffix(".local") || name == "localhost" { return "http" }
        if isBareIPv4(name) { return "http" }
        return "https"
    }

    private static func isBareIPv4(_ host: String) -> Bool {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        return parts.allSatisfy { part in
            guard let value = Int(part), part.count <= 3, value >= 0, value <= 255 else { return false }
            return true
        }
    }

    /// Everything the client talks to hangs off `/v1`.
    static func apiRoot(_ base: URL) -> URL {
        base.appending(path: "v1")
    }
}
