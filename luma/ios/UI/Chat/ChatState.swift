import PhotosUI
import SwiftUI

/// What the reader is writing, held apart from the transcript that is being read.
///
/// This is not tidiness. SwiftUI re-evaluates a view's body when state that body
/// read changes, and the draft used to be `@State` on the same view that holds
/// the `ForEach` over every turn — so each keystroke rebuilt the whole transcript
/// and deep-compared every message in it against an identical copy, between one
/// letter and the next. Moving the draft into an object only the composer reads
/// means typing costs the composer and nothing else.
@MainActor
@Observable
final class ComposerState {
    var draft = ""
    var attachments: [DraftAttachment] = []
    var uploading = false

    var showingAttach = false
    var pickingPhotos = false
    var photos: [PhotosPickerItem] = []
    var importing = false

    var attachmentIds: [String] { attachments.map(\.id) }

    /// Everything the send took with it, cleared in one place so a half-cleared
    /// composer cannot re-send an attachment.
    func clear() {
        draft = ""
        attachments = []
    }
}

/// Whether the transcript should keep itself at the end of a growing answer.
///
/// One bit, and two events that change it. This is FlowDown's state machine
/// (`MessageListView.swift`, `scrollViewWillBeginDragging` / `updateAutoScrolling`)
/// rather than anything inferred, and the reason to prefer it is that inference
/// is what kept going wrong here:
///
/// * Distance alone was a feedback loop — one scroll that did not quite land
///   grew the gap, the gap looked like a reader who had moved away, following
///   stopped, and the gap grew for good.
/// * Distance plus "is a finger down" fixed that but still had to define how far
///   counts as *away*, and the answer changed with the keyboard, the composer
///   inset and the length of the last turn.
///
/// So geometry is never allowed to turn following **off**. Only a drag does
/// that, immediately and unconditionally. Geometry only turns it back **on**,
/// and only when the scroll has come to rest essentially at the bottom. Both
/// halves are unambiguous, and neither depends on a tuned threshold: the
/// tolerance is two points because that is "the same place", not because it was
/// dialled in.
///
/// Written on every scroll event, which is why it lives here rather than on the
/// view that renders the list — only the jump pill and the tail follower read it,
/// and both are leaves.
@MainActor
@Observable
final class ScrollFollow {
    /// Near enough to the bottom to count as being at it.
    private static let tolerance: CGFloat = 2
    /// Far enough from the bottom that a "back to latest" offer is useful.
    private static let pillDistance: CGFloat = 200

    private(set) var isFollowing = true
    private(set) var pendingCount = 0
    /// True when the reader is far enough away that the pill is worth offering.
    private(set) var isAway = false
    /// Bumped when something should force the view to the tail.
    private(set) var requests = 0

    /// Where the scroll was on the last geometry callback.
    ///
    /// Deliberately not observed. It is written on every frame of a scroll and
    /// read only when the scroll stops, so publishing it would invalidate the
    /// pill sixty times a second to answer a question nobody is asking yet.
    @ObservationIgnored private var reading = TailReading()

    /// A finger touched the glass. The reader is in charge from here until they
    /// come back to the bottom themselves.
    func beganDragging() {
        if isFollowing { isFollowing = false }
    }

    /// The scroll came to rest. Re-arm only if it rested at the end.
    func cameToRest() {
        guard reading.distanceFromTail <= Self.tolerance else { return }
        if !isFollowing { isFollowing = true }
        if pendingCount != 0 { pendingCount = 0 }
    }

    /// Every write is guarded on a change. Observation notifies on assignment
    /// rather than on difference, so storing the same value on every frame of a
    /// scroll would invalidate the readers just as often as storing a new one.
    func report(_ reading: TailReading) {
        self.reading = reading
        let away = !isFollowing && reading.distanceFromTail > Self.pillDistance
        if isAway != away { isAway = away }
        if reading.distanceFromTail <= Self.tolerance, pendingCount != 0 { pendingCount = 0 }
    }

    /// A turn arrived. Returns whether the view should go to it. Counted only
    /// when the reader is away — the pill says how much they have missed, not
    /// how much has been written.
    func noteArrival() -> Bool {
        guard !isFollowing else { return true }
        pendingCount += 1
        return false
    }

    /// Sending, editing and tapping the pill all mean the same thing: put me at
    /// the end and keep me there.
    func returnToTail() {
        if !isFollowing { isFollowing = true }
        if isAway { isAway = false }
        if pendingCount != 0 { pendingCount = 0 }
        requests += 1
    }

    func settleAtTail() {
        if !isFollowing { isFollowing = true }
        if isAway { isAway = false }
        if pendingCount != 0 { pendingCount = 0 }
    }
}