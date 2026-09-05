import XCTest
@testable import OpenClaw

private final class Requests: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [URLRequest] = []
    private var failNextSend = false
    func failOneSend() { lock.lock(); defer { lock.unlock() }; failNextSend = true }
    func record(_ request: URLRequest) -> Bool {
        lock.lock(); defer { lock.unlock() }
        entries.append(request)
        if request.url?.path == "/v1/requests", failNextSend { failNextSend = false; return true }
        return false
    }
    var all: [URLRequest] { lock.lock(); defer { lock.unlock() }; return entries }
    var sends: [URLRequest] { all.filter { $0.url?.path == "/v1/requests" } }
}

private final class GlassesProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> Data)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        do {
            var captured = request
            if captured.httpBody == nil, let stream = captured.httpBodyStream {
                stream.open(); defer { stream.close() }
                var data = Data(), bytes = [UInt8](repeating: 0, count: 1024)
                while stream.hasBytesAvailable {
                    let count = stream.read(&bytes, maxLength: bytes.count)
                    if count <= 0 { break }
                    data.append(contentsOf: bytes.prefix(count))
                }
                captured.httpBody = data
            }
            let data = try Self.handler!(captured)
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                           headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
}

@MainActor
final class GlassesIntegrationTests: XCTestCase {
    private func fixture() -> (GlassesModel, Requests, String) {
        let namespace = "glasses-tests-\(UUID().uuidString)", username = "owner-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: namespace)!
        defaults.set("https://glasses.example", forKey: "glasses.relayURL")
        let requests = Requests()
        GlassesProtocol.handler = { request in
            if requests.record(request) { throw URLError(.timedOut) }
            if request.url?.path == "/v1/me" {
                return try JSONSerialization.data(withJSONObject: ["username": username,
                    "claws": [["clawId": "openclaw1"], ["clawId": "openclaw2"]], "pushEnabled": false])
            }
            if request.url?.path == "/v1/requests" {
                let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
                return try JSONSerialization.data(withJSONObject: ["requestId": body["requestId"]!, "status": "queued"])
            }
            return Data(#"{"events":[],"cursor":0}"#.utf8)
        }
        let model = GlassesModel(defaults: defaults, makeClient: { GlassesAPI(session: $0, protocolClasses: [GlassesProtocol.self]) })
        addTeardownBlock { defaults.removePersistentDomain(forName: namespace) }
        return (model, requests, username)
    }
    private func waitForConnection(_ model: GlassesModel) async throws {
        for _ in 0..<200 {
            if model.isConnected { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Glasses did not connect using the app session: \(model.notice)")
    }
    private func body(_ request: URLRequest) throws -> [String: String] {
        try JSONDecoder().decode([String: String].self, from: request.httpBody!)
    }

    func testReusesLoginAndFollowsSharedAssistantSelection() async throws {
        let (model, requests, username) = fixture()
        model.updateSession(token: "shared-app-session", username: username, clawId: "openclaw1")
        try await waitForConnection(model)
        await model.send("First assistant request")
        model.updateSession(token: "shared-app-session", username: username, clawId: "openclaw2")
        await model.send("Second assistant request")
        XCTAssertEqual(requests.sends.count, 2)
        XCTAssertEqual(try body(requests.sends[0])["clawId"], "openclaw1")
        XCTAssertEqual(try body(requests.sends[1])["clawId"], "openclaw2")
        XCTAssertTrue(requests.all.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer shared-app-session" })
        XCTAssertFalse(requests.all.contains { $0.url!.path.contains("login") })
        model.disconnect()
    }

    func testRetryStaysWithItsOriginalAssistantAndRequestId() async throws {
        let (model, requests, username) = fixture()
        model.updateSession(token: "shared-app-session", username: username, clawId: "openclaw1")
        try await waitForConnection(model)
        requests.failOneSend()
        await model.send("Keep this request")
        let originalId = try XCTUnwrap(model.pending?.requestId)
        model.updateSession(token: "shared-app-session", username: username, clawId: "openclaw2")
        XCTAssertNil(model.pending)
        await model.send("A different request")
        model.updateSession(token: "shared-app-session", username: username, clawId: "openclaw1")
        XCTAssertEqual(model.pending?.requestId, originalId)
        await model.retry()
        XCTAssertNil(model.pending)
        XCTAssertEqual(try body(requests.sends.last!)["requestId"], originalId)
        XCTAssertEqual(try body(requests.sends.last!)["clawId"], "openclaw1")
        model.disconnect()
    }

    func testSelectionChangeDropsSpeechQueuedForPreviousAssistant() async throws {
        let (model, requests, username) = fixture()
        model.updateSession(token: "shared-app-session", username: username, clawId: "openclaw1")
        try await waitForConnection(model)
        model.voice.onRequest?("Only for the first assistant")
        model.updateSession(token: "shared-app-session", username: username, clawId: "openclaw2")
        await Task.yield()
        XCTAssertTrue(requests.sends.isEmpty)
        model.disconnect()
        XCTAssertFalse(model.isConnected)
        XCTAssertFalse(model.voice.active)
        XCTAssertTrue(model.events.isEmpty)
        await model.send("Cannot send after app sign-out")
        XCTAssertTrue(requests.sends.isEmpty)
    }

    func testScreenshotModeDoesNotConnectToTheRelay() async {
        let (model, requests, username) = fixture()
        model.updateSession(token: "demo", username: username, clawId: "openclaw1", demo: true)
        await Task.yield()
        XCTAssertTrue(requests.all.isEmpty)
        XCTAssertFalse(model.isConnected)
    }
}
