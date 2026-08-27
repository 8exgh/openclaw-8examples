import SwiftUI

/// The claw's phone number, tap-to-call, and tips for calls and SMS.
struct PhoneView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @State private var draft = ""

    var body: some View {
        NavigationStack {
            Group {
                if let claw = model.selectedClaw {
                    content(for: claw)
                } else {
                    EmptyClawsView()
                }
            }
            .navigationTitle("Phone")
            .toolbar { ClawPicker() }
        }
    }

    private func tips(for claw: ClawCard) -> [String] {
        let number = claw.phoneNumber ?? "its number"
        return [
            "Check my SMS every 15 minutes and tell me about anything important.",
            "Phone 555-555-1234 and reserve the next available appointment for me.",
            "Call \(number) while you drive — just talk to your claw hands-free.",
            "Text me a reminder 30 minutes before every appointment tomorrow.",
            "Call the pharmacy and ask if my prescription is ready.",
            "If anyone texts you asking for me, reply that I'll get back to them today.",
        ]
    }

    private func content(for claw: ClawCard) -> some View {
        VStack(spacing: 0) {
            List {
                Section("\(claw.displayName)'s number") {
                    if let number = claw.phoneNumber {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(claw.phoneNumberPretty ?? number)
                                .font(.title2.monospacedDigit()).bold()
                                .lineLimit(1).minimumScaleFactor(0.7)
                            HStack {
                                Button {
                                    if let url = URL(string: "tel:\(number)") { openURL(url) }
                                } label: { Label("Call", systemImage: "phone.fill") }
                                .buttonStyle(.borderedProminent)
                                Button {
                                    if let url = URL(string: "sms:\(number)") { openURL(url) }
                                } label: { Label("Text", systemImage: "message.fill") }
                                .buttonStyle(.bordered)
                            }
                        }
                        Text("Save it in your contacts — you can call or text your claw like a person, and it answers.")
                            .font(.footnote).foregroundStyle(.secondary)
                    } else {
                        Text("No number yet. Ask \(claw.displayName) below: “register a phone number for yourself”.")
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Things to try") {
                    ForEach(tips(for: claw), id: \.self) { tip in
                        TipRow(text: tip) { draft = $0 }
                    }
                }
            }
            .frame(maxHeight: 420)
            .mask(
                LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: 0.9), .init(color: .clear, location: 1)],
                               startPoint: .top, endPoint: .bottom)
            )

            Divider()
            ConversationView(claw: claw, suggestions: ["Check my texts", "Who called today?"], draft: $draft)
        }
    }
}
