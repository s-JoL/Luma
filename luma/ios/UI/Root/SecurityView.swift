import SwiftUI

/// 设置 → 安全, the same four concerns as the web's security screen and the same
/// rule behind all of them: a change that outlives the session making it is not
/// made on that session alone. Reading this screen needs a live login; changing
/// anything on it needs the access code again, and the authenticator too once
/// one is enrolled.
struct SecurityView: View {
    @Environment(AppModel.self) private var app

    @State private var state: SecuritySettings?
    @State private var accessCode = ""
    @State private var enrolment: TotpEnrolment?
    @State private var code = ""
    @State private var pending: Confirmable?
    @State private var busy = false

    var body: some View {
        List {
            if let state {
                accessCodeSection(state)
                totpSection(state)
                sessionsSection(state)
                exposureSection(state)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Color.bg)
        .navigationTitle("安全")
        .navigationBarTitleDisplayMode(.inline)
        .overlay {
            if state == nil { ProgressView() }
        }
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $pending) { request in
            StepUpSheet(
                request: request,
                totpRequired: state?.totpEnabled ?? false,
                finish: { message in
                    pending = nil
                    if let message { app.note(message) }
                }
            )
        }
    }

    // MARK: Access code

    private func accessCodeSection(_ state: SecuritySettings) -> some View {
        Section {
            SecureField("新的访问码（至少 12 位）", text: $accessCode)
                .textContentType(.newPassword)
                .accessibilityIdentifier("security.newAccessCode")
            Button("保存") {
                let value = accessCode.trimmingCharacters(in: .whitespacesAndNewlines)
                pending = Confirmable(
                    title: "修改访问码",
                    detail: "确认后访问码立即更换，其他设备要用新的访问码重新登录。",
                    confirm: "修改访问码",
                    done: "访问码已更新"
                ) { api, step in
                    self.state = try await api.send(
                        .setAccessCode(value, step: step), as: SecuritySettings.self
                    )
                    accessCode = ""
                }
            }
            .disabled(accessCode.trimmingCharacters(in: .whitespacesAndNewlines).count < 12)
        } header: {
            HStack {
                Text("访问码").textCase(nil)
                Spacer()
                Badge(text: state.overTls ? "HTTPS" : "明文 HTTP", tone: state.overTls ? .ok : .warn)
            }
        } footer: {
            Text(state.overTls
                 ? "至少 12 位，越长越好。改完之后，除了这台设备，其他登录都会失效。"
                 : "至少 12 位，越长越好。当前是明文连接，对外暴露前请先走 HTTPS 入口，否则访问码会在链路上明文传输。")
        }
    }

    // MARK: Two-factor

    @ViewBuilder
    private func totpSection(_ state: SecuritySettings) -> some View {
        Section {
            if state.totpEnabled {
                Button("关闭两步验证", role: .destructive) {
                    pending = Confirmable(
                        title: "关闭两步验证",
                        detail: "关闭后，只要拿到访问码就能登录。",
                        danger: true,
                        confirm: "关闭两步验证",
                        done: "已关闭两步验证"
                    ) { api, step in
                        self.state = try await api.send(
                            .disableTotp(step: step), as: SecuritySettings.self
                        )
                    }
                }
            } else if let enrolment {
                enrolmentRows(enrolment)
            } else {
                Button("开始绑定") {
                    pending = Confirmable(
                        title: "开始绑定验证器",
                        detail: "确认后会生成一个新的密钥，扫码并回填动态码才真正启用。",
                        confirm: "生成密钥",
                        done: "密钥已生成，请完成绑定"
                    ) { api, step in
                        enrolment = try await api.send(
                            .startTotp(step: step), as: TotpEnrolment.self
                        )
                    }
                }
            }
        } header: {
            HStack {
                Text("两步验证").textCase(nil)
                Spacer()
                Badge(text: state.totpEnabled ? "已开启" : "未开启", tone: state.totpEnabled ? .ok : .warn)
            }
        } footer: {
            if state.totpEnabled {
                Text("登录时需要访问码加验证器动态码。关闭同样需要访问码和一个当前有效的动态码。")
            } else if enrolment != nil {
                Text("绑定成功前不会启用，不会把你自己锁在门外。")
            } else {
                Text("开启后，即使访问码泄露，没有你手机上的动态码也进不来。对外暴露时建议开启。")
            }
        }
    }

