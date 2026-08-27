import CoreLocation
import Foundation
import Observation

/// Keeps Core Location running (foreground and background, via the `location`
/// background mode) and hands the newest fix to the backend every 5 minutes.
/// Nothing is sent until the person has said yes in the app AND granted the
/// system permission.
@MainActor
@Observable
final class LocationReporter: NSObject, CLLocationManagerDelegate {
    private(set) var authorization: CLAuthorizationStatus
    private(set) var lastFix: CLLocation?
    private(set) var lastSentAt: Date?
    private(set) var lastError: String?

    private let manager = CLLocationManager()
    private var timer: Timer?
    private var send: (@Sendable (CLLocation) async throws -> Void)?
    private var sending = false

    override init() {
        authorization = manager.authorizationStatus
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.distanceFilter = 50
        manager.pausesLocationUpdatesAutomatically = false
        manager.showsBackgroundLocationIndicator = true
    }

    var isAuthorized: Bool {
        authorization == .authorizedAlways || authorization == .authorizedWhenInUse
    }

    var isDenied: Bool {
        authorization == .denied || authorization == .restricted
    }

    /// Ask the system. When-in-use first; iOS offers the "Always" upgrade later.
    func requestPermission() {
        if authorization == .notDetermined {
            manager.requestWhenInUseAuthorization()
        } else if authorization == .authorizedWhenInUse {
            manager.requestAlwaysAuthorization()
        }
    }

    /// Start reporting; `send` is invoked with the latest fix every `interval`.
    func start(interval: TimeInterval, send: @escaping @Sendable (CLLocation) async throws -> Void) {
        self.send = send
        if authorization == .authorizedAlways { manager.allowsBackgroundLocationUpdates = true }
        manager.startUpdatingLocation()
        manager.startMonitoringSignificantLocationChanges()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.flush() }
        }
        Task { await flush(force: true) }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        send = nil
        manager.stopUpdatingLocation()
        manager.stopMonitoringSignificantLocationChanges()
        manager.allowsBackgroundLocationUpdates = false
    }

    /// Send the newest fix now (used by the timer and by "Send now").
    func flush(force: Bool = false) async {
        guard let send, let fix = lastFix ?? manager.location, !sending else { return }
        if !force, let lastSentAt, Date().timeIntervalSince(lastSentAt) < 60 { return }
        sending = true
        defer { sending = false }
        do {
            try await send(fix)
            lastSentAt = Date()
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    // MARK: CLLocationManagerDelegate

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            self.authorization = status
            if status == .authorizedAlways, self.send != nil { manager.allowsBackgroundLocationUpdates = true }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let newest = locations.last else { return }
        Task { @MainActor in
            let first = self.lastFix == nil
            self.lastFix = newest
            if first { await self.flush(force: true) }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in self.lastError = error.localizedDescription }
    }
}
