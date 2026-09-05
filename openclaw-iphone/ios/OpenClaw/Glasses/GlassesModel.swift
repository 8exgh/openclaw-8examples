import Combine
import Foundation
import UIKit
import UserNotifications

/// Feature state only. AppModel owns sign-in, the session token and assistant selection.
@MainActor
final class GlassesModel: ObservableObject {
    @Published private(set) var profile: GlassesProfile?
    @Published private(set) var events: [GlassesSummaryEvent] = []
    @Published private(set) var busy = false
    @Published private(set) var connecting = false
    @Published private(set) var pending: GlassesPendingRequest?
    @Published private(set) var selectedClaw = ""
    @Published private(set) var relayAddress: String
    @Published private(set) var notice = ""
    @Published private(set) var notificationsEnabled: Bool
    @Published var readNewSummaries = true
    let voice = GlassesAudio()
    var onAuthenticationFailure: (() -> Void)?

    private var owner: (token: String, username: String)?
    private var api: GlassesAPI?
    private var cursor: Int64?
    private var refreshID: UUID?
    private var epoch = UUID()
    private var inForeground = true
    private var observers: [NSObjectProtocol] = []
    private let defaults: UserDefaults
    private let makeClient: (GlassesSession) -> GlassesAPI
    private let installationId: String
    private var connectionTask: Task<Void, Never>?
    private var registerID: UUID?

    init(defaults: UserDefaults = .standard,
         makeClient: @escaping (GlassesSession) -> GlassesAPI = { GlassesAPI(session: $0) }) {
        self.defaults = defaults
        self.makeClient = makeClient
        relayAddress = defaults.string(forKey: "glasses.relayURL") ?? AppConfig.defaultGlassesRelayURL
        notificationsEnabled = defaults.bool(forKey: "glasses.notificationsEnabled")
        if let id = defaults.string(forKey: "glasses.installationId") { installationId = id }
        else {
            installationId = UUID().uuidString
            defaults.set(installationId, forKey: "glasses.installationId")
        }
        voice.onRequest = { [weak self] text in
            guard let self else { return }
            let capturedEpoch = self.epoch
            Task { @MainActor [weak self] in
                guard let self, self.epoch == capturedEpoch else { return }
                await self.send(text)
            }
        }
        observers.append(NotificationCenter.default.addObserver(forName: .glassesPushToken, object: nil, queue: .main) { [weak self] note in
            let error = note.userInfo?["error"] as? String
            Task { @MainActor in
                guard let self, self.owner != nil else { return }
                if let error { self.notice = "Notification registration failed: \(error)" }
                else { await self.registerPush() }
            }
        })
        observers.append(NotificationCenter.default.addObserver(forName: .glassesNotification, object: nil, queue: .main) { [weak self] _ in
            // Receiving a notification does not switch the shared selected assistant.
            Task { @MainActor in await self?.refresh() }
        })
    }

    var isConnected: Bool { profile != nil && profile!.claws.contains { $0.clawId == selectedClaw } }
    var hasConfiguration: Bool { !relayAddress.isEmpty }

    /// Called after the app validates its existing login, and whenever its picker changes.
    func updateSession(token: String?, username: String?, clawId: String?, demo: Bool = false) {
        guard !demo else { return }
        guard let token, let username, let clawId else { disconnect(); return }
        let ownerChanged = owner?.token != token || owner?.username != username
        if ownerChanged {
            resetConnection()
            owner = (token, username)
        }
        if selectedClaw != clawId {
            connectionTask?.cancel()
            voice.stop()
            selectedClaw = clawId
            events = []; cursor = nil; refreshID = nil; epoch = UUID(); connecting = false; busy = false
            pending = pendingRequest()
        }
        if ownerChanged || (api == nil && !connecting) {
            connectionTask?.cancel()
            connectionTask = Task { [weak self] in
                guard !Task.isCancelled else { return }
                await self?.connect()
            }
        }
    }

    func configure(address: String) async {
        guard !busy, !connecting else { return }
        do {
            let url = try GlassesAPI.secureURL(address)
            if url.absoluteString != relayAddress {
                // Stop the old subscription before changing where we send its session.
                if let api, notificationsEnabled { try await api.unregister(installationId: installationId) }
                resetConnection()
                relayAddress = url.absoluteString
                defaults.set(relayAddress, forKey: "glasses.relayURL")
            }
            await connect()
        } catch { notice = error.localizedDescription }
    }

    func connect() async {
        guard let owner, !selectedClaw.isEmpty, !connecting else { return }
        guard hasConfiguration else { notice = "Set up the glasses connection to begin."; return }
        let currentEpoch = epoch
        connecting = true
        defer { if currentEpoch == epoch { connecting = false } }
        do {
            let session = GlassesSession(token: owner.token, relayURL: try GlassesAPI.secureURL(relayAddress), username: owner.username)
            let client = makeClient(session)
            let result = try await client.me()
            guard currentEpoch == epoch, !Task.isCancelled else { return }
            guard result.username == owner.username, result.claws.contains(where: { $0.clawId == selectedClaw }) else {
                throw GlassesError.http(403, "This relay does not have access to your selected assistant.")
            }
            api = client; profile = result; pending = pendingRequest()
            notice = "Connected with your existing app account."
            await refresh()
            await registerPush()
        } catch { if currentEpoch == epoch { handle(error) } }
    }

