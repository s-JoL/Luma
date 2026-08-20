import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

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
        ScrollView {
            VStack(alignment: .leading, spacing: Space.lg) {
                searchCard
                filters
                if store.items.isEmpty, !store.isLoading {
                    ContentUnavailableView("还没有文件", systemImage: Symbols.library, description: Text("上传、新建笔记，或从对话里生成"))
                        .frame(maxWidth: .infinity)
                        .padding(.top, Space.xxl)
                } else {
                    fileList
                }
            }
            .padding(Space.lg)
        }
        .background(Color.bg)
        .navigationTitle("文件")
        .navigationBarTitleDisplayMode(.inline)
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
        .fullScreenCover(item: $zoom) { item in
            ImageViewer(imageId: item.imageId)
        }
        .fullScreenCover(item: $playing) { item in
            VideoViewer(videoId: item.videoId)
        }
        .alert("删除文件", isPresented: .constant(deleting != nil), presenting: deleting) { file in
            Button("取消", role: .cancel) { deleting = nil }
            Button("删除", role: .destructive) {
                Task { await remove(file) }
                deleting = nil
            }
        } message: { file in
            Text("「\(file.name)」会从图书馆里去掉。")
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { Task { await upload(urls: urls) } }
        }
        .onChange(of: photos) { _, items in
            guard !items.isEmpty else { return }
            Task { await upload(photos: items); photos = [] }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            if busy { Spinner() }
            Button {
                note = NoteDraft(fileId: nil, name: "未命名.md", text: "")
            } label: {
                Label("新建", systemImage: "square.and.pencil")
            }
            PhotosPicker(selection: $photos, maxSelectionCount: 8, matching: .any(of: [.images, .videos])) {
                Label("相册", systemImage: "photo.on.rectangle")
            }
            Button { importing = true } label: {
                Label("上传", systemImage: "square.and.arrow.up")
            }
        }
    }

    private var searchCard: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text("在文件里搜")
                .font(.footnote.weight(.medium))
                .foregroundStyle(.secondary)
            HStack {
                TextField("关键词或一句话", text: $query)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await search() } }
                Button("搜索") { Task { await search() } }
                    .disabled(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if store.isSearching { Spinner() }
            if let hits = store.hits {
                if hits.isEmpty {
                    Text("没有命中任何片段。").font(.subheadline).foregroundStyle(.secondary)
                } else {
                    ForEach(hits) { hit in
                        VStack(alignment: .leading, spacing: Space.xs) {
                            HStack {
                                Badge(text: hit.matchType, tone: .neutral)
                                Text(hit.name).font(.subheadline.weight(.medium))
                                Spacer()
                                Text("片段 \(hit.chunk)").font(.caption).foregroundStyle(.secondary)
                            }
                            Text(hit.excerpt.prefix(280))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(Space.md)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.mutedFill, in: RoundedRectangle(cornerRadius: Radius.md))
                    }
                }
            }
        }
        .padding(Space.lg)
        .background(Color.card, in: RoundedRectangle(cornerRadius: Radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(Color.hairline, lineWidth: 1))
    }

    private var filters: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack {
                Text("文件（\(store.total)）").font(.headline)
                Spacer()
                TextField("按文件名筛选", text: Binding(
                    get: { app.library.needle },
                    set: { app.library.needle = $0 }
                ))
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 180)
                    .onSubmit { Task { await store.load() } }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Space.sm) {
                    kindChip("all", "全部", store.facets.kindCount.all)
                    kindChip("docs", "文档", store.facets.kindCount.docs)
                    kindChip("images", "图片", store.facets.kindCount.images)
                    kindChip("videos", "视频", store.facets.kindCount.videos)
                }
            }
            if !store.facets.sources.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Space.sm) {
                        sourceChip("all", "全部来源")
                        ForEach(store.facets.sources) { row in
                            sourceChip(row.id, FileSourceLabel.name(row.id), row.count)
                        }
                    }
                }
            }
        }
    }

    private var fileList: some View {
        LazyVStack(spacing: Space.sm) {
            ForEach(store.items) { file in
                FileRow(file: file) {
                    if file.isImage { zoom = ZoomedImage(file.id.raw) }
                    else if file.isVideo { playing = PlayingVideo(file.id.raw) }
                    else if file.isText { Task { await openNote(file) } }
                } onDelete: {
                    deleting = file
                } onReindex: {
                    Task { try? await store.reindex(file.id) }
                }
            }
        }
    }

    private func kindChip(_ id: String, _ label: String, _ count: Int) -> some View {
        Button { store.kind = id } label: {
            Chip(label: label, count: count, isSelected: store.kind == id)
        }
        .buttonStyle(.plain)
    }

    private func sourceChip(_ id: String, _ label: String, _ count: Int? = nil) -> some View {
        Button { store.source = id } label: {
            Chip(label: label, count: count, isSelected: store.source == id)
        }
        .buttonStyle(.plain)
    }

    private func search() async {
        do { try await store.search(query) }
        catch let error as APIError { app.handle(error) }
        catch {}
    }

    private func openNote(_ file: FileRecord) async {
        do {
            let body = try await store.fileText(file.id)
            note = NoteDraft(fileId: file.id, name: body.name, text: body.text)
        } catch let error as APIError { app.handle(error) }
        catch {}
    }

    private func save(draft: NoteDraft, name: String, text: String) async {
        do {
            if let id = draft.fileId {
                try await store.saveNote(id, name: name, text: text)
            } else {
                try await store.createNote(name: name, text: text)
            }
            note = nil
            app.note("已保存")
        } catch let error as APIError { app.handle(error) }
        catch {}
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
            let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
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
            let filename = "photo.jpg"
            let mime = "image/jpeg"
            do { try await store.upload(data: data, filename: filename, mime: mime) }
            catch let error as APIError { app.handle(error) }
            catch {}
        }
    }
}

