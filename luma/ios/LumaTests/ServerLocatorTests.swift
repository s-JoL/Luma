import Foundation
import Testing
@testable import Luma

/// What someone types into the address field, and what the app decides it meant.
/// Every case here was a real thing to type: a LAN name off the terminal, an
/// address pasted out of a browser, a tunnel hostname.
struct ServerLocatorTests {
    @Test("a LAN name or a bare address is plain http")
    func localIsPlain() {
        #expect(ServerLocator.normalise("mac.local:8090")?.absoluteString == "http://mac.local:8090")
        #expect(ServerLocator.normalise("192.168.1.7:8090")?.absoluteString == "http://192.168.1.7:8090")
        #expect(ServerLocator.normalise("localhost:8090")?.absoluteString == "http://localhost:8090")
    }

    /// The tunnel deployment is the one with no port, and it is https.
    @Test("a bare hostname is https")
    func remoteIsTls() {
        #expect(ServerLocator.normalise("luma.example.com")?.absoluteString == "https://luma.example.com")
    }

    @Test("a pasted /v1 or trailing slash lands on the same address")
    func acceptsPastedApiRoot() {
        let expected = "http://mac.local:8090"
        #expect(ServerLocator.normalise("http://mac.local:8090/v1")?.absoluteString == expected)
        #expect(ServerLocator.normalise("http://mac.local:8090/")?.absoluteString == expected)
        #expect(ServerLocator.normalise("  http://mac.local:8090/v1  ")?.absoluteString == expected)
    }

    @Test("nothing typed is not an address")
    func rejectsEmpty() {
        #expect(ServerLocator.normalise("") == nil)
        #expect(ServerLocator.normalise("   ") == nil)
    }

    @Test("everything the client talks to hangs off /v1")
    func apiRoot() {
        let base = URL(string: "http://mac.local:8090")!
        #expect(ServerLocator.apiRoot(base).absoluteString == "http://mac.local:8090/v1")
    }

    /// A blank stored value is *no server*, not a server at the empty address.
    /// A UI test's launch argument and a cleared field both write one, and the
    /// app has to reach the address form rather than a client pointed at "".
    @Test("a blank stored address reads as no server")
    func blankStoredAddress() {
        let defaults = UserDefaults.standard
        let key = "luma.baseURL"
        let previous = defaults.string(forKey: key)
        defer { defaults.set(previous, forKey: key) }

        defaults.set("", forKey: key)
        #expect(ServerLocator.baseURL == nil)
        defaults.set("   ", forKey: key)
        #expect(ServerLocator.baseURL == nil)
        defaults.set("http://mac.local:8090", forKey: key)
        #expect(ServerLocator.baseURL?.absoluteString == "http://mac.local:8090")
    }
}
