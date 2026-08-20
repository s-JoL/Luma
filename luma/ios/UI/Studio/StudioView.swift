import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct StudioView: View {
    @Environment(AppModel.self) private var app
    @State private var pickingSource = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var zoom: ZoomedImage?
    @State private var playing: PlayingVideo?
    @State private var prompt = ""

    private var store: StudioStore { app.studio }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.lg) {
                // An empty catalogue and a catalogue still being read look
                // identical, and "没有可用模型" is a far more alarming thing to say
                // about a request that has not come back yet than about one that
                // came back empty.
                if store.tools.isEmpty && store.isLoading {
                    HStack { Spacer(); Spinner(); Spacer() }
                        .padding(.top, Space.xxl)
                } else if !store.enabled {
                    ContentUnavailableView("创作台未开启", systemImage: Symbols.studio, description: Text("在网页端的设置里打开生成能力"))
                } else if store.tools.isEmpty {
                    ContentUnavailableView("没有可用模型", systemImage: Symbols.studio, description: Text("配置一个生图或视频后端后再来"))
                } else {
                    form
                    queue
                    gallery
                }
            }
            .padding(Space.lg)
        }
        .background(Color.bg)
        .navigationTitle("创作台")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await store.load()
            prompt = store.values["prompt"]?.stringValue ?? ""
        }
        .refreshable { await store.load() }
        .sheet(isPresented: $pickingSource) { sourceSheet }
        .fullScreenCover(item: $zoom) { item in ImageViewer(imageId: item.imageId) }
        .fullScreenCover(item: $playing) { item in VideoViewer(videoId: item.videoId, poster: item.poster) }
        .onChange(of: photos) { _, items in
            guard let item = items.first else { return }
            Task { await uploadSource(item); photos = [] }
        }
        .onChange(of: store.toolKey) { _, _ in
            prompt = store.values["prompt"]?.stringValue ?? ""
        }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            if store.kinds.count > 1 {
                Picker("创作方式", selection: Binding(
                    get: { store.tool?.kind ?? .generate },
                    set: { store.selectKind($0) }
                )) {
                    ForEach(store.kinds, id: \.self) { kind in
                        Text(kind.label).tag(kind)
                    }
                }
                .pickerStyle(.segmented)
            }

            if store.kindTools.count > 1 {
                Picker("模型", selection: Binding(
                    get: { store.toolKey },
                    set: { store.selectTool($0) }
                )) {
                    ForEach(store.kindTools) { tool in
                        Text(tool.serverTitle).tag(tool.id)
                    }
                }
            } else if let tool = store.tool {
                LabeledContent("模型", value: tool.serverTitle)
                    .foregroundStyle(.secondary)
            }

            if store.tool?.schema.properties["source_image_id"] != nil {
                VStack(alignment: .leading, spacing: Space.sm) {
                    Text("源图").font(.footnote.weight(.medium)).foregroundStyle(.secondary)
                    HStack {
                        if !store.sourceId.isEmpty {
                            AuthedImage(imageId: ImageId(store.sourceId), width: 160)
                                .frame(width: 72, height: 72)
                                .clipShape(RoundedRectangle(cornerRadius: Radius.md))
                        } else {
                            RoundedRectangle(cornerRadius: Radius.md)
                                .fill(Color.mutedFill)
                                .frame(width: 72, height: 72)
                                .overlay(Image(systemName: "photo").foregroundStyle(Color.mutedFg))
                        }
                        VStack(alignment: .leading, spacing: Space.xs) {
                            Button("从图书馆选") { pickingSource = true }
                            PhotosPicker(selection: $photos, maxSelectionCount: 1, matching: .images) {
                                Text("从相册上传")
                            }
                            if !store.sourceId.isEmpty {
                                Button("清除", role: .destructive) { store.sourceId = "" }
                            }
                        }
                    }
                }
            }

            VStack(alignment: .leading, spacing: Space.xs) {
                Text("提示词").font(.footnote.weight(.medium)).foregroundStyle(.secondary)
                TextField("描述你想要的画面", text: $prompt, axis: .vertical)
                    .lineLimit(3...8)
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: prompt) { _, value in
                        store.values["prompt"] = .string(value)
                    }
            }

            if let schema = store.tool?.schema {
                SchemaForm(schema: schema, values: Binding(
                    get: { app.studio.values },
                    set: { app.studio.values = $0 }
                ))
            }

            Button {
                Task {
                    do { try await store.submit() }
                    catch let error as APIError { app.handle(error) }
                    catch {}
                }
            } label: {
                HStack {
                    if store.isSubmitting { Spinner() }
                    Text(store.tool?.kind.action ?? "开始生成")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(store.isSubmitting || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(Space.lg)
        .background(Color.card, in: RoundedRectangle(cornerRadius: Radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(Color.hairline, lineWidth: 1))
    }

    @ViewBuilder
    private var queue: some View {
        if !store.jobs.isEmpty {
            VStack(alignment: .leading, spacing: Space.sm) {
                Text("生成队列").font(.headline)
                ForEach(store.jobs) { job in
                    JobCard(job: job) {
                        Task {
                            do { try await store.cancel(job.id) }
                            catch let error as APIError { app.handle(error) }
                            catch {}
                        }
                    }
                }
            }
        }
    }

    private var gallery: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack {
                Text("图库").font(.headline)
                Spacer()
                if store.galleryTotal > 0 {
                    Text("\(store.galleryTotal) 张")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            HStack(alignment: .top, spacing: Space.sm) {
                galleryColumn(0)
                galleryColumn(1)
            }
            if store.gallery.count < store.galleryTotal {
                Button("加载更多") { Task { await store.loadMoreGallery() } }
                    .frame(maxWidth: .infinity)
            }
        }
    }

    private func galleryColumn(_ column: Int) -> some View {
        VStack(spacing: Space.sm) {
            ForEach(store.gallery.enumerated().compactMap { $0.offset % 2 == column ? $0.element : nil }) { asset in
                Button {
                    if asset.kind == .video {
                        playing = PlayingVideo(asset.assetId, poster: asset.poster)
                    } else {
                        zoom = ZoomedImage(asset.assetId)
                    }
                } label: {
                    GalleryTile(asset: asset)
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var sourceSheet: some View {
        NavigationStack {
            List(app.library.items.filter(\.isImage)) { file in
                Button {
                    store.sourceId = file.id.raw
                    pickingSource = false
                } label: {
                    HStack {
                        AuthedImage(imageId: ImageId(file.id.raw), width: 80)
                            .frame(width: 48, height: 48)
                            .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
                        Text(file.name)
                    }
                }
            }
            .navigationTitle("选一张源图")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { pickingSource = false }
                }
            }
            .task { await app.library.load() }
        }
    }

    private func uploadSource(_ item: PhotosPickerItem) async {
        guard let data = try? await item.loadTransferable(type: Data.self) else { return }
        let mime = "image/jpeg"
        do { try await store.uploadSource(data: data, filename: "source.jpg", mime: mime) }
        catch let error as APIError { app.handle(error) }
        catch {}
    }
}

private struct SchemaForm: View {
    let schema: JsonSchema
    @Binding var values: [String: JSONValue]
    @State private var showingAdvanced = false

    private static let hidden: Set<String> = [
        "prompt", "source_image_id", "additional_source_image_ids",
        "placement_key", "intent",
    ]

    private var fields: [(String, JsonSchema)] {
        schema.properties
            .filter { !Self.hidden.contains($0.key) }
            .sorted { $0.key < $1.key }
    }

    private var shared: [(String, JsonSchema)] {
        fields.filter { $0.1.audience != "studio" }
    }

    private var manual: [(String, JsonSchema)] {
        fields.filter { $0.1.audience == "studio" }
    }

    var body: some View {
        ForEach(shared, id: \.0) { name, field in
            fieldView(name, field)
        }
        if !manual.isEmpty {
            DisclosureGroup(isExpanded: $showingAdvanced) {
                ForEach(manual, id: \.0) { name, field in
                    fieldView(name, field)
                }
            } label: {
                HStack {
                    Text("高级")
                    Spacer()
                    Text("\(manual.count) 项")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private func fieldView(_ name: String, _ field: JsonSchema) -> some View {
        let title = field.label(for: name)
        if !field.enumValues.isEmpty {
            Picker(title, selection: binding(name, fallback: field.enumValues.first ?? .null)) {
                ForEach(field.enumValues, id: \.self) { value in
                    Text(value.shortLabel).tag(value)
                }
            }
        } else if field.type == "boolean" {
            Toggle(title, isOn: boolBinding(name))
        } else if field.type == "integer" || field.type == "number" {
            HStack {
                Text(title).font(.subheadline)
                Spacer()
                TextField("", text: numberBinding(name, integer: field.type == "integer"))
                    .keyboardType(.numbersAndPunctuation)
                    .multilineTextAlignment(.trailing)
                    .frame(width: 88)
            }
        } else if name == "negative_prompt" {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(title).font(.footnote.weight(.medium)).foregroundStyle(.secondary)
                TextField("可选", text: stringBinding(name), axis: .vertical)
                    .lineLimit(2...6)
                    .textFieldStyle(.roundedBorder)
            }
        } else {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(title).font(.footnote.weight(.medium)).foregroundStyle(.secondary)
                TextField("", text: stringBinding(name))
                    .textFieldStyle(.roundedBorder)
            }
        }
    }

    private func binding(_ name: String, fallback: JSONValue) -> Binding<JSONValue> {
        Binding(
            get: { values[name] ?? fallback },
            set: { values[name] = $0 }
        )
    }

    private func stringBinding(_ name: String) -> Binding<String> {
        Binding(
            get: { values[name]?.shortLabel ?? "" },
            set: { values[name] = .string($0) }
        )
    }

    private func boolBinding(_ name: String) -> Binding<Bool> {
        Binding(
            get: { values[name]?.boolValue ?? false },
            set: { values[name] = .bool($0) }
        )
    }

    private func numberBinding(_ name: String, integer: Bool) -> Binding<String> {
        Binding(
            get: { values[name]?.shortLabel ?? "" },
            set: { text in
                if integer, let n = Int(text) { values[name] = .number(Double(n)) }
                else if let n = Double(text) { values[name] = .number(n) }
                else if text.isEmpty { values[name] = nil }
            }
        )
    }
}

private struct JobCard: View {
    let job: JobRecord
    var onCancel: () -> Void

    var body: some View {
        HStack(spacing: Space.md) {
            VStack(alignment: .leading, spacing: 4) {
                Text(job.modelName).font(.subheadline.weight(.medium))
                Text(statusLabel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let progress = job.progress {
                    ProgressView(value: progress)
                } else if !job.status.isFinished {
                    ProgressView().controlSize(.small)
                }
                if let error = job.error, !error.isEmpty {
                    Text(error).font(.caption).foregroundStyle(Color.danger)
                }
            }
            Spacer()
            if !job.status.isFinished {
                Button("取消", action: onCancel)
            }
        }
        .padding(Space.md)
        .background(Color.mutedFill, in: RoundedRectangle(cornerRadius: Radius.md))
    }

    private var statusLabel: String {
        switch job.status {
        case .queued: "排队中"
        case .running: job.note ?? "生成中"
        case .succeeded: "完成"
        case .failed: "失败"
        case .cancelled: "已取消"
        }
    }
}

private struct GalleryTile: View {
    let asset: GeneratedAsset

    var body: some View {
        Color.clear
            .aspectRatio(asset.aspectRatio ?? 1, contentMode: .fit)
            .overlay {
                Group {
                    if asset.kind == .video {
                        VideoPoster(poster: asset.poster, width: 320, contentMode: .fill)
                    } else {
                        AuthedImage(imageId: ImageId(asset.assetId), width: 320, contentMode: .fill)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipped()
            }
            .clipShape(RoundedRectangle(cornerRadius: Radius.md))
    }
}