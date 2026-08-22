import Foundation
import OSLog

/// Counts how often each view's body actually runs.
///
/// Reasoning about SwiftUI invalidation from the source is how the last round of
/// "this should be faster now" happened, and the reader still felt stutter. A
/// body is either being evaluated or it is not, and that is a number — so this
/// counts it and logs a summary, and the guessing stops.
///
/// Debug-only and off unless asked for, because the counting itself is a
/// dictionary write per body.
enum RenderLog {
    #if DEBUG
    /// Turned on with `-luma.renderLog 1`, so a normal debug run pays nothing
    /// beyond a boolean read.
    static let isEnabled: Bool = UserDefaults.standard.volatileDomain(
        forName: UserDefaults.argumentDomain
    )["luma.renderLog"] != nil

    private static let logger = Logger(subsystem: "works.earendil.luma", category: "render")
    private static let counts = OSAllocatedUnfairLock(initialState: [String: Int]())
    nonisolated(unsafe) private static var started = false

    static func tick(_ name: String) {
        guard isEnabled else { return }
        counts.withLock { $0[name, default: 0] += 1 }
        startReporting()
    }

    /// How late the main thread ran, which is the number a reader actually
    /// feels.
    ///
    /// A task that wants to run every 16ms and instead runs 400ms later was
    /// blocked for 384ms, and that is a dropped-frame stall whatever the cause —
    /// layout, parsing, decoding, or a library resolving anchor preferences.
    /// Counting body evaluations says what SwiftUI was asked to do; this says
    /// whether it kept up.
    @MainActor
    static func startHeartbeat() {
        guard isEnabled, !beating else { return }
        beating = true
        Task { @MainActor in
            let interval = Duration.milliseconds(16)
            var worst = 0.0
            var window = ContinuousClock.now
            while true {
                let expected = ContinuousClock.now + interval
                try? await Task.sleep(for: interval)
                let late = (ContinuousClock.now - expected).seconds * 1000
                worst = max(worst, late)

                if ContinuousClock.now - window > .seconds(2) {
                    if worst > 24 {
                        logger.notice("HITCH/2s worst main-thread stall \(Int(worst), privacy: .public) ms")
                    }
                    worst = 0
                    window = ContinuousClock.now
                }
            }
        }
    }

    nonisolated(unsafe) private static var beating = false

    /// Reports on a timer rather than per tick: the interesting question is
    /// "how many times per second", and a line per body would drown it.
    private static func startReporting() {
        guard !started else { return }
        started = true
        Task.detached {
            var previous: [String: Int] = [:]
            while true {
                try? await Task.sleep(for: .seconds(2))
                let now = counts.withLock { $0 }

                let deltas = now
                    .map { ($0.key, $0.value - (previous[$0.key] ?? 0)) }
                    .filter { $0.1 > 0 }
                    .sorted { $0.1 > $1.1 }
                previous = now
                guard !deltas.isEmpty else { continue }

                let line = deltas.map { "\($0.0)=\($0.1)" }.joined(separator: " ")
                logger.notice("RENDER/2s \(line, privacy: .public)")
            }
        }
    }
    #else
    static let isEnabled = false
    @inline(__always)
    static func tick(_ name: String) {}
    #endif
}

private extension Duration {
    var seconds: Double {
        Double(components.seconds) + Double(components.attoseconds) / 1e18
    }
}
