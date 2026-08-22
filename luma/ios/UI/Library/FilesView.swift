import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Everything the agent can read: uploads, notes, and whatever the tools made.
///
/// Rewritten as a plain list with the platform's own search field. The previous
/// version put search in a bordered card at the top of a scroll view, with a
/// second text field for filtering by name inside a row that also held a heading,
/// and two rows of chips under that — four controls competing before a single
/// file was visible. Search belongs in the navigation bar, the filters belong in
/// a menu, and the screen belongs to the files.
struct FilesView: View {
    @Environment(AppModel.self) private var app

    @State private var query = ""
    @State private var note: NoteDraft?
    @State private var deleting: FileRecord?
    @State private var photos: [PhotosPickerItem] = []
    @State private var importing = false
    @State private var zoom: ZoomedImage?
    @State private var playing: PlayingVideo?
    @State private var busy = false

    private var store: LibraryStore { app.library }

    var body: some View {
        BrowseScreen(title: "文件") {
            if let hits = store.hits {
                searchResults(hits)
            } else if store.items.isEmpty {
                if store.isLoading {
                    Section { HStack { Spacer(); Spinner(); Spacer() } }
                } else {
                    EmptyRow(
                        title: filtered ? "没有符合条件的文件" : "还没有文件",
                        systemImage: Symbols.library,
                        help: filtered ? "换个筛选条件看看。" : "上传一个、写一条笔记，或者让对话里的工具生成。"
                    )
                }
            } else {
                fileRows
            }
        }
        // Server-side search, so it runs on submit rather than per keystroke —
        // and clearing the field goes back to the browse list rather than
        // searching for nothing.
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "搜文件内容")
        .onSubmit(of: .search) { Task { await search() } }
        .onChange(of: query) { _, value in
            if value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { store.clearSearch() }
        }
        .toolbar { toolbar }
        .task { await store.load() }
        .refreshable { await store.load() }
        .task(id: store.hasPending) {
            guard store.hasPending else { return }
            while !Task.isCancelled, store.hasPending {
                try? await Task.sleep(for: .seconds(2))
                await store.load()
            }
        }
        .onChange(of: store.kind) { _, _ in Task { await store.load() } }
        .onChange(of: store.source) { _, _ in Task { await store.load() } }
        .sheet(item: $note) { draft in
            NoteEditor(draft: draft) { name, text in
                Task { await save(draft: draft, name: name, text: text) }
            }
        }
        .fullScreenCover(item: $zoom) { item in ImageViewer(imageId: item.imageId) }
        .fullScreenCover(item: $playing) { item in VideoViewer(videoId: item.videoId) }
        .alert("删除文件", isPresented: .constant(deleting != nil), presenting: deleting) { file in
            Button("取消", role: .cancel) { deleting = nil }
            Button("删除", role: .destructive) {
                Task { await remove(file) }
                deleting = nil
            }
        } message: { file in
            Text("「\(file.name)」会从文件库里去掉，索引也一并删除。")
        }
        .fileImporter(
            isPresented: $importing,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            if case .success(let urls) = result { Task { await upload(urls: urls) } }
        }
        .onChange(of: photos) { _, items in
            guard !items.isEmpty else { return }
            Task { await upload(photos: items); photos = [] }
        }
    }

    // MARK: Rows

    @ViewBuilder
    private var fileRows: some View {
        Section {
            ForEach(store.items) { file in
                FileRow(file: file)
                    .contentShape(Rectangle())
                    .onTapGesture { open(file) }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) { deleting = file } label: {
                            Label("删除", systemImage: "trash")
                        }
                    }
                    .contextMenu {
                        if file.isText {
                            Button { open(file) } label: { Label("编辑", systemImage: "pencil") }
                        }
                        if file.embeddingStatus == .failed || file.embeddingStatus == .none {
                            Button {
                                Task { try? await store.reindex(file.id) }
                            } label: {
                                Label("重新索引", systemImage: "arrow.clockwise")
                            }
                        }
                        Button(role: .destructive) { deleting = file } label: {
                            Label("删除", systemImage: "trash")
                        }
                    }
            }
        } header: {
            Text(headerLabel).textCase(nil)
        }
    }

    @ViewBuilder
    private func searchResults(_ hits: [FileHit]) -> some View {
        if hits.isEmpty {
            EmptyRow(
                title: "没有命中",
                systemImage: "magnifyingglass",
                help: "换个说法试试，语义检索对整句比对关键词更擅长。"
            )
        } else {
            Section {
                ForEach(hits) { hit in
                    VStack(alignment: .leading, spacing: Space.xs) {
                        HStack(spacing: Space.xs) {
                            Text(hit.name)
                                .font(.subheadline.weight(.medium))
                                .lineLimit(1)
                            Badge(text: hit.matchType)
                            Spacer()
                            Text("片段 \(hit.chunk)")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Text(hit.excerpt.prefix(280))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 2)
                }
            } header: {
                Text("命中 \(hits.count) 个片段").textCase(nil)
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            if busy { Spinner() }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Picker("类型", selection: Binding(get: { store.kind }, set: { store.kind = $0 })) {
                    Text("全部（\(store.facets.kindCount.all)）").tag("all")
                    Text("文档（\(store.facets.kindCount.docs)）").tag("docs")
                    Text("图片（\(store.facets.kindCount.images)）").tag("images")
                    Text("视频（\(store.facets.kindCount.videos)）").tag("videos")
                }
                if !store.facets.sources.isEmpty {
                    Picker("来源", selection: Binding(get: { store.source }, set: { store.source = $0 })) {
                        Text("全部来源").tag("all")
                        ForEach(store.facets.sources) { row in
                            Text("\(FileSourceLabel.name(row.id))（\(row.count)）").tag(row.id)
                        }
                    }
                }
            } label: {
                Label("筛选", systemImage: filtered ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
            }
            .accessibilityIdentifier("files.filter")
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button {
                    note = NoteDraft(fileId: nil, name: "未命名.md", text: "")
                } label: {
                    Label("写一条笔记", systemImage: "square.and.pencil")
                }
                Button { importing = true } label: {
                    Label("从文件上传", systemImage: "folder")
                }
            } label: {
                Label("添加", systemImage: "plus")
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            PhotosPicker(selection: $photos, maxSelectionCount: 8, matching: .any(of: [.images, .videos])) {
                Label("从相册", systemImage: "photo.on.rectangle")
            }
        }
    }

    // MARK: State

    private var filtered: Bool { store.kind != "all" || store.source != "all" }

    private var headerLabel: String {
        filtered ? "\(store.items.count) / \(store.total) 个文件" : "\(store.total) 个文件"
    }

    // MARK: Actions

    private func open(_ file: FileRecord) {
        if file.isImage {
            zoom = ZoomedImage(file.id.raw)
        } else if file.isVideo {
            playing = PlayingVideo(file.id.raw, poster: nil)
        } else if file.isText {
            Task { await openNote(file) }
        }
    }

    private func search() async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        do { try await store.search(trimmed) }
        catch let error as APIError { app.handle(error) }
        catch {}
    }

    private func openNote(_ file: FileRecord) async {
        do {
            let body = try await store.fileText(file.id)
            note = NoteDraft(fileId: file.id, name: body.name, text: body.text)
        } catch let error as APIError {
            app.handle(error)
        } catch {}
    }

    private func save(draft: NoteDraft, name: String, text: String) async {
        do {
            if let id = draft.fileId {
                try await store.saveNote(id, name: name, text: text)
            } else {
                try await store.createNote(name: name, text: text)
            }
            note = nil
            Haptics.success()
        } catch let error as APIError {
            app.handle(error)
        } catch {}
    }

    private func remove(_ file: FileRecord) async {
        do { try await store.delete(file.id) }
        catch let error as APIError { app.handle(error) }
        catch {}
    }

    private func upload(urls: [URL]) async {
        busy = true
        defer { busy = false }
        for url in urls {
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { continue }
            let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
                ?? "application/octet-stream"
            do { try await store.upload(data: data, filename: url.lastPathComponent, mime: mime) }
            catch let error as APIError { app.handle(error) }
            catch {}
        }
    }

    private func upload(photos: [PhotosPickerItem]) async {
        busy = true
        defer { busy = false }
        for item in photos {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            do { try await store.upload(data: data, filename: "photo.jpg", mime: "image/jpeg") }
            catch let error as APIError { app.handle(error) }
            catch {}
        }
    }
}

