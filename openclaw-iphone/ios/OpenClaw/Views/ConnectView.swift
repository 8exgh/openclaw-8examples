import SwiftUI

/// Other ways to reach your assistant: a Telegram bot and the Alexa "My Claw" skill.
struct ConnectView: View {
    @Environment(AppModel.self) private var model
    @State private var path: [String] = ["alexa", "telegram"].contains(DemoMode.screen ?? "") ? [DemoMode.screen!] : []

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section("Reach your assistant from…") {
                    NavigationLink(value: "telegram") {
                        Label("Telegram", systemImage: "paperplane.fill")
                    }
                    NavigationLink(value: "alexa") {
                        Label("Amazon Alexa — “My Claw”", systemImage: "waveform.circle.fill")
                    }
                }
                Section("Also") {
                    Link(destination: AppConfig.webChatURL) {
                        Label("Web chat (chat.8examples.com)", systemImage: "safari")
                    }
                    Text("Same username and password as this app.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Connect")
            .toolbar { ClawPicker() }
            .navigationDestination(for: String.self) { screen in
                if screen == "alexa" { AlexaView() } else { TelegramView() }
            }
        }
    }
}

// MARK: - Telegram

struct TelegramView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL

    var body: some View {
        List {
            if let claw = model.selectedClaw {
                Section {
                    if let bot = claw.telegramBotUsername {
                        LabeledContent("Your bot", value: "@\(bot)")
                        Button {
                            if let url = URL(string: "https://t.me/\(bot)") { openURL(url) }
                        } label: { Label("Open @\(bot) in Telegram", systemImage: "paperplane") }
                    } else {
                        Text("\(claw.displayName) isn't on Telegram yet. Five minutes, no coding:")
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Section("Set up a Telegram bot for your assistant") {
                Step(1, "Install Telegram on this phone and sign in.")
                Step(2, "In Telegram, search for **BotFather** (blue checkmark) and open it.")
                Step(3, "Send **/newbot**. Give it a name (e.g. “Ana's Claw”) and a username ending in **bot** (e.g. `anas_claw_bot`).")
                Step(4, "BotFather replies with a **token** like `123456:ABC-…`. Copy it.")
                Step(5, "Come back to this app, open the **Assistants** tab and paste the token to your assistant: “here is my Telegram bot token: …”. It connects itself.")
                Step(6, "In Telegram, open your new bot and press **Start**. Say hi — that's your assistant.")
            }

            Section("Good to know") {
                Text("Only you can talk to your bot: your assistant remembers the first Telegram account that says hi and ignores strangers. Anything you tell it on Telegram, in this app, or on the phone is the same assistant with the same memory.")
                    .font(.footnote).foregroundStyle(.secondary)
                Button {
                    if let url = URL(string: "https://t.me/BotFather") { openURL(url) }
                } label: { Label("Open BotFather", systemImage: "arrow.up.right.square") }
            }
        }
        .navigationTitle("Telegram")
    }
}

// MARK: - Alexa

struct AlexaView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text("“Alexa, ask My Claw what's on my calendar today.”")
                        .font(.headline)
                    Text("The **My Claw** skill lives in the Alexa Skills store under **Productivity**. Enable it once, link it to this account, and every Echo in the house can talk to your assistant.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
                Button {
                    openURL(AppConfig.alexaSkillStoreURL)
                } label: { Label("Open “My Claw” in the Alexa Skills store", systemImage: "arrow.up.right.square") }
                Button {
                    openURL(AppConfig.alexaAppURL) { accepted in
                        if !accepted { openURL(URL(string: "https://apps.apple.com/app/amazon-alexa/id944011620")!) }
                    }
                } label: { Label("Open the Alexa app", systemImage: "app.badge") }
            }

            Section("Pair it (once)") {
                Step(1, "Open the **Amazon Alexa** app on this phone (install it from the App Store if needed).")
                Step(2, "Tap **More → Skills & Games**, search **My Claw**, or browse **Categories → Productivity**.")
                Step(3, "Tap **Enable to Use**.")
                Step(4, "When asked to **Link Account**, sign in with the same username and password as this app (\(model.me?.username ?? "your openclaw login")).")
                Step(5, "Done — the skill is now paired with your assistant\(model.claws.count > 1 ? "s" : "").")
            }

            Section("Ask for it on any Alexa device") {
                Step(1, "Say **“Alexa, open My Claw.”** — then talk normally.")
                Step(2, "Or in one breath: **“Alexa, ask My Claw to call the dentist and book a cleaning.”**")
                Step(3, "**“Alexa, tell My Claw I'm leaving now.”** — handy with location sharing on.")
                Step(4, "**“Alexa, ask My Claw what's new.”** — your assistant reads out anything waiting for you.")
            }

            Section("Troubleshooting") {
                Text("If Alexa says the skill isn't linked, open the Alexa app → More → Skills & Games → Your Skills → My Claw → Settings → Link Account and sign in again.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Amazon Alexa")
    }
}

/// Numbered instruction row; the text supports Markdown bold/code.
struct Step: View {
    let number: Int
    let text: LocalizedStringKey

    init(_ number: Int, _ text: LocalizedStringKey) {
        self.number = number
        self.text = text
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(number)")
                .font(.caption.bold())
                .frame(width: 22, height: 22)
                .background(Circle().fill(Color.accentColor))
                .foregroundStyle(.white)
            Text(text)
                .font(.subheadline)
        }
        .padding(.vertical, 2)
    }
}
