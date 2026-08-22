import SwiftUI

/// Same seven concerns as the web settings, on `/v1`. Keys are write-only.
///
/// The sub-screens share one `SettingsStore` created here. They read the same
/// provider and model catalogue, and giving each its own copy meant a model
/// added on one screen was missing from the picker on the next until something
/// re-read `bootstrap`.
struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @State private var settings = SettingsStore()
    @State private var signingOut = false

    var body: some View {
        List {
            serverSection
            if app.bootstrap != nil {
                Section {
                    NavigationLink { ProvidersSettingsView(settings: settings) } label: {
                        Label("提供方", systemImage: "powerplug")
                    }
                    NavigationLink { ModelsSettingsView(settings: settings) } label: {
                        Label("对话模型", systemImage: "cpu")
                    }
                    NavigationLink { GenerationSettingsView(settings: settings) } label: {
                        Label("生成后端", systemImage: "wand.and.stars")
                    }
                    NavigationLink { CapabilitiesSettingsView(settings: settings) } label: {
                        Label("能力", systemImage: "switch.2")
                    }
                    NavigationLink { PromptsSettingsView(settings: settings) } label: {
                        Label("提示词", systemImage: "text.alignleft")
                    }
                    NavigationLink { McpSettingsView(settings: settings) } label: {
                        Label("扩展", systemImage: "puzzlepiece.extension")
                    }
                    NavigationLink { SecurityView() } label: {
                        Label("安全", systemImage: "lock")
                    }
                } header: {
                    SectionHeader(title: "配置", symbol: "slider.horizontal.3")
                } footer: {
                    Text("密钥只写入、不会读回来。")
                }
            }
            aboutSection
        }
        .formChrome("设置")
        .task { settings.attach(app) }
        .alert("退出登录", isPresented: $signingOut) {
            Button("取消", role: .cancel) {}
            Button("退出", role: .destructive) { Task { await app.signOut() } }
        } message: {
            Text("这台设备的令牌会被清除，下次要重新输入访问码。")
        }
    }

    private var serverSection: some View {
        Section {
            LabeledContent("地址") {
                Text(app.serverURL?.absoluteString ?? "未设置")
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            LabeledContent("版本") {
                Text(app.bootstrap?.version ?? "…").foregroundStyle(.secondary)
            }
            if let millis = app.lastBootstrapMillis {
                LabeledContent("启动往返") {
                    Text("\(millis) ms")
                        .foregroundStyle(millis < 150 ? Color.ok : Color.mutedFg)
                        .monospacedDigit()
                }
            }
            Button(role: .destructive) { signingOut = true } label: {
                Label("退出登录", systemImage: "rectangle.portrait.and.arrow.right")
            }
        } header: {
            SectionHeader(title: "服务器", symbol: "server.rack")
        }
    }

    private var aboutSection: some View {
        Section {
            LabeledContent("客户端") {
                Text(clientVersion).foregroundStyle(.secondary).monospacedDigit()
            }
        } header: {
            SectionHeader(title: "关于", symbol: "info.circle")
        } footer: {
            Text("数据都在这台服务器上。")
        }
    }

    private var clientVersion: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = info?["CFBundleVersion"] as? String ?? "1"
        return "\(short) (\(build))"
    }
}
