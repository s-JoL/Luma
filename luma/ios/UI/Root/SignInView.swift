import SwiftUI

/// Two steps on one screen: where the server is, then the access code. The
/// challenge is fetched before the second step so the second factor is asked for
/// up front rather than learned from a rejection.
struct SignInView: View {
    @Environment(AppModel.self) private var app

    @State private var address = ""
    @State private var accessCode = ""
    @State private var totp = ""

    @State private var probe: ProbeState = .idle
    @State private var totpRequired = false
    @State private var lockedFor = 0
    @State private var busy = false
    @State private var signInError: String?
    @FocusState private var focus: Field?

    private enum Field { case address, code, totp }

    private enum ProbeState: Equatable {
        case idle, checking, ok(version: String), failed(String)
    }

    /// One soft brand glow behind the page. The sign-in screen is the only place
    /// in the app with decorative colour — everywhere else the content is the
    /// interest, and a gradient behind a transcript is just noise under text.
    private struct SignInBackdrop: View {
        @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

        var body: some View {
            ZStack {
                Color.bg
                if !reduceTransparency {
                    RadialGradient(
                        colors: [Color.brand.opacity(0.20), .clear],
                        center: .init(x: 0.15, y: 0.05),
                        startRadius: 8,
                        endRadius: 460
                    )
                    RadialGradient(
                        colors: [Color.brand.mix(with: .purple, by: 0.5).opacity(0.14), .clear],
                        center: .init(x: 0.95, y: 0.35),
                        startRadius: 8,
                        endRadius: 380
                    )
                }
            }
            .ignoresSafeArea()
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.xl) {
                header
                serverStep
                if app.session == .signedOut { codeStep }
            }
            .frame(maxWidth: 360)
            .padding(Space.xl)
            .frame(maxWidth: .infinity)
        }
        .background(SignInBackdrop())
        .scrollDismissesKeyboard(.interactively)
        .task { await prepare() }
        .onChange(of: app.session) { _, _ in Task { await prepare() } }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            Image(systemName: "moon.stars.fill")
                .font(.system(size: 34))
                .foregroundStyle(LinearGradient.brandFill)
                .shadow(color: Color.brand.opacity(0.35), radius: 14, y: 4)
            VStack(alignment: .leading, spacing: 2) {
                Text("Luma")
                    .font(.system(size: 34, weight: .semibold, design: .rounded))
                Text("连接你自己的那台机器")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.bottom, Space.xs)
    }

    // MARK: Step 1

    @ViewBuilder
    private var serverStep: some View {
        SectionCard(title: "服务器") {
            TextField("mac.local:8090", text: $address)
                .textFieldStyle(.plain)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .focused($focus, equals: .address)
                .onSubmit { Task { await connect() } }
                .padding(Space.md)
                .background(Color.mutedFill, in: RoundedRectangle(cornerRadius: Radius.md))
                .accessibilityIdentifier("server.address")

            switch probe {
            case .idle:
                Text("本机写主机和端口，公网域名会走 HTTPS。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            case .checking:
                HStack(spacing: Space.sm) {
                    Spinner()
                    Text("正在连接…").font(.caption).foregroundStyle(.secondary)
                }
            case .ok(let version):
                Text("已连接 · Luma \(version)")
                    .font(.caption)
                    .foregroundStyle(Color.ok)
            case .failed(let message):
                Text(message)
                    .font(.caption)
                    .foregroundStyle(Color.danger)
            }

            Button {
                Task { await connect() }
            } label: {
                Text(app.session == .needsServer ? "连接" : "换一个地址")
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .disabled(address.trimmingCharacters(in: .whitespaces).isEmpty || probe == .checking)
            .accessibilityIdentifier("server.connect")
        }
    }

    // MARK: Step 2

    @ViewBuilder
    private var codeStep: some View {
        SectionCard(title: "访问码") {
            SecureField("访问码", text: $accessCode)
                .textContentType(.password)
                .submitLabel(totpRequired ? .next : .go)
                .focused($focus, equals: .code)
                .onSubmit {
                    if totpRequired { focus = .totp } else { Task { await signIn() } }
                }
                .padding(Space.md)
                .background(Color.mutedFill, in: RoundedRectangle(cornerRadius: Radius.md))
                .accessibilityIdentifier("auth.accessCode")

            if totpRequired {
                TextField("6 位动态码", text: $totp)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .focused($focus, equals: .totp)
                    .padding(Space.md)
                    .background(Color.mutedFill, in: RoundedRectangle(cornerRadius: Radius.md))
                    .accessibilityIdentifier("auth.totp")
            }

            if let signInError {
                Text(signInError)
                    .font(.caption)
                    .foregroundStyle(Color.danger)
            }

            Button {
                Task { await signIn() }
            } label: {
                Group {
                    if busy {
                        ProgressView().tint(Color.onBrand)
                    } else if lockedFor > 0 {
                        Text("太多次尝试，请在 \(lockedFor) 秒后重试")
                    } else {
                        Text("登录")
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!canSignIn)
            .accessibilityIdentifier("auth.signIn")
        }
        .task(id: lockedFor) {
            // A live countdown, because the server will answer 429 anyway and
            // letting someone hammer a locked endpoint is worse than saying so.
            guard lockedFor > 0 else { return }
            try? await Task.sleep(for: .seconds(1))
            if lockedFor > 0 { lockedFor -= 1 }
        }
    }

    private var canSignIn: Bool {
        !busy
            && lockedFor == 0
            && !accessCode.trimmingCharacters(in: .whitespaces).isEmpty
            && (!totpRequired || totp.trimmingCharacters(in: .whitespaces).count >= 6)
    }

    // MARK: Actions

    private func prepare() async {
        if address.isEmpty, let url = app.serverURL {
            address = url.host().map { host in
                url.port.map { "\(host):\($0)" } ?? host
            } ?? url.absoluteString
        }
        guard app.session == .signedOut else { return }
        if let challenge = try? await app.challenge() {
            totpRequired = challenge.totpRequired
            lockedFor = challenge.lockedFor
        }
    }

    private func connect() async {
        probe = .checking
        signInError = nil
        do {
            let health = try await app.probe(address)
            probe = .ok(version: health.version)
            await app.useServer(address)
            await prepare()
            focus = .code
        } catch let error as APIError {
            probe = .failed(error.display)
        } catch {
            probe = .failed("连不上，检查地址和端口")
        }
    }

    private func signIn() async {
        busy = true
        signInError = nil
        defer { busy = false }

        do {
            try await app.signIn(
                accessCode: accessCode.trimmingCharacters(in: .whitespaces),
                totp: totp.trimmingCharacters(in: .whitespaces)
            )
            accessCode = ""
            totp = ""
        } catch let error as APIError {
            // `totp_required` is a prompt, not a failure: reveal the field and
            // keep what was typed rather than reporting an error.
            if error.code == "totp_required" {
                totpRequired = true
                signInError = nil
                focus = .totp
                return
            }
            if case .server(429, _) = error {
                lockedFor = max(lockedFor, 60)
            }
            signInError = error.display
            totp = ""
        } catch {
            signInError = "登录失败"
        }
    }
}