    /// The secret is shown as text as well as a link because an authenticator on
    /// *this* phone has no camera to scan its own screen with, and typing 32
    /// base32 characters off a laptop is how enrolment gets abandoned.
    @ViewBuilder
    private func enrolmentRows(_ enrolment: TotpEnrolment) -> some View {
        copyableRow("密钥", value: enrolment.secret)
        copyableRow("otpauth 链接", value: enrolment.uri)
        TextField("6 位动态码", text: $code)
            .keyboardType(.numberPad)
            .textContentType(.oneTimeCode)
            .accessibilityIdentifier("security.totpCode")
        Button("完成绑定") { Task { await confirmTotp() } }
            .disabled(busy || code.trimmingCharacters(in: .whitespacesAndNewlines).count < 6)
        Button("取消", role: .cancel) {
            self.enrolment = nil
            code = ""
        }
    }

    private func copyableRow(_ title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            HStack {
                Text(title).font(.footnote.weight(.medium)).foregroundStyle(.secondary)
                Spacer()
                Button {
                    UIPasteboard.general.string = value
                    Haptics.success()
                    app.note("已复制")
                } label: {
                    Label("复制", systemImage: "doc.on.doc").labelStyle(.iconOnly)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.brand)
            }
            Text(value)
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .foregroundStyle(Color.fg)
        }
    }

    // MARK: Sessions

    private func sessionsSection(_ state: SecuritySettings) -> some View {
        Section {
            ForEach(state.sessions) { session in
                sessionRow(session, current: session.id == state.currentSessionId)
            }
            if state.otherSessions > 0 {
                Button("注销其他设备", role: .destructive) {
                    pending = Confirmable(
                        title: "注销其他设备",
                        detail: "除当前设备外的 \(state.otherSessions) 个会话会立即失效。",
                        danger: true,
                        confirm: "全部注销",
                        done: "已注销其他设备"
                    ) { api, step in
                        self.state = try await api.send(
                            .revokeOtherSessions(step: step), as: SecuritySettings.self
                        )
                    }
                }
            }
        } header: {
            Text("登录设备（\(state.sessions.count)）").textCase(nil)
        } footer: {
            Text("注销一台设备之后，它下次要重新输入访问码。")
        }
    }

    private func sessionRow(_ session: SessionRecord, current: Bool) -> some View {
        HStack(spacing: Space.md) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Space.xs) {
                    Text(session.device).lineLimit(1)
                    if current { Badge(text: "当前设备", tone: .ok) }
                }
                Text("登录于 \(Stamp.of(session.createdAt)) · 最近活跃 \(Stamp.of(session.lastSeen))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: Space.sm)
            // The current session is not offered: signing this device out is
            // 退出登录 on the settings screen, and doing it from here would read
            // as revoking someone else's.
            if !current {
                Button("注销") {
                    pending = Confirmable(
                        title: "注销这台设备",
                        detail: "\(session.device)，最近活跃 \(Stamp.of(session.lastSeen))。",
                        danger: true,
                        confirm: "注销",
                        done: "已注销"
                    ) { api, step in
                        self.state = try await api.send(
                            .revokeSession(session.id, step: step), as: SecuritySettings.self
                        )
                    }
                }
                .font(.footnote)
                .foregroundStyle(Color.danger)
            }
        }
    }

    // MARK: Exposure

    private func exposureSection(_ state: SecuritySettings) -> some View {
        Section {
            LabeledContent("反向代理") {
                Badge(text: state.trustProxy ? "已信任" : "仅本机地址", tone: state.trustProxy ? .ok : .neutral)
            }
        } header: {
            Text("对外访问").textCase(nil)
        } footer: {
            Text("推荐用隧道暴露：本机不开公网端口，访问码与两步验证是第二层。走反向代理时要把 LUMA_TRUST_PROXY 设为 1，否则限速会按本机统计，这一页也分不清连接是不是 HTTPS。")
        }
    }

    // MARK: Loading

    private func load() async {
        do {
            state = try await app.api.send(.security(), as: SecuritySettings.self)
        } catch let error as APIError {
            app.handle(error)
        } catch {}
    }

    /// The only write here that needs no step-up: a code generated from the
    /// pending secret is itself the proof, which is what the two-step enrolment
    /// exists to obtain.
    private func confirmTotp() async {
        busy = true
        defer { busy = false }
        do {
            state = try await app.api.send(
                .confirmTotp(code.trimmingCharacters(in: .whitespacesAndNewlines)),
                as: SecuritySettings.self
            )
            enrolment = nil
            code = ""
            app.note("两步验证已开启")
        } catch let error as APIError {
            app.handle(error)
            // Whether it was wrong or already spent, the next attempt needs a
            // fresh one.
            code = ""
        } catch {}
    }
}

