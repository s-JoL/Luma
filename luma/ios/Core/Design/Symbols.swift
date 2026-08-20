import Foundation

/// One place naming every SF Symbol, so a tool never renders as a generic wrench
/// and a rename happens once.
enum Symbols {
    static let chat = "bubble.left.and.bubble.right"
    static let studio = "wand.and.stars"
    static let library = "folder"
    static let memory = "sparkles"
    static let settings = "slider.horizontal.3"

    static let send = "arrow.up"
    static let stop = "stop.fill"
    static let attach = "plus"
    static let newConversation = "square.and.pencil"
    static let jumpToLatest = "arrow.down"
    static let model = "chevron.down"
    static let document = "doc.text"
    static let failed = "exclamationmark.triangle"
    static let done = "checkmark"

    /// An unknown tool — anything from an MCP server the app has never heard of
    /// — falls back to the puzzle piece rather than a wrench.
    static func tool(_ name: String) -> String {
        switch name {
        case "web_search", "web_fetch": "globe"
        case "file_search": "doc.text.magnifyingglass"
        case "generate_image", "edit_image": "wand.and.stars"
        case "generate_video": "film"
        case "read_file", "list_dir": "doc.text"
        case "write_file", "apply_patch", "edit_file": "square.and.pencil"
        case "delete_path", "move_path": "trash"
        case "bash_tool", "shell": "terminal"
        case "set_memory", "delete_memory", "remember", "forget": "brain"
        case "view_image": "photo"
        default: "puzzlepiece.extension"
        }
    }
}
