import SwiftUI

/// Design-your-website page: shows the domain + fusenv subdomain, opens the live
/// site in Safari, gives editing hints, and chats with the claw to make edits.
struct WebsiteView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @State private var draft = ""

    private let tips = [
        "Change the headline on my homepage to “Fresh bread, baked at 6am”.",
        "Add a Prices page with my three most popular services.",
        "Put my phone number and opening hours in the footer.",
        "Add a contact form that emails me.",
        "Make the colours warmer and the text bigger on mobile.",
        "Add an FAQ with the 5 questions customers always ask me.",
    ]

    var body: some View {
        NavigationStack {
            Group {
                if let claw = model.selectedClaw {
                    content(for: claw)
                } else {
                    EmptyClawsView()
                }
            }
            .navigationTitle("Your website")
            .toolbar { ClawPicker() }
        }
    }

    private func content(for claw: ClawCard) -> some View {
        VStack(spacing: 0) {
            List {
                Section("Your addresses") {
                    if let site = claw.website {
                        if let domain = site.domain, let url = URL(string: site.url) {
                            LabeledContent("Domain") {
                                Button(domain) { openURL(url) }   // opens in Safari
                            }
                        }
                        if let url = URL(string: site.fusenvUrl) {
                            LabeledContent("fusenv") {
                                Button("\(site.fusenvSubdomain).fusenv.com") { openURL(url) }
                            }
                        }
                        Button {
                            if let url = URL(string: site.url) { openURL(url) }
                        } label: { Label("Open in Safari", systemImage: "safari") }
                    } else {
                        Text("No website yet — ask \(claw.displayName) below to build one and it'll get a fusenv.com address.")
                            .foregroundStyle(.secondary)
                    }
                }

                Section("How to change it") {
                    Text("Just tell \(claw.displayName) what to change, in plain words. Your assistant edits the site, and the change goes live within a couple of minutes. Tap a tip to use it:")
                        .font(.footnote).foregroundStyle(.secondary)
                    ForEach(tips, id: \.self) { tip in
                        TipRow(text: tip) { draft = $0 }
                    }
                }
            }
            .frame(maxHeight: 360)
            .mask(
                LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: 0.9), .init(color: .clear, location: 1)],
                               startPoint: .top, endPoint: .bottom)
            )

            Divider()
            ConversationView(claw: claw, suggestions: ["Show me what my site looks like now", "What should I add next?"], draft: $draft)
        }
    }
}
