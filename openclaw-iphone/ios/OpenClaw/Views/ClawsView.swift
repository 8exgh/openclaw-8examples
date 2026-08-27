import SwiftUI

/// One conversation per claw.
struct ClawsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            Group {
                if model.claws.isEmpty {
                    EmptyClawsView()
                } else {
                    List(model.claws) { claw in
                        NavigationLink(value: claw) {
                            HStack(spacing: 12) {
                                Image(systemName: "pawprint.circle.fill")
                                    .font(.title)
                                    .foregroundStyle(.tint)
                                VStack(alignment: .leading) {
                                    Text(claw.displayName).font(.headline)
                                    Text(claw.clawId).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Your claws")
            .navigationDestination(for: ClawCard.self) { claw in
                ConversationView(claw: claw)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if let me = model.me { Text("Signed in as \(me.username)") }
                        Button("Sign out", role: .destructive) { model.logout() }
                    } label: { Image(systemName: "person.circle") }
                }
            }
            .refreshable { await model.refresh() }
        }
    }
}
