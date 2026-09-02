import Foundation

/// Screenshot mode: `OPENCLAW_DEMO=1` in the launch environment answers every
/// API call locally with canned data, so App Store screenshots need no
/// network and no real claw. `OPENCLAW_DEMO_TAB` picks the tab
/// (claws|location|website|phone|connect) and `OPENCLAW_DEMO_SCREEN` an
/// inner screen (chat|alexa|telegram).
enum DemoMode {
    static var isActive: Bool { ProcessInfo.processInfo.environment["OPENCLAW_DEMO"] == "1" }
    static var tab: String? { ProcessInfo.processInfo.environment["OPENCLAW_DEMO_TAB"] }
    static var screen: String? { ProcessInfo.processInfo.environment["OPENCLAW_DEMO_SCREEN"] }
}

/// Canned server for DemoMode. Registered on the APIClient's URLSession.
final class DemoURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let path = request.url?.path ?? ""
        let body = Self.response(for: path)
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    private static let now = Date().timeIntervalSince1970 * 1000

    private static func response(for path: String) -> String {
        switch path {
        case "/api/mobile/queries/me":
            return """
            {"username":"ana","claws":[{"clawId":"openclaw7","phoneNumber":"+14035550142",
              "website":{"domain":"anasbakery.ca","fusenvSubdomain":"anas-bakery","url":"https://anasbakery.ca","fusenvUrl":"https://anas-bakery.fusenv.com"},
              "telegramBotUsername":"anas_claw_bot"}]}
            """
        case "/api/mobile/queries/location-sharing":
            return """
            {"consent":"given","lapsed":false,"latest":{"latitude":51.0447,"longitude":-114.0719,"accuracyMeters":11,
              "reportedAt":\(Int(now - 120_000)),"receivedAt":\(Int(now - 120_000))}}
            """
        case "/api/mobile/queries/conversation":
            let t = Int(now)
            return """
            {"clawId":"openclaw7","messages":[
              {"messageId":"a1","role":"owner","text":"Can you check my texts and tell me if the supplier confirmed Friday's delivery?","timestamp":\(t - 3_600_000),"status":"replied","failureCount":0},
              {"messageId":"a1:reply","role":"claw","text":"Yes. Dave from Prairie Flour texted at 9:12: 40 bags arriving Friday between 7 and 9am. I replied that the back door will be open. Want me to add it to your calendar?","timestamp":\(t - 3_540_000)},
              {"messageId":"a2","role":"owner","text":"Yes please. And phone the dentist and move my 2pm to next week.","timestamp":\(t - 900_000),"status":"replied","failureCount":0},
              {"messageId":"a2:reply","role":"claw","text":"Done. Calendar: delivery Friday 7-9am. I called Bow Valley Dental; your cleaning is now Tuesday the 9th at 2pm. Confirmation texted to you.","timestamp":\(t - 600_000)},
              {"messageId":"a3","role":"owner","text":"Add a Prices page to the website with the sourdough at $9 and the rye at $8.","timestamp":\(t - 60_000),"status":"awaiting-reply","failureCount":0}
            ]}
            """
        default:
            return "{\"success\":true}"
        }
    }
}
