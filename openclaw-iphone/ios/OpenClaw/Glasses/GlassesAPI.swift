import Foundation

struct GlassesClaw: Decodable, Identifiable {
    let clawId: String
    var id: String { clawId }
}
struct GlassesProfile: Decodable {
    let username: String
    let claws: [GlassesClaw]
    let pushEnabled: Bool
}
struct GlassesSummaryEvent: Codable, Identifiable {
    let seq: Int64
    let id: String
    let clawId: String
    let kind: String
    let text: String
    let summary: String
    let createdAt: Double
    var date: Date { Date(timeIntervalSince1970: createdAt / 1000) }
}
struct GlassesInbox: Decodable { let events: [GlassesSummaryEvent]; let cursor: Int64 }
struct GlassesSession: Equatable { let token: String; let relayURL: URL; let username: String }
struct GlassesPendingRequest: Codable {
    let requestId: String
    let clawId: String
    let text: String
}
struct GlassesRequestReceipt: Decodable { let requestId: String; let status: String }

enum GlassesError: LocalizedError {
    case invalidURL, http(Int, String)
    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Enter an HTTPS relay address."
        case .http(_, let message): return message
        }
    }
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

final class GlassesAPI: @unchecked Sendable {
    let session: GlassesSession
    private let network: URLSession
    init(session: GlassesSession, protocolClasses: [AnyClass]? = nil) {
        self.session = session
        let configuration = URLSessionConfiguration.ephemeral
        if let protocolClasses { configuration.protocolClasses = protocolClasses }
        network = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }

    static func secureURL(_ value: String) throws -> URL {
        guard let url = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme == "https", url.host != nil, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/" else { throw GlassesError.invalidURL }
        return url
    }

    private func request<T: Decodable>(_ method: String, _ path: String, query: [URLQueryItem] = [], body: (any Encodable)? = nil) async throws -> T {
        var components = URLComponents(url: session.relayURL.appending(path: path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.timeoutInterval = 20
        if !session.token.isEmpty { request.setValue("Bearer \(session.token)", forHTTPHeaderField: "Authorization") }
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await network.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            struct Failure: Decodable { let error: String }
            let message = (try? JSONDecoder().decode(Failure.self, from: data))?.error ?? "Request failed (\(code))."
            throw GlassesError.http(code, message)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    func me() async throws -> GlassesProfile { try await request("GET", "/v1/me") }
    func events(clawId: String, after: Int64?) async throws -> GlassesInbox {
        var query = [URLQueryItem(name: "clawId", value: clawId)]
        if let after { query.append(URLQueryItem(name: "after", value: String(after))) }
        return try await request("GET", "/v1/events", query: query)
    }
    func send(_ request: GlassesPendingRequest) async throws -> GlassesRequestReceipt { try await self.request("POST", "/v1/requests", body: request) }
    func register(installationId: String, token: String) async throws {
        struct Device: Encodable { let installationId: String; let deviceToken: String }
        struct OK: Decodable { let ok: Bool }
        let _: OK = try await request("POST", "/v1/devices", body: Device(installationId: installationId, deviceToken: token))
    }
    func unregister(installationId: String) async throws {
        struct OK: Decodable { let ok: Bool }
        let _: OK = try await request("DELETE", "/v1/devices/\(installationId)")
    }
}
