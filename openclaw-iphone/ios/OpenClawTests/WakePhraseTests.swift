import XCTest
@testable import OpenClaw

final class WakePhraseTests: XCTestCase {
    func testOnlyAddressedSpeechIsForwarded() {
        XCTAssertNil(WakePhrase.request(in: "Book a table for two"))
        XCTAssertNil(WakePhrase.request(in: "OpenClaw"))
        XCTAssertNil(WakePhrase.request(in: "myopenclawbot do this"))
        XCTAssertNil(WakePhrase.request(in: "I asked OpenClaw to book a table yesterday."))
        XCTAssertEqual(WakePhrase.request(in: "Hey OpenClaw, book a table for two."), "book a table for two.")
        XCTAssertEqual(WakePhrase.request(in: "Open Claw: read my latest reply"), "read my latest reply")
        XCTAssertEqual(WakePhrase.request(in: "OpenClaw, stop listening"), "stop listening")
    }
    func testRelayCannotReceiveTokensOverHTTPOrRedirectViaUserInfo() throws {
        XCTAssertThrowsError(try GlassesAPI.secureURL("http://example.com"))
        XCTAssertThrowsError(try GlassesAPI.secureURL("https://user:secret@example.com"))
        XCTAssertThrowsError(try GlassesAPI.secureURL("https://example.com?next=elsewhere"))
        XCTAssertEqual(try GlassesAPI.secureURL("https://example.com/").host, "example.com")
    }
}
