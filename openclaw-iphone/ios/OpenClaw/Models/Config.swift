import Foundation

enum AppConfig {
    /// openclaw-iphone.fusenv.com by default (Info.plist → OPENCLAW_API_BASE_URL);
    /// overridable from the login screen for local development.
    static var defaultAPIBaseURL: URL {
        let configured = Bundle.main.object(forInfoDictionaryKey: "OPENCLAW_API_BASE_URL") as? String
        return URL(string: configured ?? "") ?? URL(string: "https://8examples.com")!
    }

    /// Optional glasses relay. An empty value leaves the feature ready for setup.
    static var defaultGlassesRelayURL: String {
        Bundle.main.object(forInfoDictionaryKey: "OPENCLAW_GLASSES_RELAY_URL") as? String ?? ""
    }

    /// How often the phone reports its position while sharing is on.
    static let locationReportInterval: TimeInterval = 5 * 60

    /// Where people log in on the web with the same credentials.
    static let webChatURL = URL(string: "https://chat.8examples.com")!

    /// The 8Examples AI Assistant Alexa skill (Productivity).
    static let alexaSkillStoreURL = URL(string: "https://www.amazon.ca/dp/B0HGFRKMYG")!
    static let alexaAppURL = URL(string: "alexa://")!
    static let alexaSkillName = "8Examples AI Assistant"
}
