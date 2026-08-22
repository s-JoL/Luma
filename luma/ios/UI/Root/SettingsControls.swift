import SwiftUI

/// The handful of controls every 设置 screen builds rows out of. They live here
/// rather than in `Components.swift` because none of them means anything outside
/// an administration form.

struct SectionHeader: View {
    let title: String
    let symbol: String

    var body: some View {
        Label(title, systemImage: symbol)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(Color.mutedFg)
            .textCase(nil)
    }
}

/// A button that writes. It shows that it is writing and refuses while it is,
/// because every one of these is a round trip to a server that may be at the far
/// end of a tunnel, and a control that neither moves nor refuses is a control
/// that gets pressed again — which for 添加 means two models with two ids.
struct WriteButton: View {
    let title: String
    var role: ButtonRole?
    var isWriting: Bool
    var isEnabled = true
    var action: () -> Void

    var body: some View {
        Button(role: role, action: action) {
            HStack(spacing: Space.sm) {
                Text(title)
                if isWriting { Spinner() }
            }
        }
        .disabled(isWriting || !isEnabled)
    }
}

/// A key the server will store and never hand back, with the two things that
/// can be done to it. 清除 is offered only once there is something to clear, so
/// the row does not invite an action that would be a no-op.
struct SecretRow: View {
    let title: String
    let placeholder: String
    let hasValue: Bool
    var isWriting: Bool
    @Binding var draft: String
    var save: () -> Void
    var clear: () -> Void

    var body: some View {
        SecureField(placeholder, text: $draft)
            .textContentType(.password)
        HStack {
            WriteButton(
                title: "保存\(title)",
                isWriting: isWriting,
                isEnabled: !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                action: save
            )
            if hasValue {
                Spacer()
                WriteButton(title: "清除", role: .destructive, isWriting: isWriting, action: clear)
            }
        }
        .font(.footnote)
    }
}

/// One chat model as an administrator reads it: what it is called, what it runs
/// on, and every reason it might not answer. 缺少密钥 belongs on this row rather
/// than on the provider's, because this is the list someone is looking at when
/// they wonder why a model is missing from the switcher.
struct ModelRow: View {
    let model: ModelSpec
    let provider: Provider?
    let isDefault: Bool
    let apiModeLabel: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: Space.xs) {
                Text(model.name).lineLimit(1)
                if isDefault { Badge(text: "默认", tone: .brand) }
                if model.pinned { Badge(text: "已固定") }
                if !model.enabled { Badge(text: "已停用", tone: .warn) }
                if needsKey { Badge(text: "缺少密钥", tone: .warn) }
            }
            Text(subtitle)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }

    private var subtitle: String {
        var parts = [provider?.name ?? model.providerId.raw, model.model, apiModeLabel]
        if model.contextWindow > 0 { parts.append("\(model.contextWindow / 1000)k 上下文") }
        if model.reasoning { parts.append("思考 \(model.thinkingLevel)") }
        return parts.joined(separator: " · ")
    }

    /// A ComfyUI on this machine is reached over plain HTTP with no credential,
    /// so demanding one would mark a working local model as broken.
    private var needsKey: Bool {
        guard let provider else { return false }
        if provider.isKeyless { return false }
        if model.apiMode == "comfy-workflow" { return false }
        return !provider.hasKey
    }
}

extension View {
    /// Ids, URLs, header names and remote model names are typed exactly or not
    /// at all. iOS capitalises the first letter of a text field and corrects
    /// what it does not recognise, which turns `x-api-key` into a header the
    /// gateway never reads and `gpt-4o` into something no provider has.
    func exactEntry() -> some View {
        textInputAutocapitalization(.never).autocorrectionDisabled()
    }
}
