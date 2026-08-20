import Foundation

/// The server always answers with one envelope, never a bare string.
struct ServerError: Decodable, Sendable, Equatable {
    let code: String
    let message: String

    private enum Outer: String, CodingKey { case error }
    private enum Inner: String, CodingKey { case code, message }

    init(code: String, message: String) {
        self.code = code
        self.message = message
    }

    init(from decoder: any Decoder) throws {
        let outer = try decoder.container(keyedBy: Outer.self)
        let inner = try outer.nestedContainer(keyedBy: Inner.self, forKey: .error)
        code = try inner.decodeIfPresent(String.self, forKey: .code) ?? "error"
        message = try inner.decodeIfPresent(String.self, forKey: .message) ?? ""
    }
}

enum APIError: Error, Sendable, Equatable {
    case server(status: Int, ServerError)
    case transport(String)
    case decoding(String)
    /// `401` only. See `signsOut` — a `403` never lands here.
    case unauthorized
    case offline

    /// Safe to show verbatim; the server writes `message` for people. The app
    /// displays it rather than mapping `code` to its own string, so a new
    /// server-side failure mode is legible on a build that predates it.
    var display: String {
        switch self {
        case .server(_, let error):
            error.message.isEmpty ? "服务器拒绝了这个请求" : error.message
        case .transport, .offline:
            "连不上服务器，检查网络或服务器地址"
        case .decoding:
            "服务器返回了无法识别的数据"
        case .unauthorized:
            "登录已失效，请重新登录"
        }
    }

    var code: String? {
        if case .server(_, let error) = self { return error.code }
        return nil
    }

    /// Transport failures and the two statuses that mean "try again", at most
    /// twice, and only for a request that is safe to repeat.
    var isRetryable: Bool {
        switch self {
        case .transport, .offline: true
        case .server(let status, _): status == 503 || status == 429
        default: false
        }
    }

    /// **`401` signs out. `403` does not.** A revoked device fails
    /// `requireAuth` with `401 unauthorized`, so that is the whole sign-out
    /// condition. Every `403` the app can receive is a step-up prompt or a
    /// cross-site refusal, and treating it as a dead session would eject the
    /// owner the moment they tried to change their access code.
    var signsOut: Bool {
        switch self {
        case .unauthorized: true
        case .server(let status, _): status == 401
        default: false
        }
    }

    /// A privileged change the server will not make on a live session alone.
    /// The confirm sheet answers it in place; it is never a sign-out and never
    /// a toast.
    var isStepUp: Bool {
        guard case .server(403, let error) = self else { return false }
        return error.code == "step_up_required" || error.code == "bad_step_up"
    }

    /// The server rejecting a second concurrent run. The app treats this as
    /// "already running" rather than as an error to show.
    var isRunActive: Bool { code == "run_active" }

    /// A stop that raced the run's own end. The tap got what it asked for, so
    /// this is the one refusal that is silent.
    var isNoActiveRun: Bool { code == "no_active_run" }
}
