import Foundation
import Testing
import UIKit

@testable import Luma

/// Every SF Symbol the app names has to exist.
///
/// A name that is not a real symbol is not a build error and not a crash — the
/// row simply draws nothing, and the gap only shows up if someone looks at that
/// screen on the right OS version. `plug` shipped that way: every other row in
/// settings had an icon and that one had a hole where one should be.
///
/// So this walks the source rather than holding a list, because a list would go
/// stale the first time someone adds a row.
struct SymbolTests {
    @Test("every symbol the app names resolves")
    func symbolsResolve() throws {
        let missing = try Self.named().filter { UIImage(systemName: $0) == nil }.sorted()
        #expect(missing.isEmpty, "not real SF Symbols: \(missing.joined(separator: ", "))")
    }

    /// Symbol names written as `systemImage:`, `systemName:` or `symbol:`
    /// literals anywhere in the app's sources.
    private static func named() throws -> Set<String> {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // LumaTests
            .deletingLastPathComponent()  // ios
        let pattern = try NSRegularExpression(
            pattern: #"(?:systemImage|systemName|symbol):\s*"([^"]+)""#
        )

        var found: Set<String> = []
        for directory in ["Core", "UI", "Luma"] {
            let base = root.appendingPathComponent(directory)
            guard let walk = FileManager.default.enumerator(atPath: base.path) else { continue }
            for case let path as String in walk where path.hasSuffix(".swift") {
                let source = try String(contentsOf: base.appendingPathComponent(path), encoding: .utf8)
                let whole = NSRange(source.startIndex..., in: source)
                for match in pattern.matches(in: source, range: whole) {
                    guard let range = Range(match.range(at: 1), in: source) else { continue }
                    found.insert(String(source[range]))
                }
            }
        }

        // A guard against the walk quietly finding nothing and passing.
        #expect(found.count > 20, "expected to find the app's symbols, found \(found.count)")
        return found
    }
}