private struct FileRow: View {
    let file: FileRecord
    var onOpen: () -> Void
    var onDelete: () -> Void
    var onReindex: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: Space.md) {
                thumb
                VStack(alignment: .leading, spacing: 3) {
                    Text(file.name).font(.body.weight(.medium)).lineLimit(1)
                    Text("\(Format.bytes(file.bytes)) · \(FileSourceLabel.name(file.source))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Badge(text: file.embeddingStatus.label, tone: badgeTone)
            }
            .padding(Space.md)
            .background(Color.card, in: RoundedRectangle(cornerRadius: Radius.lg))
            .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(Color.hairline, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .contextMenu {
            if file.isText { Button("编辑", action: onOpen) }
            if file.embeddingStatus == .failed || file.embeddingStatus == .none {
                Button("重新索引", action: onReindex)
            }
            Button("删除", role: .destructive, action: onDelete)
        }
    }

    @ViewBuilder
    private var thumb: some View {
        if file.isImage {
            AuthedImage(imageId: ImageId(file.id.raw), width: 80)
                .frame(width: 48, height: 48)
                .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
        } else {
            Image(systemName: file.isVideo ? "film" : "doc.text")
                .foregroundStyle(Color.mutedFg)
                .frame(width: 48, height: 48)
                .background(Color.mutedFill, in: RoundedRectangle(cornerRadius: Radius.sm))
        }
    }

    private var badgeTone: Badge.Tone {
        switch file.embeddingStatus {
        case .ready, .indexed: .ok
        case .pending: .warn
        case .failed: .danger
        case .none: .neutral
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
            VStack(spacing: Space.md) {
                TextField("文件名", text: $name)
                    .textFieldStyle(.roundedBorder)
                TextEditor(text: $text)
                    .font(.body)
                    .scrollContentBackground(.hidden)
                    .padding(Space.sm)
                    .background(Color.card, in: RoundedRectangle(cornerRadius: Radius.md))
            }
            .padding(Space.lg)
            .background(Color.bg)
            .navigationTitle(draft.fileId == nil ? "新建文档" : "编辑")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { onSave(name, text) }
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}
