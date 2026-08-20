import Foundation
import Testing
@testable import Luma

/// The security screen is the one place where getting a request wrong locks the
/// owner out of their own server, so the parts that can be checked without one
/// are: what comes back off the wire, and what goes onto the request.
struct SecurityTests {
    private static let snapshot = """
    {
      "totpEnabled": true,
      "overTls": false,
      "trustProxy": true,
      "currentSessionId": "s1",
      "sessions": [
        { "id": "s1", "device": "iPhone", "createdAt": 1000, "lastSeen": 2000, "expiresAt": 3000 },
        { "id": "s2", "device": "web", "createdAt": 10, "lastSeen": 20, "expiresAt": 30 }
      ]
    }
    """

    private func decode(_ json: String) throws -> SecuritySettings {
        try JSONDecoder().decode(SecuritySettings.self, from: Data(json.utf8))
    }

    @Test("the security snapshot decodes as the server writes it")
    func decodesSnapshot() throws {
        let state = try decode(Self.snapshot)
        #expect(state.totpEnabled)
        #expect(!state.overTls)
        #expect(state.trustProxy)
        #expect(state.sessions.count == 2)
        #expect(state.currentSessionId == "s1")
        #expect(state.sessions.first?.device == "iPhone")
    }

    /// Revoking "the others" is only worth offering when there are others, and
    /// the current session is never one of them.
    @Test("other sessions exclude this one")
    func countsOtherSessions() throws {
        #expect(try decode(Self.snapshot).otherSessions == 1)
        let alone = """
        { "totpEnabled": false, "overTls": true, "trustProxy": false, "currentSessionId": "s1",
          "sessions": [{ "id": "s1", "device": "iPhone", "createdAt": 1, "lastSeen": 2, "expiresAt": 3 }] }
        """
        #expect(try decode(alone).otherSessions == 0)
    }

    /// A server that predates a field, or one answering an older shape, must not
    /// take the whole screen down with it.
    @Test("a sparse snapshot still decodes")
    func decodesSparse() throws {
        let state = try decode("{}")
        #expect(!state.totpEnabled)
        #expect(state.sessions.isEmpty)
        #expect(state.currentSessionId.isEmpty)
    }

    @Test("enrolment carries both the secret and the otpauth link")
    func decodesEnrolment() throws {
        let json = """
        { "secret": "JBSWY3DPEHPK3PXP", "uri": "otpauth://totp/Luma:owner?secret=JBSWY3DPEHPK3PXP" }
        """
        let enrolment = try JSONDecoder().decode(TotpEnrolment.self, from: Data(json.utf8))
        #expect(enrolment.secret == "JBSWY3DPEHPK3PXP")
        #expect(enrolment.uri.hasPrefix("otpauth://"))
    }

    // MARK: Step-up

    /// The TOTP header is omitted rather than sent empty. An empty one reads to
    /// the server as a supplied-and-wrong code on a deployment with no
    /// authenticator enrolled.
    @Test("step-up sends the access code always and the TOTP only when there is one")
    func stepUpHeaders() {
        #expect(StepUp(accessCode: "code").headers == ["x-luma-access-code": "code"])
        #expect(StepUp(accessCode: "code", totp: "123456").headers == [
            "x-luma-access-code": "code",
            "x-luma-totp": "123456",
        ])
    }

    @Test("every write on the security screen carries the confirmation")
    func writesCarryStepUp() throws {
        let step = StepUp(accessCode: "code", totp: "123456")
        let writes: [Endpoint] = [
            try .setAccessCode("a-long-enough-code", step: step),
            .startTotp(step: step),
            try .disableTotp(step: step),
            .revokeSession("s2", step: step),
            .revokeOtherSessions(step: step),
        ]
        for endpoint in writes {
            #expect(endpoint.stepUp == step, "\(endpoint.path) must confirm")
            // A repeated confirmation would spend a code that is already gone.
            #expect(!endpoint.isRetryable, "\(endpoint.path) must not be retried")
        }
        #expect(Endpoint.security().stepUp == nil)
    }

    /// Enrolment is the one write with no step-up: the code proves the
    /// authenticator holds the pending secret, which is the whole point of
    /// confirming in a second call.
    @Test("confirming an enrolment needs no confirmation of its own")
    func confirmNeedsNoStepUp() throws {
        let endpoint = try Endpoint.confirmTotp("123456")
        #expect(endpoint.stepUp == nil)
        #expect(endpoint.method == "POST")
        #expect(endpoint.path == "/security/totp/confirm")
        #expect(body(endpoint)?["code"] as? String == "123456")
    }

    /// The server reads its TOTP from the header or, on this one route, from the
    /// body. Sending a different value in each is how a correct code gets
    /// refused.
    @Test("disabling TOTP repeats the code in the body the server falls back to")
    func disableRepeatsTheCode() throws {
        let endpoint = try Endpoint.disableTotp(step: StepUp(accessCode: "code", totp: "654321"))
        #expect(endpoint.method == "DELETE")
        #expect(body(endpoint)?["code"] as? String == "654321")
        #expect(endpoint.stepUp?.headers["x-luma-totp"] == "654321")
    }

    @Test("the routes are the ones the server publishes")
    func paths() throws {
        let step = StepUp(accessCode: "code")
        #expect(Endpoint.security().path == "/security")
        #expect(try Endpoint.setAccessCode("x", step: step).method == "PUT")
        #expect(try Endpoint.setAccessCode("x", step: step).path == "/security/access-code")
        #expect(Endpoint.startTotp(step: step).path == "/security/totp")
        #expect(Endpoint.revokeSession("s2", step: step).path == "/security/sessions/s2")
        #expect(Endpoint.revokeSession("s2", step: step).method == "DELETE")
        #expect(Endpoint.revokeOtherSessions(step: step).path == "/security/sessions/revoke-others")
    }

    // MARK: Failures

    /// A step-up refusal is answered in place by the sheet. Reading it as a dead
    /// session would sign the owner out at the exact moment they were proving
    /// who they are.
    @Test("only the two step-up codes re-prompt, and none of them signs out")
    func stepUpFailures() {
        let required = APIError.server(status: 403, ServerError(code: "step_up_required", message: "confirm"))
        let bad = APIError.server(status: 403, ServerError(code: "bad_step_up", message: "nope"))
        let elsewhere = APIError.server(status: 403, ServerError(code: "bad_origin", message: "no"))
        let expired = APIError.server(status: 401, ServerError(code: "unauthorized", message: "sign in"))

        #expect(required.isStepUp)
        #expect(bad.isStepUp)
        #expect(!elsewhere.isStepUp)
        #expect(!expired.isStepUp)

        #expect(!required.signsOut)
        #expect(!bad.signsOut)
        #expect(expired.signsOut)
    }

    private func body(_ endpoint: Endpoint) -> [String: Any]? {
        guard let data = endpoint.body else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}
