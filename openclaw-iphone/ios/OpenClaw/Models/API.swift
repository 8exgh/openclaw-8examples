import Foundation

// MARK: - Wire types (mirror 8examples src/app/lib/mobile.ts)

struct ClawWebsite: Codable, Hashable {
    let domain: String?
    let fusenvSubdomain: String
    let url: String
    let fusenvUrl: String
}

struct ClawCard: Codable, Identifiable, Hashable {
    let clawId: String
    let phoneNumber: String?
    let website: ClawWebsite?
    let telegramBotUsername: String?
    var id: String { clawId }

    /// "openclaw7" → "Claw 7"
    var displayName: String {
        let digits = clawId.drop(while: { !$0.isNumber })
        return digits.isEmpty ? clawId : "Claw \(digits)"
    }
}

struct MeResult: Codable {
    let username: String
    let claws: [ClawCard]
}

struct LoginResult: Codable {
    let token: String
    let username: String
}

struct LocationFix: Codable, Hashable {
    let latitude: Double
    let longitude: Double
    let accuracyMeters: Double?
    let reportedAt: Double   // ms since epoch
    let receivedAt: Double   // ms since epoch
    var reportedDate: Date { Date(timeIntervalSince1970: reportedAt / 1000) }
}

struct LocationSharingResult: Codable {
    let consent: String      // never-asked | given | revoked
    let lapsed: Bool
    let latest: LocationFix?
}

struct ConversationMessage: Codable, Identifiable, Hashable {
    let messageId: String
    let role: String         // owner | claw
    let text: String
    let timestamp: Double    // ms since epoch
    let status: String?      // owner only: awaiting-reply | replied | failed
    let failureCount: Int?
    let errorMessage: String?
    var id: String { messageId }
    var date: Date { Date(timeIntervalSince1970: timestamp / 1000) }
    var isOwner: Bool { role == "owner" }
}

struct ConversationResult: Codable {
    let clawId: String
    let messages: [ConversationMessage]
}

struct APIErrorBody: Codable { let error: String }

enum APIError: LocalizedError {
    case http(Int, String)
    case unauthorized
    case transport(Error)

    var errorDescription: String? {
        switch self {
        case .http(_, let message): return message
        case .unauthorized: return "Please sign in again."
        case .transport(let error): return error.localizedDescription
        }
    }
}

// MARK: - Client

final class APIClient: @unchecked Sendable {
    var baseURL: URL
    var token: String?
    private let session: URLSession

    init(baseURL: URL, token: String?) {
        self.baseURL = baseURL
        self.token = token
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.waitsForConnectivity = false
        session = URLSession(configuration: config)
    }

    private struct Empty: Codable {}

    private func request<T: Decodable>(_ method: String, _ path: String, query: [String: String] = [:], body: (some Encodable)? = Empty?.none, as: T.Type) async throws -> T {
        var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var req = URLRequest(url: components.url!)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(body)
        } else if method == "POST" {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = Data("{}".utf8)
        }

        let (data, response): (Data, URLResponse)
        do { (data, response) = try await session.data(for: req) } catch { throw APIError.transport(error) }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if status == 401, token != nil, path != "/api/mobile/login" { throw APIError.unauthorized }
            let message = (try? JSONDecoder().decode(APIErrorBody.self, from: data))?.error ?? "Request failed (\(status))"
            throw APIError.http(status, message)
        }
        if T.self == Empty.self { return Empty() as! T }
        return try JSONDecoder().decode(T.self, from: data)
    }

    // Auth
    func login(username: String, password: String) async throws -> LoginResult {
        struct Body: Encodable { let username: String; let password: String }
        return try await request("POST", "/api/mobile/login", body: Body(username: username, password: password), as: LoginResult.self)
    }

    func logout() async throws {
        _ = try await request("POST", "/api/mobile/logout", as: Empty.self)
    }

    // Queries
    func me() async throws -> MeResult {
        try await request("GET", "/api/mobile/queries/me", as: MeResult.self)
    }

    func locationSharing() async throws -> LocationSharingResult {
        try await request("GET", "/api/mobile/queries/location-sharing", as: LocationSharingResult.self)
    }

    func conversation(clawId: String) async throws -> ConversationResult {
        try await request("GET", "/api/mobile/queries/conversation", query: ["clawId": clawId], as: ConversationResult.self)
    }

    // Commands
    func giveLocationConsent() async throws {
        _ = try await request("POST", "/api/mobile/commands/give-location-consent", as: Empty.self)
    }

    func revokeLocationConsent() async throws {
        _ = try await request("POST", "/api/mobile/commands/revoke-location-consent", as: Empty.self)
    }

    func reportLocation(latitude: Double, longitude: Double, accuracyMeters: Double?, reportedAt: Date) async throws {
        struct Body: Encodable { let latitude: Double; let longitude: Double; let accuracyMeters: Double?; let reportedAt: Int }
        let body = Body(latitude: latitude, longitude: longitude, accuracyMeters: accuracyMeters,
                        reportedAt: Int(reportedAt.timeIntervalSince1970 * 1000))
        _ = try await request("POST", "/api/mobile/commands/report-location", body: body, as: Empty.self)
    }

    func sendMessage(clawId: String, messageId: String, text: String) async throws {
        struct Body: Encodable { let clawId: String; let messageId: String; let text: String }
        _ = try await request("POST", "/api/mobile/commands/send-message-to-claw",
                              body: Body(clawId: clawId, messageId: messageId, text: text), as: Empty.self)
    }
}
