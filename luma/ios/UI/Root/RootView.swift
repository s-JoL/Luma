import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var app = app

        Group {
            switch app.session {
            case .needsServer, .signedOut:
                SignInView()
            case .signedIn:
                SignedInView()
            }
        }
        .background(Color.bg)
        .toastHost($app.toast)
    }
}

/// Five destinations, matching the web. On a phone they are a tab bar; on iPad
/// they become a rail plus the current screen, with chat keeping its split.
struct SignedInView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.scenePhase) private var scenePhase
    @State private var didLoad = false

    var body: some View {
        Group {
            if sizeClass == .compact {
                CompactRoot()
            } else {
                RegularRoot()
            }
        }
        .task {
            guard !didLoad else { return }
            didLoad = true
            await app.load()
            await app.takeParkedQuestion()
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, didLoad else { return }
            Task {
                await app.conversations.refresh()
                await app.approvals.refresh()
                // A question can arrive from Siri while the app is already
                // running, in which case there is no cold start to pick it up.
                await app.takeParkedQuestion()
            }
        }
    }
}

private struct CompactRoot: View {
    @Environment(AppModel.self) private var app
    @State private var destination = Destination.chat

    var body: some View {
        TabView(selection: $destination) {
            NavigationStack { ConversationListView() }
                .tabItem { Label(Destination.chat.title, systemImage: Destination.chat.symbol) }
                .tag(Destination.chat)
                .badge(app.approvals.count)

            NavigationStack { StudioView() }
                .tabItem { Label(Destination.studio.title, systemImage: Destination.studio.symbol) }
                .tag(Destination.studio)

            NavigationStack { FilesView() }
                .tabItem { Label(Destination.files.title, systemImage: Destination.files.symbol) }
                .tag(Destination.files)

            NavigationStack { MemoryView() }
                .tabItem { Label(Destination.memory.title, systemImage: Destination.memory.symbol) }
                .tag(Destination.memory)

            NavigationStack { SettingsView() }
                .tabItem { Label(Destination.settings.title, systemImage: Destination.settings.symbol) }
                .tag(Destination.settings)
        }
        // A question asked through Siri lands in a conversation the app has just
        // created and already sent to, and that conversation is on the chat tab
        // whichever tab was last open. `ConversationListView` does the pushing;
        // this only makes sure it is on screen to do it.
        .onChange(of: app.opening) { _, id in
            guard id != nil else { return }
            destination = .chat
        }
    }
}

private struct RegularRoot: View {
    @State private var destination = Destination.chat
    @State private var conversation: ConversationId?

    var body: some View {
        HStack(spacing: 0) {
            DestinationRail(selection: $destination)
            Divider().background(Color.sidebarLine)
            Group {
                switch destination {
                case .chat:
                    NavigationSplitView {
                        ConversationListView(selection: $conversation)
                            .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 360)
                    } detail: {
                        if let conversation {
                            TranscriptView(id: conversation)
                                .id(conversation)
                        } else {
                            ContentUnavailableView(
                                "选一个对话",
                                systemImage: Symbols.chat,
                                description: Text("或者新建一个")
                            )
                        }
                    }
                case .studio:
                    NavigationStack { StudioView() }
                case .files:
                    NavigationStack { FilesView() }
                case .memory:
                    NavigationStack { MemoryView() }
                case .settings:
                    NavigationStack { SettingsView() }
                }
            }
        }
        .background(Color.bg)
    }
}

private struct DestinationRail: View {
    @Binding var selection: Destination

    var body: some View {
        VStack(spacing: Space.sm) {
            ForEach(Destination.allCases) { item in
                Button {
                    selection = item
                } label: {
                    VStack(spacing: 4) {
                        Image(systemName: item.symbol)
                            .font(.system(size: 20, weight: .medium))
                        Text(item.title)
                            .font(.caption2.weight(.medium))
                    }
                    .foregroundStyle(selection == item ? Color.brand : Color.mutedFg)
                    .frame(width: 72, height: 58)
                    .background(selection == item ? Color.accentFill : Color.clear, in: RoundedRectangle(cornerRadius: Radius.md))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(item.title)
                .accessibilityAddTraits(selection == item ? .isSelected : [])
            }
            Spacer()
        }
        .padding(.vertical, Space.lg)
        .padding(.horizontal, Space.xs)
        .frame(width: 88)
        .background(Color.sidebar)
    }
}

enum Destination: String, Hashable, CaseIterable, Identifiable {
    case chat, studio, files, memory, settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .chat: "对话"
        case .studio: "创作台"
        case .files: "文件"
        case .memory: "记忆"
        case .settings: "设置"
        }
    }

    var symbol: String {
        switch self {
        case .chat: Symbols.chat
        case .studio: Symbols.studio
        case .files: Symbols.library
        case .memory: Symbols.memory
        case .settings: Symbols.settings
        }
    }
}
