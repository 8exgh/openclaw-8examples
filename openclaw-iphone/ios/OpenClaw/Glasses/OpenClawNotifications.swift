import UIKit
import UserNotifications

extension Notification.Name {
    static let glassesPushToken = Notification.Name("glassesPushToken")
    static let glassesNotification = Notification.Name("glassesNotification")
    static let glassesNotificationOpened = Notification.Name("glassesNotificationOpened")
}

/// Push notifications belong to the existing OpenClaw application and bundle id.
final class OpenClawNotifications: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
        let value = token.map { String(format: "%02x", $0) }.joined()
        let changed = value != UserDefaults.standard.string(forKey: "glasses.pushToken")
        UserDefaults.standard.set(value, forKey: "glasses.pushToken")
        if changed { NotificationCenter.default.post(name: .glassesPushToken, object: nil) }
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .glassesPushToken, object: nil, userInfo: ["error": error.localizedDescription])
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completion: @escaping (UNNotificationPresentationOptions) -> Void) {
        NotificationCenter.default.post(name: .glassesNotification, object: nil, userInfo: notification.request.content.userInfo)
        completion([.banner])
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completion: @escaping () -> Void) {
        if let clawId = response.notification.request.content.userInfo["clawId"] as? String {
            // Retain a cold-launch tap until the main app has loaded the owner's claws.
            UserDefaults.standard.set(clawId, forKey: "glasses.notificationClawId")
            NotificationCenter.default.post(name: .glassesNotificationOpened, object: nil)
        }
        completion()
    }
}