/// A change the server will not make on a session alone. It is held until the
/// owner has confirmed it, so the credentials are asked for once, in front of a
/// sentence naming what they authorise — rather than as permanent fields beside
/// every button, which is the version nobody reads before typing into.
private struct Confirmable: Identifiable {
    let id = UUID()
    let title: String
    let detail: String
    var danger = false
    let confirm: String
    let done: String
    /// The client is handed in rather than captured. This closure outlives the
    /// body that made it, and an `@Environment` value read after the view it was
    /// installed on has gone is the classic way a sheet ends up talking to
    /// nothing.
    let run: @MainActor (APIClient, StepUp) async throws -> Void
}

/// The one screen a locked-out owner cannot recover from, so a wrong answer
/// never closes it: `step_up_required` and `bad_step_up` both re-prompt in place
/// with what was typed kept, and only an unrelated failure falls through to the
/// toast and dismisses.
private struct StepUpSheet: View {
    let request: Confirmable
    let totpRequired: Bool
    /// A message to announce, or nothing when the sheet is being abandoned.
    var finish: (String?) -> Void

    @Environment(AppModel.self) private var app

    @State private var accessCode = ""
    @State private var totp = ""
    @State private var message = ""
    @State private var busy = false

    private var ready: Bool {
        !accessCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (!totpRequired || totp.trimmingCharacters(in: .whitespacesAndNewlines).count >= 6)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("当前访问码", text: $accessCode)
                        .textContentType(.password)
                        .accessibilityIdentifier("stepUp.accessCode")
                    if totpRequired {
                        TextField("6 位动态码", text: $totp)
                            .keyboardType(.numberPad)
                            .textContentType(.oneTimeCode)
                            .accessibilityIdentifier("stepUp.totp")
                    }
                } header: {
                    Text(request.detail).textCase(nil)
                } footer: {
                    // Below both fields rather than beside one: a refusal never
                    // says which half was wrong, and neither does this.
                    if message.isEmpty {
                        Text("这类改动会比当前登录活得更久，所以要再确认一次身份。")
                    } else {
                        Text(message).foregroundStyle(Color.danger)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.bg)
            .navigationTitle(request.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { finish(nil) }.disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(request.confirm) { Task { await submit() } }
                        .disabled(!ready || busy)
                        .accessibilityIdentifier("stepUp.confirm")
                }
            }
        }
        .presentationDetents([.medium])
        .interactiveDismissDisabled(busy)
    }

    private func submit() async {
        guard ready, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            try await request.run(app.api, StepUp(
                accessCode: accessCode.trimmingCharacters(in: .whitespacesAndNewlines),
                totp: totp.trimmingCharacters(in: .whitespacesAndNewlines)
            ))
            finish(request.done)
        } catch let error as APIError where error.isStepUp {
            message = explain(error)
            // The code just typed is either wrong or already spent; the next
            // attempt needs a fresh one either way.
            totp = ""
        } catch let error as APIError where error.code == "too_many_attempts" {
            message = error.display
        } catch let error as APIError {
            app.handle(error)
            finish(nil)
        } catch {
            message = "确认失败，请再试一次。"
        }
    }

    /// The server's own message is English, and this is the one prompt where the
    /// reader is mid-panic; the two codes it can answer with are fixed, so they
    /// are said in the app's language exactly as the web says them.
    private func explain(_ error: APIError) -> String {
        if error.code == "bad_step_up" {
            return totpRequired
                ? "访问码或动态码不对。动态码每 30 秒一换，请用最新的一个。"
                : "访问码不对，请重新输入。"
        }
        return totpRequired ? "这一步需要访问码和验证器动态码。" : "这一步需要访问码。"
    }
}

/// 登录于 / 最近活跃 want an absolute moment. The conversation list's relative
/// day is the right answer there and the wrong one here: "上周三" is not enough
/// to recognise a session you do not remember opening.
private enum Stamp {
    static func of(_ millis: Int) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "M月d日 HH:mm"
        return formatter.string(from: Date(timeIntervalSince1970: Double(millis) / 1000))
    }
}
