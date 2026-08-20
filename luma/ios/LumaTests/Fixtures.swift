import Foundation
@testable import Luma

/// Message and event fixtures written as the wire writes them, so the tests
/// exercise the decoder as well as the builder.
enum Fixtures {
    static func messages(_ json: String) -> [StoredMessage] {
        decode([StoredMessage].self, json)
    }

    static func event(_ json: String) -> StoredEvent {
        decode(StoredEvent.self, json)
    }

    static func events(_ json: String) -> [StoredEvent] {
        decode([StoredEvent].self, json)
    }

    private static func decode<T: Decodable>(_ type: T.Type, _ json: String) -> T {
        // A fixture that will not decode is a broken test, not a runtime
        // condition, so this fails loudly rather than returning something empty.
        try! JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    /// A turn that thinks, searches, and answers: the shape almost every real
    /// conversation has.
    static let searchTurn = """
    [
      {
        "id": "m1", "seq": 1, "role": "user", "createdAt": 1,
        "content": "推荐的采样器是哪个？"
      },
      {
        "id": "m2", "seq": 2, "role": "assistant", "createdAt": 2,
        "content": [
          { "type": "thinking", "thinking": "先查一下。__ENCRYPTED_REASONING__abc" },
          { "type": "text", "text": "我查一下。" },
          {
            "type": "toolCall", "id": "call_1", "name": "web_search",
            "arguments": { "intent": "搜索推荐的采样器", "query": "sampler" }
          }
        ]
      },
      {
        "id": "m3", "seq": 3, "role": "toolResult", "createdAt": 3,
        "content": {
          "toolCallId": "call_1",
          "isError": false,
          "content": [{ "type": "text", "text": "# Search 1: \\"Sampler\\"\\nAnchor: \\ue202turn0search0\\nURL: https://example.com/a" }]
        }
      },
      {
        "id": "m4", "seq": 4, "role": "assistant", "createdAt": 4,
        "content": [{ "type": "text", "text": "用 dpmpp_2m。" }]
      }
    ]
    """

    /// A generation turn: the picture comes back on the tool result, and the
    /// model also mentions it in prose.
    static let imageTurn = """
    [
      { "id": "m1", "seq": 1, "role": "user", "createdAt": 1, "content": "画一只猫" },
      {
        "id": "m2", "seq": 2, "role": "assistant", "createdAt": 2,
        "content": [
          {
            "type": "toolCall", "id": "call_img", "name": "generate_image",
            "arguments": { "intent": "画一只猫", "prompt": "cat" }
          }
        ]
      },
      {
        "id": "m3", "seq": 3, "role": "toolResult", "createdAt": 3,
        "content": {
          "toolCallId": "call_img",
          "isError": false,
          "content": [
            { "type": "text", "text": "done" },
            { "type": "image_ref", "image_id": "img_0123456789abcdef0123456789abcdef" }
          ]
        }
      },
      {
        "id": "m4", "seq": 4, "role": "assistant", "createdAt": 4,
        "content": [
          { "type": "text", "text": "画好了：![猫](image://img_0123456789abcdef0123456789abcdef)" }
        ]
      }
    ]
    """

    /// A turn the provider failed.
    static let failedTurn = """
    [
      { "id": "m1", "seq": 1, "role": "user", "createdAt": 1, "content": "你好" },
      {
        "id": "m2", "seq": 2, "role": "assistant", "createdAt": 2,
        "content": {
          "stopReason": "error",
          "errorMessage": "上游返回 429",
          "content": [{ "type": "text", "text": "" }]
        }
      }
    ]
    """

    /// A question about a document, as the server persists it: the attachment
    /// survives in the message rather than only in the run that sent it.
    static let documentTurn = """
    [
      {
        "id": "m1", "seq": 1, "role": "user", "createdAt": 1,
        "content": [
          { "type": "text", "text": "这个附件里写了什么？" },
          {
            "type": "file_ref",
            "file_id": "file_e55e0123456789abcdef0123456789ab",
            "name": "report.txt",
            "mime_type": "text/plain",
            "bytes": 32
          }
        ]
      }
    ]
    """

    /// A content part no build has ever seen. It must be dropped, not thrown.
    static let unknownPart = """
    [
      {
        "id": "m1", "seq": 1, "role": "assistant", "createdAt": 1,
        "content": [
          { "type": "text", "text": "前" },
          { "type": "quantum_ref", "quantum_id": "q1" },
          { "type": "text", "text": "后" }
        ]
      }
    ]
    """
}
