import SwiftUI

struct MemoryView: View {
    @Environment(AppModel.self) private var app
    @State private var naming = false
    @State private var newKey = ""

    private var store: MemoryStore { app.memory }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.lg) {
                if let snapshot = store.snapshot {
                    budget(snapshot)
                    ForEach(store.keys, id: \.self) { key in
                        entry(key, snapshot: snapshot)
                    }
                } else {
                    HStack { Spacer(); Spinner(); Spacer() }
                        .padding(.top, Space.xxl)
                }
            }
            .padding(Space.lg)
        }
        .background(Color.bg)
        .navigationTitle("记忆")
        .navigationBarTitleDisplayMode(.inline)
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
        .alert("新建记忆条目", isPresented: $naming) {
            TextField("例如 coffee_order", text: $newKey)
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

    private var keyError: String? {
        let name = newKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { return nil }
        if !MemoryKey.isValid(name) { return "只能使用字母、数字、下划线和连字符" }
        if store.keys.contains(name) { return "这个键名已经存在" }
        return nil
    }

    private func budget(_ snapshot: MemorySnapshot) -> some View {
        let usage = snapshot.limit == 0 ? 0 : min(1, Double(snapshot.tokens) / Double(snapshot.limit))
        return VStack(alignment: .leading, spacing: Space.sm) {
            HStack {
                Text("\(snapshot.tokens) / \(snapshot.limit) tokens")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
            }
            GeometryReader { geo in
                Capsule().fill(Color.mutedFill)
                    .overlay(alignment: .leading) {
                        Capsule()
                            .fill(usage > 0.9 ? Color.warn : Color.brand)
                            .frame(width: geo.size.width * usage)
                    }
            }
            .frame(height: 6)
            Text("对话会带上这些条目。空槽是建议，模型也可以自己起名。单条最多 \(snapshot.charLimit) 字。")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func entry(_ key: String, snapshot: MemorySnapshot) -> some View {
        let item = snapshot.items.first { $0.key == key }
        let value = store.drafts[key] ?? item?.value ?? ""
        let dirty = value != (item?.value ?? "")
        return VStack(alignment: .leading, spacing: Space.sm) {
            HStack {
                Text(key).font(.system(.caption, design: .monospaced))
                Spacer()
                if let item {
                    Text("\(item.tokens) tokens · \(DayLabel.time(item.updatedAt))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Badge(text: "空", tone: .neutral)
                }
            }
            TextEditor(text: Binding(
                get: { store.drafts[key] ?? item?.value ?? "" },
                set: { store.drafts[key] = $0 }
            ))
            .font(.body)
            .frame(minHeight: 88)
            .scrollContentBackground(.hidden)
            .padding(Space.sm)
            .background(Color.mutedFill, in: RoundedRectangle(cornerRadius: Radius.md))
            HStack {
                Button("保存") {
                    Task {
                        do { try await store.save(key: key); app.note("已保存") }
                        catch let error as APIError { app.handle(error) }
                        catch {}
                    }
                }
                .disabled(!dirty || value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button("删除", role: .destructive) {
                    Task {
                        do { try await store.delete(key: key) }
                        catch let error as APIError { app.handle(error) }
                        catch {}
                    }
                }
                .disabled(item == nil)
                Spacer()
                Text("\(value.count) / \(snapshot.charLimit)")
                    .font(.caption)
                    .foregroundStyle(value.count > snapshot.charLimit ? Color.danger : Color.mutedFg)
            }
        }
        .padding(Space.lg)
        .background(Color.card, in: RoundedRectangle(cornerRadius: Radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(Color.hairline, lineWidth: 1))
    }
}
