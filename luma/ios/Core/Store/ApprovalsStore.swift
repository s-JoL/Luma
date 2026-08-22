import Foundation
import Observation

/// Every question waiting for an answer, across every conversation.
///
/// `GET /approvals` has been on the server the whole time and no client has ever
/// called it: the browser only ever asks per conversation, because a browser tab
/// is already looking at one. A phone is not. The agent can be halfway through
/// deleting a directory in a conversation that is not on screen, and until now
/// the only way to find out was to open conversations one at a time.
///
/// This is deliberately not a stream. An approval is a rare event with a long
/// deadline, and a poll on foreground plus a refresh after every decision is both
/// cheaper and harder to get wrong than another SSE connection to supervise.
@MainActor
@Observable
final class ApprovalsStore {
    private(set) var pending: [Approval] = []
    private(set) var isLoading = false
    /// The conversation each question belongs to, so the inbox can name it
    /// rather than showing an id.
    private(set) var titles: [ConversationId: String] = [:]

    private let api: APIClient
    private weak var app: AppModel?

    init(api: APIClient) {
        self.api = api
    }

    func attach(_ model: AppModel) { app = model }

    var count: Int { pending.count }

    func reset() {
        pending = []
        titles = [:]
    }

    func refresh() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await api.send(.pendingApprovals(), as: Page<Approval>.self)
            pending = page.items.filter(\.isAnswerable)
            adoptTitles()
        } catch let failure as APIError where failure.signsOut {
            app?.handle(failure)
        } catch {
            // A background poll that failed is not worth a toast. The next
            // foreground tries again, and the transcript still carries the
            // question where it was asked.
        }
    }

    /// Answers, then re-reads rather than assuming: two devices looking at the
    /// same inbox have to converge, and the row is the truth.
    func decide(_ approval: Approval, approved: Bool) async {
        do {
            try await api.send(.decideApproval(approval.id, approved: approved))
            pending.removeAll { $0.id == approval.id }
        } catch let failure as APIError {
            app?.handle(failure)
        } catch {}
        await refresh()
    }

    /// The list already knows most conversation titles. Anything it does not is
    /// left to show its fallback rather than fetched one row at a time.
    private func adoptTitles() {
        guard let known = app?.conversations.items else { return }
        for row in known where pending.contains(where: { $0.conversationId == row.id }) {
            titles[row.id] = row.displayTitle
        }
    }

    func title(for id: ConversationId) -> String {
        titles[id] ?? "某个对话"
    }
}
