import SwiftUI

/// What the agent is told about you before every conversation.
///
/// One entry per section, which is what makes the screen legible: the key is the
/// header, the budget is the footer, and the editor is the row. The previous
/// version drew a bordered card per entry with two text-only buttons at the
/// bottom — 保存 and 删除 side by side, greyed and red, reading as labels rather
/// than as controls — and the cards ran under the tab bar because nothing inset
/// them.
struct MemoryView: View {
    @Environment(AppModel.self) private var app
    @State private var naming = false
    @State private var newKey = ""
    @State private var saving: String?

    private var store: MemoryStore { app.memory }

    var body: some View {
        FormScreen(title: "记忆") {
            if let snapshot = store.snapshot {
                budgetSection(snapshot)
                ForEach(store.keys, id: \.self) { key in
                    entrySection(key, snapshot: snapshot)
                }
            } else {
                Section { HStack { Spacer(); Spinner(); Spacer() } }
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { naming = true } label: {
                    Label("新建条目", systemImage: "plus")
                }
            }
        }
        .task {
            do { try await store.load() }
            catch let error as APIError { app.handle(error) }
            catch {}
        }
        .refreshable {
            try? await store.load()
        }
        .alert("新建记忆条目", isPresented: $naming) {
            TextField("例如 coffee_order", text: $newKey)
                .exactEntry()
            Button("取消", role: .cancel) { newKey = "" }
            Button("创建") {
                store.addKey(newKey)
                newKey = ""
            }
            .disabled(keyError != nil)
        } message: {
            Text(keyError ?? "字母、数字、下划线或连字符，最多 64 个字符")
        }
    }

    // MARK: Sections

    private func budgetSection(_ snapshot: MemorySnapshot) -> some View {
        let usage = snapshot.limit == 0 ? 0 : min(1, Double(snapshot.tokens) / Double(snapshot.limit))
        return Section {
            VStack(alignment: .leading, spacing: Space.sm) {
                HStack {
                    Text("\(snapshot.tokens) / \(snapshot.limit) tokens")
                        .font(.subheadline.monospacedDigit())
                    Spacer()
                    if usage > 0.9 {
                        Badge(text: "快满了", tone: .warn)
                    }
                }
                ProgressView(value: usage)
                    .tint(usage > 0.9 ? Color.warn : Color.brand)
            }
            .padding(.vertical, 2)
        } footer: {
            Text("每次对话都会带上这些条目。空的是建议槽位，模型也可以自己起名。单条最多 \(snapshot.charLimit) 字。")
        }
    }

    private func entrySection(_ key: String, snapshot: MemorySnapshot) -> some View {
        let item = snapshot.items.first { $0.key == key }
        let stored = item?.value ?? ""
        let value = store.drafts[key] ?? stored
        let dirty = value != stored
        let tooLong = value.count > snapshot.charLimit

        return Section {
            TextField("这一条记什么", text: Binding(
                get: { store.drafts[key] ?? stored },
                set: { store.drafts[key] = $0 }
            ), axis: .vertical)
            .lineLimit(3...12)

            // Only offered once there is something to do. A permanently visible
            // 保存 that is grey nine times out of ten teaches people to ignore it.
            if dirty {
                Button {
                    Task { await save(key) }
                } label: {
                    HStack {
                        Text("保存")
                        if saving == key { Spacer(); Spinner() }
                    }
                }
                .disabled(saving != nil || tooLong || value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if item != nil {
                Button("删除", role: .destructive) {
                    Task {
                        do { try await store.delete(key: key) }
                        catch let error as APIError { app.handle(error) }
                        catch {}
                    }
                }
            }
        } header: {
            HStack(spacing: Space.xs) {
                Text(key).font(.footnote.monospaced())
                if item == nil { Badge(text: "空") }
                Spacer()
                if let item {
                    Text("\(item.tokens) tokens · \(DayLabel.time(item.updatedAt))")
                        .font(.caption2)
                }
            }
            .textCase(nil)
        } footer: {
            if tooLong {
                Text("超出 \(value.count - snapshot.charLimit) 字，保存会被拒绝。")
                    .foregroundStyle(Color.danger)
            } else if dirty {
                Text("\(value.count) / \(snapshot.charLimit) · 还没保存")
            }
        }
    }

    // MARK: Actions

    private func save(_ key: String) async {
        saving = key
        defer { saving = nil }
        do {
            try await store.save(key: key)
            Haptics.success()
        } catch let error as APIError {
            app.handle(error)
        } catch {}
    }

    private var keyError: String? {
        let name = newKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { return nil }
        if !MemoryKey.isValid(name) { return "只能使用字母、数字、下划线和连字符" }
        if store.keys.contains(name) { return "这个键名已经存在" }
        return nil
    }
}
