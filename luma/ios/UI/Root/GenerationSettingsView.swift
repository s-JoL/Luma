import SwiftUI

/// 设置 → 生成后端. Which model answers 生图, 改图 and 做视频 when nobody names
/// one — in the conversation, and as the pre-selected tool when 创作台 opens.
///
/// Only the three slots, not the backends themselves. A generation row carries
/// an adapter parameter block (a ComfyUI graph binding, a size table) that this
/// screen has no way to render, and `PATCH` merges what it is sent: an editor
/// that showed a subset here would erase the rest on save. Adding and editing a
/// backend stays on the web until that block has a form of its own.
struct GenerationSettingsView: View {
    let settings: SettingsStore

    private var images: [ModelSpec] { settings.generationModels(.image) }
    private var videos: [ModelSpec] { settings.generationModels(.video) }

    var body: some View {
        List {
            if images.isEmpty && videos.isEmpty {
                Section {
                    Text("这台服务器上没有启用的生成后端。")
                        .foregroundStyle(.secondary)
                }
            } else {
                Section {
                    slot(
                        "生图",
                        options: settings.generationModels(.image, op: .textToImage),
                        selected: settings.catalogue.generation.image
                    ) { GenerationDefaultsInput(imageModelId: $0) }
                    slot(
                        "改图",
                        options: settings.generationModels(.image, op: .imageToImage),
                        selected: settings.catalogue.generation.edit
                    ) { GenerationDefaultsInput(editModelId: $0) }
                    slot(
                        "视频",
                        options: videos,
                        selected: settings.catalogue.generation.video
                    ) { GenerationDefaultsInput(videoModelId: $0) }
                } header: {
                    SectionHeader(title: "默认后端", symbol: "wand.and.stars")
                } footer: {
                    Text("留在「按可用后端选」时，服务端挑一个配置齐全的。")
                }

                Section {
                    ForEach(images + videos) { model in
                        backend(model)
                    }
                } header: {
                    Text("这台服务器上的后端").textCase(nil)
                } footer: {
                    Text("加后端、改 ComfyUI 工作流参数请用网页：那一块参数是 adapter 自己的 schema，这里还渲染不了。")
                }
            }
        }
        .formChrome("生成后端")
        .overlay {
            if settings.catalogue.items.isEmpty && settings.isLoading { ProgressView() }
        }
        .task { await settings.loadCatalogue() }
        .refreshable { await settings.loadCatalogue() }
    }

    private func slot(
        _ title: String,
        options: [ModelSpec],
        selected: String,
        input: @escaping (String) -> GenerationDefaultsInput
    ) -> some View {
        Picker(title, selection: Binding(
            get: { selected },
            set: { next in
                guard next != selected else { return }
                Task { await settings.setGenerationDefaults(input(next)) }
            }
        )) {
            Text("按可用后端选").tag("")
            ForEach(options) { model in
                Text(model.name).tag(model.id.raw)
            }
        }
        .disabled(settings.isWriting)
    }

    private func backend(_ model: ModelSpec) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: Space.xs) {
                Text(model.name).lineLimit(1)
                if model.agentTool { Badge(text: "对话可点名", tone: .ok) }
                if !model.isUsable { Badge(text: "缺少密钥", tone: .warn) }
            }
            Text(subtitle(model))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }

    private func subtitle(_ model: ModelSpec) -> String {
        var parts = [model.kind.rawValue, model.providerId.raw, settings.apiModeLabel(model.apiMode)]
        if !model.ops.isEmpty {
            parts.append(model.ops.map(\.rawValue).joined(separator: " / "))
        }
        return parts.joined(separator: " · ")
    }
}
