import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.phase {
        case .loading:
            ProgressView("Loading…")
        case .loggedOut:
            LoginView()
        case .ready:
            MainTabView()
        }
    }
}

struct MainTabView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TabView {
            ClawsView()
                .tabItem { Label("Claws", systemImage: "bubble.left.and.bubble.right") }
            LocationView()
                .tabItem { Label("Location", systemImage: "location") }
            WebsiteView()
                .tabItem { Label("Website", systemImage: "globe") }
            PhoneView()
                .tabItem { Label("Phone", systemImage: "phone") }
            ConnectView()
                .tabItem { Label("Connect", systemImage: "link") }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.refresh() } }
        }
    }
}

/// Picks which claw a page is about. Hidden when the person has only one.
struct ClawPicker: ToolbarContent {
    @Environment(AppModel.self) private var model

    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            if model.claws.count > 1, let selected = model.selectedClaw {
                Menu {
                    ForEach(model.claws) { claw in
                        Button(claw.displayName) { model.select(claw: claw) }
                    }
                } label: {
                    Label(selected.displayName, systemImage: "chevron.down")
                        .labelStyle(.titleAndIcon)
                }
            }
        }
    }
}

/// A "tip" row: tapping copies the suggested message into the chat below.
struct TipRow: View {
    let text: String
    let onUse: (String) -> Void

    var body: some View {
        Button { onUse(text) } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "lightbulb")
                    .foregroundStyle(.yellow)
                Text("“\(text)”")
                    .font(.subheadline)
                    .multilineTextAlignment(.leading)
                    .foregroundStyle(.primary)
                Spacer(minLength: 0)
                Image(systemName: "arrow.down.circle")
                    .foregroundStyle(.secondary)
            }
        }
        .buttonStyle(.plain)
    }
}

struct EmptyClawsView: View {
    var body: some View {
        ContentUnavailableView(
            "No claw assigned yet",
            systemImage: "questionmark.circle",
            description: Text("Your account isn't linked to an OpenClaw assistant. Ask the operator to assign one.")
        )
    }
}