// MARK: - Rows

private struct FileRow: View {
    let file: FileRecord

    var body: some View {
        HStack(spacing: Space.md) {
            thumbnail
            VStack(alignment: .leading, spacing: 2) {
                Text(file.name)
                    .font(.body)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: Space.sm)
            // Only when it is worth saying. "已索引" on every row is decoration;
            // "索引中" and "失败" are the two the reader can act on.
            if let tone = noteworthy {
                Badge(text: file.embeddingStatus.label, tone: tone)
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var thumbnail: some View {
        if file.isImage {
            AuthedImage(imageId: ImageId(file.id.raw), width: 160, contentMode: .fill)
                .frame(width: 44, height: 44)
                .clipped()
                .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
        } else {
            RoundedRectangle(cornerRadius: Radius.sm)
                .fill(Color.mutedFill)
                .frame(width: 44, height: 44)
                .overlay(
                    Image(systemName: file.isVideo ? "film" : Symbols.document)
                        .foregroundStyle(Color.mutedFg)
                )
        }
    }

    private var subtitle: String {
        var parts = [Format.bytes(file.bytes), FileSourceLabel.name(file.source)]
        if let pages = file.pageCount, pages > 0 { parts.append("\(pages) 页") }
        return parts.joined(separator: " · ")
    }

    private var noteworthy: Badge.Tone? {
        switch file.embeddingStatus {
        case .pending: .warn
        case .failed: .danger
        case .ready, .indexed, .none: nil
        }
    }
}

struct NoteDraft: Identifiable {
    let id = UUID()
    var fileId: FileId?
    var name: String
    var text: String
}

private struct NoteEditor: View {
    let draft: NoteDraft
    var onSave: (String, String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var text: String

    init(draft: NoteDraft, onSave: @escaping (String, String) -> Void) {
        self.draft = draft
        self.onSave = onSave
        _name = State(initialValue: draft.name)
        _text = State(initialValue: draft.text)
    }

    var body: some View {
        NavigationStack {
            // Not a form: this is a document, and a document editor should be
            // the page rather than a field on it.
            VStack(spacing: 0) {
                TextField("文件名", text: $name)
                    .exactEntry()
                    .font(.headline)
                    .padding(.horizontal, Space.lg)
                    .padding(.vertical, Space.md)
                Divider()
                TextEditor(text: $text)
                    .font(.body)
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, Space.md)
            }
            .background(Color.bg)
            .navigationTitle(draft.fileId == nil ? "新建笔记" : "编辑")
            .navigationBarTitleDisplayMode(.inline)
            .dismissableKeyboard()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { onSave(name, text) }
                        .fontWeight(.semibold)
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}