    /// Ends glasses activity immediately. The parent app separately revokes its shared login.
    func disconnect() {
        let oldAPI = api
        let wasSubscribed = notificationsEnabled
        resetConnection()
        owner = nil; selectedClaw = ""; pending = nil
        notificationsEnabled = false
        defaults.set(false, forKey: "glasses.notificationsEnabled")
        if let oldAPI, wasSubscribed {
            let installationId = self.installationId
            Task { try? await oldAPI.unregister(installationId: installationId) }
        }
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    }

    private func resetConnection() {
        connectionTask?.cancel()
        voice.stop()
        api = nil; profile = nil; events = []; cursor = nil; pending = nil
        epoch = UUID(); refreshID = nil; registerID = nil; busy = false; connecting = false
    }

    func sceneActive(_ active: Bool) async {
        inForeground = active
        if active { await refresh(); await registerPush() }
    }
    func poll() async {
        while !Task.isCancelled {
            if inForeground || voice.active { await refresh() }
            do { try await Task.sleep(for: .seconds(4)) } catch { return }
        }
    }
    func refresh() async {
        guard let api, isConnected, refreshID == nil else { return }
        let currentEpoch = epoch, claw = selectedClaw, previousCursor = cursor, id = UUID()
        refreshID = id
        defer { if refreshID == id { refreshID = nil } }
        do {
            let inbox = try await api.events(clawId: claw, after: previousCursor)
            guard currentEpoch == epoch, selectedClaw == claw else { return }
            let known = Set(events.map(\.id))
            let fresh = inbox.events.filter { !known.contains($0.id) }
            events = Array((events + fresh).sorted { $0.seq < $1.seq }.suffix(300))
            cursor = inbox.cursor
            if previousCursor != nil, readNewSummaries, voice.active {
                for event in fresh { voice.speak(event.summary) }
            }
        } catch { if currentEpoch == epoch { handle(error) } }
    }

    // Drafts use the existing Keychain service, scoped to the account, relay and assistant.
    private var pendingKey: String {
        "glasses.pending:\(owner?.username ?? ""):\(relayAddress):\(selectedClaw)"
    }
    private func pendingRequest() -> GlassesPendingRequest? {
        guard owner != nil, !selectedClaw.isEmpty else { return nil }
        return Keychain.load(pendingKey, as: GlassesPendingRequest.self)
    }
    func send(_ text: String) async {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isConnected, !text.isEmpty, !busy else { return }
        guard pending == nil else {
            notice = "Retry the saved request first. Its delivery has not been confirmed."
            voice.speak(notice); return
        }
        let request = GlassesPendingRequest(requestId: UUID().uuidString, clawId: selectedClaw, text: text)
        do {
            try Keychain.save(request, account: pendingKey)
            pending = request
            await retry()
        } catch { notice = error.localizedDescription }
    }
    func retry() async {
        guard let api, let request = pending, isConnected, !busy else { return }
        let currentEpoch = epoch, key = pendingKey
        busy = true
        defer { if currentEpoch == epoch { busy = false } }
        do {
            let receipt = try await api.send(request)
            // A late reply belongs to the old assistant/account. It can clear only that draft.
            Keychain.delete(key)
            guard currentEpoch == epoch else { return }
            pending = nil
            notice = receipt.status == "queued" || receipt.status == "running" ? "Request received. The result will appear here." : "This request has already finished. Check the summary inbox."
            voice.speak(notice)
            await refresh()
        } catch { if currentEpoch == epoch { handle(error) } }
    }

    func setNotifications(_ enabled: Bool) async {
        guard let api else { return }
        let currentEpoch = epoch
        do {
            if enabled {
                guard profile?.pushEnabled == true else { throw GlassesError.http(503, "Notifications need to be configured on the glasses backend.") }
                let allowed = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
                guard currentEpoch == epoch else { return }
                guard allowed else { throw GlassesError.http(403, "Allow notifications for this app in iPhone Settings.") }
                notificationsEnabled = true
                defaults.set(true, forKey: "glasses.notificationsEnabled")
                await registerPush()
            } else {
                try await api.unregister(installationId: installationId)
                guard currentEpoch == epoch else { return }
                notificationsEnabled = false
                defaults.set(false, forKey: "glasses.notificationsEnabled")
                UNUserNotificationCenter.current().removeAllDeliveredNotifications()
            }
        } catch { if currentEpoch == epoch { notice = error.localizedDescription } }
    }
    private func registerPush() async {
        guard notificationsEnabled, let api, isConnected, profile?.pushEnabled == true, registerID == nil else { return }
        UIApplication.shared.registerForRemoteNotifications()
        guard let token = defaults.string(forKey: "glasses.pushToken") else { return }
        let id = UUID(), currentEpoch = epoch
        registerID = id
        defer { if registerID == id { registerID = nil } }
        do { try await api.register(installationId: installationId, token: token) }
        catch { if currentEpoch == epoch { handle(error) } }
    }
    private func handle(_ error: Error) {
        if case GlassesError.http(let code, _) = error, code == 401 {
            voice.stop(); profile = nil
            notice = "Could not verify your app session with the glasses backend. Reconnect after checking your account."
            // Let AppModel verify the main account before deciding whether to sign out.
            onAuthenticationFailure?()
        } else { notice = error.localizedDescription }
    }
}
