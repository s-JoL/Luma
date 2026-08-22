import PhotosUI
import SwiftUI

/// Ask for a picture, watch it arrive, look at what came out.
///
/// Not a form. The first two attempts at this screen were: one bordered box with
/// five kinds of control in it, and then a tidy grouped list — and the grouped
/// list, while consistent with 设置, was still a settings page. A generation tool
/// is a composer: the result is the screen, the prompt is the input, and the
/// parameters are a line of values you tap the one you want to change.
///
/// That last part is the whole idea. `paramChips` shows the current settings as
/// monospace chips — `1024×1024`, `28 步`, `cfg 4.5` — and tapping one opens a
/// short sheet for that parameter alone. Nobody opens 参数; everything adjustable
/// is already on screen, which makes the chip row the discovery surface as well
/// as the control.
struct StudioView: View {
    @Environment(AppModel.self) private var app

    @State private var prompt = ""
    @State private var editing: EditedParameter?
    @State private var pickingSource = false
    @State private var pickingExtra = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var inspecting: GeneratedAsset?

    private var store: StudioStore { app.studio }

    var body: some View {
        ZStack(alignment: .bottom) {
            canvas
            controls
        }
        .background(Color.bg)
        .navigationTitle("创作台")
        .navigationBarTitleDisplayMode(.inline)
        // Applied by hand because this screen is not a `FormScreen` — it is a
        // canvas with a floating panel, so it cannot inherit the container's
        // guarantee. Any screen that builds its own layout owes this line; the
        // first version of this rewrite forgot it and put the keyboard trap
        // straight back.
        .dismissableKeyboard()
        .toolbar {
            if store.kinds.count > 1 {
                ToolbarItem(placement: .principal) {
                    Picker("", selection: Binding(
                        get: { store.tool?.kind ?? .generate },
                        set: { store.selectKind($0) }
                    )) {
                        ForEach(store.kinds, id: \.self) { kind in
                            Text(kind.label).tag(kind)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .frame(maxWidth: 260)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink { GalleryView() } label: {
                    Label("图库", systemImage: "square.grid.2x2")
                }
                .disabled(store.gallery.isEmpty)
            }
        }
        .task {
            await store.load()
            prompt = store.values["prompt"]?.stringValue ?? ""
        }
        .refreshable { await store.load() }
        .sheet(item: $editing) { parameter in
            ParameterSheet(parameter: parameter, values: Binding(
                get: { app.studio.values },
                set: { app.studio.values = $0 }
            ))
        }
        .sheet(isPresented: $pickingSource) { ImagePickerSheet(addingReference: pickingExtra) }
        .sheet(item: $inspecting) { asset in AssetDetailView(asset: asset) }
        .onChange(of: photos) { _, items in
            guard let item = items.first else { return }
            Task { await upload(item); photos = [] }
        }
        // Selecting another tool reseeds the parameters, and loading a past
        // request rewrites them outright. Either way the prompt field holds its
        // own copy and has to be told.
        .onChange(of: store.values["prompt"]?.stringValue ?? "") { _, value in
            if value != prompt { prompt = value }
        }
    }

    // MARK: The result

    /// What came out, and nothing else. Empty is not a blank page: it is the
    /// last few results, because a visual starting point beats an empty prompt
    /// box — tapping one loads the request that made it.
    private var canvas: some View {
        ScrollView {
            VStack(spacing: Space.md) {
                if !store.jobs.isEmpty {
                    ForEach(store.jobs) { job in
                        ProgressTile(
                            ratio: requestedRatio,
                            progress: job.progress,
                            note: job.note ?? job.modelName
                        )
                        .onTapGesture { Task { try? await store.cancel(job.id) } }
                    }
                }

                if store.gallery.isEmpty && store.jobs.isEmpty {
                    emptyCanvas
                } else {
                    ForEach(store.gallery.prefix(8)) { asset in
                        Button { inspecting = asset } label: {
                            AspectBox(ratio: asset.aspectRatio ?? 1) {
                                if asset.kind == .video {
                                    VideoPoster(poster: asset.poster, width: 640, contentMode: .fill)
                                } else {
                                    AuthedImage(
                                        imageId: ImageId(asset.assetId),
                                        width: 640,
                                        contentMode: .fill,
                                        aspectRatio: asset.aspectRatio
                                    )
                                }
                            }
                            .overlay(
                                RoundedRectangle(cornerRadius: Radius.xl, style: .continuous)
                                    .strokeBorder(Color.hairline, lineWidth: 1)
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(.horizontal, Space.md)
            .padding(.top, Space.md)
            // Room for the control panel, which floats over this.
            .padding(.bottom, 260)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    @ViewBuilder
    private var emptyCanvas: some View {
        if store.isLoading {
            Spinner().padding(.top, 80)
        } else if !store.enabled {
            ContentUnavailableView(
                "创作台没开",
                systemImage: Symbols.studio,
                description: Text("在设置的「能力」里打开生成能力。")
            )
            .padding(.top, 60)
        } else if store.tools.isEmpty {
            ContentUnavailableView(
                "还没有生成后端",
                systemImage: Symbols.studio,
                description: Text("在网页端配一个生图或视频后端。")
            )
            .padding(.top, 60)
        } else {
            ContentUnavailableView(
                "写点什么，看看它画成什么样",
                systemImage: "sparkles",
                description: Text("生成好的图和视频会留在这里，也会进图库。")
            )
            .padding(.top, 60)
        }
    }

    // MARK: The controls

    private var controls: some View {
        VStack(spacing: Space.sm) {
            if store.tool != nil {
                paramChips
                composer
                actionRow
            }
        }
        .padding(.horizontal, Space.md)
        .padding(.bottom, Space.sm)
        .background(alignment: .bottom) {
            // The panel floats over the canvas, so the results scroll under it
            // rather than being squeezed into whatever is left.
            LinearGradient(
                colors: [Color.bg.opacity(0), Color.bg.opacity(0.92), Color.bg],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: 320)
            .allowsHitTesting(false)
        }
    }

    /// Every adjustable value, as its value.
    private var paramChips: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            HStack {
                Text("参数")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.mutedFg)
                Spacer()
                if adjustable.count > 2 {
                    Label("横向滑动", systemImage: "arrow.left.and.right")
                        .font(.caption2)
                        .foregroundStyle(Color.mutedFg)
                }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Space.xs) {
                    ForEach(adjustable, id: \.name) { parameter in
                        Button {
                            editing = parameter
                        } label: {
                            ParamChip(
                                label: parameter.label,
                                value: display(parameter),
                                isPlaceholder: store.values[parameter.name] == nil
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 2)
            }
            .frame(height: 34)
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            if !referenceIds.isEmpty || takesSource {
                referenceStrip
            }
            // Monospace on purpose: a prompt is an instruction, not prose, and
            // the difference is worth showing.
            TextField("描述你想要的画面", text: $prompt, axis: .vertical)
                .font(.body.monospaced())
                .lineLimit(1...5)
                .onChange(of: prompt) { _, value in
                    store.values["prompt"] = .string(value)
                }
                .accessibilityIdentifier("studio.prompt")
        }
        .padding(Space.md)
        .floatingGlass(in: .rect(cornerRadius: Radius.xl))
    }

    private var referenceStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Space.sm) {
                if !store.sourceId.isEmpty {
                    ReferenceTile(id: store.sourceId, badge: "源图") {
                        store.sourceId = ""
                    }
                }
                ForEach(referenceIds, id: \.self) { id in
                    ReferenceTile(id: id, badge: nil) {
                        store.additionalSourceIds.removeAll { $0 == id }
                    }
                }
                Menu {
                    Button("从文件库选") { pickingExtra = !store.sourceId.isEmpty; pickingSource = true }
                    Button("从相册上传") { pickingExtra = false }
                } label: {
                    RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
                        .fill(Color.secondaryFill)
                        .frame(width: 56, height: 56)
                        .overlay(Image(systemName: "plus").foregroundStyle(Color.mutedFg))
                }
                .accessibilityLabel("添加参考图")

                PhotosPicker(selection: $photos, maxSelectionCount: 1, matching: .images) {
                    RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
                        .fill(Color.secondaryFill)
                        .frame(width: 56, height: 56)
                        .overlay(Image(systemName: "photo").foregroundStyle(Color.mutedFg))
                }
                .accessibilityLabel("从相册选一张")
            }
            .padding(.horizontal, 2)
        }
        .frame(height: 60)
    }

    private var actionRow: some View {
        HStack(spacing: Space.sm) {
            if store.kindTools.count > 1 {
                Menu {
                    Picker("", selection: Binding(
                        get: { store.toolKey },
                        set: { store.selectTool($0) }
                    )) {
                        ForEach(store.kindTools) { tool in
                            Text(tool.serverTitle).tag(tool.id)
                        }
                    }
                } label: {
                    ParamChip(label: "模型", value: store.tool?.serverTitle ?? "")
                }
            } else if let tool = store.tool {
                ParamChip(label: "模型", value: tool.serverTitle)
            }

            if let tool = store.tool, let estimate = store.estimate(for: tool) {
                Text("约 \(Format.roughly(estimate))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: Space.sm)

            Button {
                Keyboard.dismiss()
                Task {
                    do { try await store.submit() }
                    catch let error as APIError { app.handle(error) }
                    catch {}
                }
            } label: {
                Group {
                    if store.isSubmitting {
                        ProgressView().tint(Color.onBrand)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 16, weight: .bold))
                    }
                }
                .foregroundStyle(Color.onBrand)
                .frame(width: 42, height: 42)
                .background(canSubmit ? AnyShapeStyle(LinearGradient.brandFill) : AnyShapeStyle(Color.mutedFill))
                .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(!canSubmit)
            .accessibilityLabel(store.tool?.kind.action ?? "开始生成")
            .accessibilityIdentifier("studio.submit")
        }
    }

    // MARK: Reading the schema

    private var canSubmit: Bool {
        !store.isSubmitting && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var takesSource: Bool {
        store.tool?.schema.properties["source_image_id"] != nil
    }

    private var referenceIds: [String] { store.additionalSourceIds }

    /// The requested shape, so a render in progress occupies the room its result
    /// will need. Read from whichever field the adapter uses to say so.
    private var requestedRatio: Double {
        if let text = store.values["aspect_ratio"]?.stringValue {
            let parts = text.split(separator: ":").compactMap { Double($0) }
            if parts.count == 2, parts[1] > 0 { return parts[0] / parts[1] }
        }
        if let width = store.values["width"]?.intValue,
           let height = store.values["height"]?.intValue,
           height > 0 {
            return Double(width) / Double(height)
        }
        return 1
    }

    /// Everything the selected adapter actually offers, in a stable order.
    ///
    /// Driven by the schema rather than a fixed list, which is what keeps a new
    /// backend from needing an app release — and it is why a parameter the model
    /// does not take is *absent* rather than shown disabled. A greyed-out
    /// guidance slider on a model that ignores guidance is a worse lie than no
    /// slider at all.
    private var adjustable: [EditedParameter] {
        guard let schema = store.tool?.schema else { return [] }
        let hidden: Set<String> = [
            "prompt", "source_image_id", "additional_source_image_ids",
            "placement_key", "intent",
        ]
        return schema.properties
            .filter { !hidden.contains($0.key) }
            .sorted { lhs, rhs in
                let order = ["aspect_ratio", "resolution", "width", "height", "steps", "cfg", "seed"]
                let a = order.firstIndex(of: lhs.key) ?? order.count
                let b = order.firstIndex(of: rhs.key) ?? order.count
                return a == b ? lhs.key < rhs.key : a < b
            }
            .map { EditedParameter(name: $0.key, label: schema.label(for: $0.key), schema: $0.value) }
    }

    private func display(_ parameter: EditedParameter) -> String {
        if let value = store.values[parameter.name]?.shortLabel, !value.isEmpty { return value }
        if parameter.name == "seed" { return "随机" }
        if let fallback = parameter.schema.defaultValue?.shortLabel, !fallback.isEmpty { return fallback }
        return "默认"
    }

    private func upload(_ item: PhotosPickerItem) async {
        guard let data = try? await item.loadTransferable(type: Data.self) else { return }
        do { try await store.uploadSource(data: data, filename: "source.jpg", mime: "image/jpeg") }
        catch let error as APIError { app.handle(error) }
        catch {}
    }
}

// MARK: - One parameter at a time

struct EditedParameter: Identifiable {
    let name: String
    let label: String
    let schema: JsonSchema

    var id: String { name }
}

/// A sheet for exactly one setting.
///
/// Short by construction — one control, its explanation, and nothing else — so
/// it opens at a height that leaves the result visible behind it. Changing one
/// number should not mean scrolling past nine others.
private struct ParameterSheet: View {
    let parameter: EditedParameter
    @Binding var values: [String: JSONValue]

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    control
                } footer: {
                    if let description = parameter.schema.description, !description.isEmpty {
                        Text(description)
                    }
                }

                if values[parameter.name] != nil {
                    Section {
                        Button("恢复默认", role: .destructive) {
                            values[parameter.name] = parameter.schema.defaultValue
                            dismiss()
                        }
                    }
                }
            }
            .formChrome(parameter.label)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }.fontWeight(.semibold)
                }
            }
        }
        .presentationDetents([.height(280), .medium])
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder
    private var control: some View {
        if !parameter.schema.enumValues.isEmpty {
            Picker(parameter.label, selection: choice) {
                ForEach(parameter.schema.enumValues, id: \.self) { value in
                    Text(value.shortLabel).tag(value)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } else if parameter.schema.type == "boolean" {
            Toggle(parameter.label, isOn: flag)
        } else if parameter.name == "seed" {
            // Empty means random. No `-1` sentinel reaches the reader: the field
            // is blank, the placeholder says so, and the dice re-roll it.
            HStack {
                TextField("随机", text: text)
                    .keyboardType(.numberPad)
                    .monospaced()
                Button {
                    values[parameter.name] = .number(Double(Int.random(in: 1...9_999_999)))
                } label: {
                    Image(systemName: "shuffle")
                }
                .buttonStyle(.borderless)
            }
        } else if parameter.schema.type == "integer" || parameter.schema.type == "number" {
            NumberControl(parameter: parameter, values: $values)
        } else {
            TextField(parameter.label, text: text, axis: .vertical)
                .lineLimit(1...6)
        }
    }

    private var choice: Binding<JSONValue> {
        Binding(
            get: { values[parameter.name] ?? parameter.schema.defaultValue ?? .null },
            set: { values[parameter.name] = $0 }
        )
    }

    private var flag: Binding<Bool> {
        Binding(
            get: { values[parameter.name]?.boolValue ?? parameter.schema.defaultValue?.boolValue ?? false },
            set: { values[parameter.name] = .bool($0) }
        )
    }

    private var text: Binding<String> {
        Binding(
            get: { values[parameter.name]?.shortLabel ?? "" },
            set: { values[parameter.name] = $0.isEmpty ? nil : .string($0) }
        )
    }
}

/// A number, as a slider when the schema bounds it and a field when it does not.
///
/// The text and the slider drive each other, which is a feedback loop with a
/// well-known failure: typing "6.5" goes 6 → value 6.0 → text "6.0" → "6.0.5".
/// The guard is to only rewrite the text when the value has moved by more than
/// half a step, which is the fix Mochi Diffusion documents at
/// `Views/SidebarControls/MochiSlider.swift`.
private struct NumberControl: View {
    let parameter: EditedParameter
    @Binding var values: [String: JSONValue]

    @State private var text = ""

    private var current: Double {
        values[parameter.name]?.doubleValue
            ?? parameter.schema.defaultValue?.doubleValue
            ?? parameter.schema.minimum
            ?? 0
    }

    private var isInteger: Bool { parameter.schema.type == "integer" }
    private var step: Double { isInteger ? 1 : 0.1 }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack {
                Text(parameter.label).foregroundStyle(.secondary)
                Spacer()
                TextField("", text: $text)
                    .keyboardType(.numbersAndPunctuation)
                    .multilineTextAlignment(.trailing)
                    .monospaced()
                    .frame(maxWidth: 110)
            }

            if let low = parameter.schema.minimum, let high = parameter.schema.maximum, high > low {
                Slider(
                    value: Binding(get: { current }, set: { set($0) }),
                    in: low...high,
                    step: step
                )
                HStack {
                    Text(format(low)).font(.caption2).foregroundStyle(.secondary)
                    Spacer()
                    Text(format(high)).font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .onAppear { text = format(current) }
        .onChange(of: text) { _, typed in
            guard let value = Double(typed) else { return }
            set(value)
        }
        .onChange(of: current) { _, value in
            guard let typed = Double(text) else { return }
            if abs(typed - value) > step / 2 { text = format(value) }
        }
    }

    private func set(_ value: Double) {
        let clamped = min(max(value, parameter.schema.minimum ?? value), parameter.schema.maximum ?? value)
        values[parameter.name] = .number(isInteger ? clamped.rounded() : clamped)
    }

    private func format(_ value: Double) -> String {
        isInteger ? String(Int(value.rounded())) : String(format: "%g", value)
    }
}

// MARK: - Pieces

private struct ReferenceTile: View {
    let id: String
    let badge: String?
    var onRemove: () -> Void

    var body: some View {
        AuthedImage(imageId: ImageId(id), width: 160, contentMode: .fill)
            .frame(width: 56, height: 56)
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
            .overlay(alignment: .bottomLeading) {
                if let badge {
                    Text(badge)
                        .font(.system(size: 9, weight: .semibold))
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(.ultraThinMaterial, in: Capsule())
                        .padding(3)
                }
            }
            .overlay(alignment: .topTrailing) {
                Button(action: onRemove) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.white, .black.opacity(0.55))
                }
                .buttonStyle(.plain)
                .padding(2)
                .accessibilityLabel("移除这张参考图")
            }
    }
}

/// Picking an existing picture, for either slot.
private struct ImagePickerSheet: View {
    let addingReference: Bool

    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List(app.library.items.filter(\.isImage)) { file in
                Button {
                    if addingReference {
                        if !app.studio.additionalSourceIds.contains(file.id.raw) {
                            app.studio.additionalSourceIds.append(file.id.raw)
                        }
                    } else {
                        app.studio.sourceId = file.id.raw
                    }
                    dismiss()
                } label: {
                    HStack(spacing: Space.md) {
                        AuthedImage(imageId: ImageId(file.id.raw), width: 160, contentMode: .fill)
                            .frame(width: 44, height: 44)
                            .clipped()
                            .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
                        Text(file.name).lineLimit(1).truncationMode(.middle)
                    }
                }
                .buttonStyle(.plain)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Color.bg)
            .navigationTitle(addingReference ? "加一张参考图" : "选一张源图")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
            }
            .overlay {
                if app.library.items.filter(\.isImage).isEmpty {
                    ContentUnavailableView(
                        "文件库里还没有图",
                        systemImage: "photo",
                        description: Text("先上传一张，或者从相册选。")
                    )
                }
            }
            .task { await app.library.load() }
        }
    }
}
