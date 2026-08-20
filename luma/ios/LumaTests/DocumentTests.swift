import Foundation
import Testing
@testable import Luma

/// Opening an attachment means writing it to disk under a name that came from
/// outside the app, then handing the file to iOS. Both halves are silent when
/// they go wrong — a bad name fails the write, an unauthenticated fetch fails
/// the open — so both are checked here.
struct DocumentTests {
    private let client = APIClient(base: URL(string: "http://mac.local:8090/v1")!, token: "tok_1")

    @Test("a document's bytes are fetched from the same authenticated root")
    func contentRequest() async throws {
        let request = try await client.request(for: .fileContent(FileId("file_9")))
        #expect(request.url?.absoluteString == "http://mac.local:8090/v1/files/file_9/content")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok_1")
    }

    @Test("an ordinary name is written as it is")
    func keepsOrdinaryNames() {
        #expect(DocumentName.onDisk("report.txt") == "report.txt")
        #expect(DocumentName.onDisk("季度报告 2026.pdf") == "季度报告 2026.pdf")
    }

    @Test("a name that could escape the directory cannot")
    func neutralisesSeparators() {
        #expect(DocumentName.onDisk("../../etc/passwd") == "_.._etc_passwd")
        #expect(DocumentName.onDisk(".hidden") == "hidden")
        #expect(DocumentName.onDisk("   ") == "document")
    }

    @Test("a very long name keeps the extension Quick Look reads the type from")
    func truncatesTheStemOnly() {
        let name = String(repeating: "a", count: 400) + ".pdf"
        let result = DocumentName.onDisk(name)
        #expect(result.hasSuffix(".pdf"))
        #expect(result.utf8.count < 120)
    }
}
