import SwiftUI

@main
struct OpenClawApp: App {
    @UIApplicationDelegateAdaptor(OpenClawNotifications.self) private var notifications
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .task { await model.bootstrap() }
                .task { await model.glasses.poll() }
                .onChange(of: scenePhase) { _, phase in
                    Task { await model.glasses.sceneActive(phase == .active) }
                }
                .onReceive(NotificationCenter.default.publisher(for: .glassesNotificationOpened)) { _ in
                    model.openPendingGlassesNotification()
                }
        }
    }
}
