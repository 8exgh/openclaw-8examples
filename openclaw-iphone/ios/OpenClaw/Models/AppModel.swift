import CoreLocation
import Foundation
import Observation

/// All app state. Sign in with the Rocket.Chat (chat.fusenv.com) username and
/// password; the token lives in the Keychain. One conversation per claw, and
/// optional location sharing that pings the backend every 5 minutes.
@MainActor
@Observable
final class AppModel {
    enum Phase { case loading, loggedOut, ready }

    var phase: Phase = .loading
    var me: MeResult?
    var locationSharing: LocationSharingResult?
    var selectedClawId: String?
    var selectedTab: String = DemoMode.tab ?? "claws"
    var errorMessage: String?
    var busy = false
    var serverURLString: String { didSet { applyServerURL() } }

    let api: APIClient
    let location = LocationReporter()
    let glasses = GlassesModel()

    private static let tokenKey = "sessionToken"
    private static let serverKey = "serverURL"
    private static let selectedClawKey = "selectedClawId"

    init() {
        let defaults = UserDefaults.standard
        let urlString = defaults.string(forKey: Self.serverKey) ?? AppConfig.defaultAPIBaseURL.absoluteString
        serverURLString = urlString
        if DemoMode.isActive {
            // Screenshot mode: canned server, no Keychain, no prompts.
            api = APIClient(baseURL: URL(string: "https://demo.invalid")!, token: "demo", protocolClasses: [DemoURLProtocol.self])
        } else {
            api = APIClient(baseURL: URL(string: urlString) ?? AppConfig.defaultAPIBaseURL, token: Keychain.string(for: Self.tokenKey))
        }
        selectedClawId = defaults.string(forKey: Self.selectedClawKey)
        glasses.onAuthenticationFailure = { [weak self] in
            Task { @MainActor in await self?.refresh() }
        }
    }

    var claws: [ClawCard] { me?.claws ?? [] }

    var selectedClaw: ClawCard? {
        claws.first { $0.clawId == selectedClawId } ?? claws.first
    }

    func select(claw: ClawCard) {
        selectedClawId = claw.clawId
        UserDefaults.standard.set(claw.clawId, forKey: Self.selectedClawKey)
        synchronizeGlasses()
    }

    // MARK: lifecycle

    func bootstrap() async {
        guard api.token != nil else { phase = .loggedOut; return }
        await refresh()
        phase = api.token == nil ? .loggedOut : .ready
        resumeLocationSharingIfOn()
    }

    func refresh() async {
        do {
            me = try await api.me()
            if !claws.contains(where: { $0.clawId == selectedClawId }), let first = claws.first { select(claw: first) }
            synchronizeGlasses()
            openPendingGlassesNotification()
            locationSharing = try await api.locationSharing()
            errorMessage = nil
        } catch APIError.unauthorized {
            logout()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func login(username: String, password: String) async {
        busy = true
        defer { busy = false }
        do {
            let result = try await api.login(username: username.trimmingCharacters(in: .whitespaces).lowercased(), password: password)
            api.token = result.token
            Keychain.set(result.token, for: Self.tokenKey)
            await refresh()
            phase = api.token == nil ? .loggedOut : .ready
            resumeLocationSharingIfOn()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func logout() {
        location.stop()
        glasses.disconnect()
        // Capture the old token before clearing it; the async revocation must not
        // accidentally run without auth or revoke a subsequent login.
        if !DemoMode.isActive {
            let signedOutAPI = APIClient(baseURL: api.baseURL, token: api.token)
            Task { try? await signedOutAPI.logout() }
        }
        api.token = nil
        Keychain.delete(Self.tokenKey)
        me = nil
        locationSharing = nil
        phase = .loggedOut
        selectedTab = "claws"
    }

    private func synchronizeGlasses() {
        glasses.updateSession(token: api.token, username: me?.username,
                              clawId: selectedClaw?.clawId, demo: DemoMode.isActive)
    }

    func openPendingGlassesNotification() {
        guard me != nil, !DemoMode.isActive,
              let clawId = UserDefaults.standard.string(forKey: "glasses.notificationClawId") else { return }
        UserDefaults.standard.removeObject(forKey: "glasses.notificationClawId")
        guard let claw = claws.first(where: { $0.clawId == clawId }) else { return }
        select(claw: claw)
        selectedTab = "glasses"
    }

    private func applyServerURL() {
        guard let url = URL(string: serverURLString), url.scheme != nil else { return }
        api.baseURL = url
        UserDefaults.standard.set(serverURLString, forKey: Self.serverKey)
    }

    // MARK: location sharing

    var isSharingLocation: Bool { locationSharing?.consent == "given" }

    /// "Yes, my claws may know where I am": record consent, ask iOS, start the 5-minute loop.
    func enableLocationSharing() async {
        busy = true
        defer { busy = false }
        do {
            try await api.giveLocationConsent()
            locationSharing = try await api.locationSharing()
            location.requestPermission()
            startReporting()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func disableLocationSharing() async {
        busy = true
        defer { busy = false }
        location.stop()
        do {
            try await api.revokeLocationConsent()
            locationSharing = try await api.locationSharing()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func resumeLocationSharingIfOn() {
        if DemoMode.isActive { return }
        if isSharingLocation, location.isAuthorized { startReporting() }
    }

    private func startReporting() {
        let api = self.api
        location.start(interval: AppConfig.locationReportInterval) { fix in
            try await api.reportLocation(latitude: fix.coordinate.latitude,
                                         longitude: fix.coordinate.longitude,
                                         accuracyMeters: fix.horizontalAccuracy >= 0 ? fix.horizontalAccuracy : nil,
                                         reportedAt: fix.timestamp)
        }
    }

    func sendLocationNow() async {
        await location.flush(force: true)
        locationSharing = try? await api.locationSharing()
    }
}
