import CoreLocation
import MapKit
import SwiftUI

/// The consent page: "Can your claw(s) know where you are?" Once yes, the phone
/// reports its position every 5 minutes; a claw asks the backend when it needs it.
struct LocationView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Can your assistants know where you are?")
                            .font(.headline)
                        Text("If you say yes, this phone sends its latitude and longitude to your assigned assistants every 5 minutes — even in the background. They use it for things like \"what's open near me\", \"how far am I from home\", or \"text my wife my ETA\".")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Text(clawNames)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)

                    if model.isSharingLocation {
                        Button(role: .destructive) {
                            Task { await model.disableLocationSharing() }
                        } label: { Label("Stop sharing my location", systemImage: "location.slash") }
                        .disabled(model.busy)
                    } else {
                        Button {
                            Task { await model.enableLocationSharing() }
                        } label: { Label("Yes — share my location every 5 minutes", systemImage: "location.fill") }
                        .disabled(model.busy || model.claws.isEmpty)
                    }
                }

                if model.isSharingLocation {
                    Section("Permission") {
                        permissionRow
                    }

                    Section("Last sent to your assistants") {
                        if let latest = model.locationSharing?.latest {
                            Map(initialPosition: .region(MKCoordinateRegion(
                                center: CLLocationCoordinate2D(latitude: latest.latitude, longitude: latest.longitude),
                                span: MKCoordinateSpan(latitudeDelta: 0.02, longitudeDelta: 0.02)))) {
                                Marker("You", coordinate: CLLocationCoordinate2D(latitude: latest.latitude, longitude: latest.longitude))
                            }
                            .frame(height: 180)
                            .listRowInsets(EdgeInsets())
                            LabeledContent("Coordinates", value: String(format: "%.5f, %.5f", latest.latitude, latest.longitude))
                            LabeledContent("Reported") { Text(latest.reportedDate, style: .relative) + Text(" ago") }
                            if let acc = latest.accuracyMeters {
                                LabeledContent("Accuracy", value: "±\(Int(acc)) m")
                            }
                            if model.locationSharing?.lapsed == true {
                                Label("Your assistants see this as stale — no update in over 15 minutes.", systemImage: "exclamationmark.triangle")
                                    .font(.footnote).foregroundStyle(.orange)
                            }
                        } else {
                            Text("Nothing sent yet.").foregroundStyle(.secondary)
                        }
                        Button("Send my location now") { Task { await model.sendLocationNow() } }
                            .disabled(!model.location.isAuthorized)
                        if let error = model.location.lastError {
                            Text(error).font(.caption).foregroundStyle(.red)
                        }
                    }
                }

                Section("Privacy") {
                    Text("Only your own assigned assistants can ask for your location, and only the most recent position is kept. Say no or stop sharing at any time and the last position is forgotten.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Location")
            .refreshable { await model.refresh() }
        }
    }

    private var clawNames: String {
        let names = model.claws.map(\.displayName)
        switch names.count {
        case 0: return "No assistant assigned yet."
        case 1: return "Shared with \(names[0])."
        default: return "Shared with \(names.joined(separator: ", "))."
        }
    }

    @ViewBuilder private var permissionRow: some View {
        switch model.location.authorization {
        case .authorizedAlways:
            Label("Always — works in the background", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        case .authorizedWhenInUse:
            Label("Only while using the app", systemImage: "exclamationmark.circle").foregroundStyle(.orange)
            Text("For the 5-minute background updates, allow “Always” in Settings.").font(.footnote).foregroundStyle(.secondary)
            Button("Allow Always…") { model.location.requestPermission() }
            openSettingsButton
        case .denied, .restricted:
            Label("Location access is off for 8Examples AI Assistant", systemImage: "xmark.circle").foregroundStyle(.red)
            openSettingsButton
        default:
            Button("Allow location access…") { model.location.requestPermission() }
        }
    }

    private var openSettingsButton: some View {
        Button("Open Settings") {
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        }
    }
}
