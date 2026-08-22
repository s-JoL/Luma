import SwiftUI

/// 设置 → 提示词. The global prompt, the tool prompt, and who names a
/// conversation.
///
/// Edited as one draft and saved in one write, unlike 能力: these are
/// paragraphs, and a field that saved itself would ask the server to re-read the
/// system prompt on every keystroke.
struct PromptsSettingsView: View {
    let settings: SettingsStore

    @State private var draft = PromptSettings(
        globalPrompt: "", toolPrompt: "", titleModelId: "", titleEnabled: true
    )
    @State private var loaded = false

    var body: some View {
        Form {
            if loaded {
                Section {
                    TextEditor(text: $draft.globalPrompt)
                        .frame(minHeight: 160)
                    restore("恢复默认", current: draft.globalPrompt, shipped: settings.promptDefaults?.globalPrompt) {
                        draft.globalPrompt = $0
                    }
                } header: {
                    Text("全局提示").textCase(nil)
                } footer: {
                    Text("每次请求都带上，排在最前面。")
                }

                Section {
                    TextEditor(text: $draft.toolPrompt)
                        .frame(minHeight: 120)
                    restore("恢复默认", current: draft.toolPrompt, shipped: settings.promptDefaults?.toolPrompt) {
                        draft.toolPrompt = $0
                    }
                } header: {
                    Text("工具提示").textCase(nil)
                } footer: {
                    Text("接在全局提示后面。支持 {{model_name}} 与 {{provider_name}} 两个占位符。")
                }

                Section {
                    Toggle("首轮结束后自动命名", isOn: $draft.titleEnabled)
                    Picker("命名使用的模型", selection: $draft.titleModelId) {
                        Text("跟随当前对话模型").tag("")
                        ForEach(titleModels) { model in
                            Text(model.name).tag(model.id.raw)
                        }
                        // A model that has since been deleted would otherwise
                        // leave the picker blank, which reads as 跟随当前对话模型
                        // — neither what is stored nor what will run.
                        if let missing = missingTitleModel {
                            Text("\(missing)（已不在列表里）").tag(missing)
                        }
                    }
                } header: {
                    Text("标题生成").textCase(nil)
                } footer: {
                    Text("小而快的模型就够用。")
                }

                Section {
                    WriteButton(
                        title: "保存",
                        isWriting: settings.isWriting,
                        action: { Task { await save() } }
                    )
                }
            }
        }
        .formChrome("提示词")
        .overlay {
            if !loaded { ProgressView() }
        }
        .task {
            await settings.loadPrompts()
            await settings.loadCatalogue()
            guard !loaded, let prompts = settings.prompts else { return }
            draft = prompts
            loaded = true
        }
    }

    private var titleModels: [ModelSpec] {
        settings.chatModels.filter(\.enabled)
    }

    private var missingTitleModel: String? {
        guard !draft.titleModelId.isEmpty else { return nil }
        return titleModels.contains { $0.id.raw == draft.titleModelId } ? nil : draft.titleModelId
    }

    /// Offered only while the field differs from what ships. An edited prompt is
    /// otherwise a one-way door: the recommended pair improves with the app, and
    /// an install that saved its own copy would never see any of it.
    @ViewBuilder
    private func restore(
        _ title: String, current: String, shipped: String?, apply: @escaping (String) -> Void
    ) -> some View {
        if let shipped, shipped != current {
            Button(title) { apply(shipped) }
                .font(.footnote)
        }
    }

    private func save() async {
        if await settings.savePrompts(draft), let saved = settings.prompts {
            draft = saved
        }
    }
}
