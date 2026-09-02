import SwiftUI

/// Chat with one claw. Owner messages are commands; replies arrive when the
/// background processor has run the claw, so the view polls while visible.
struct ConversationView: View {
    @Environment(AppModel.self) private var model
    let claw: ClawCard
    /// Optional canned prompts shown above the composer (Website / Phone pages).
    var suggestions: [String] = []
    /// A message a parent page wants dropped into the composer.
    @Binding var draft: String

    @State private var messages: [ConversationMessage] = []
    @State private var sending = false
    @State private var error: String?

    init(claw: ClawCard, suggestions: [String] = [], draft: Binding<String>? = nil) {
        self.claw = claw
        self.suggestions = suggestions
        self._draft = draft ?? .constant("")
        self._localDraft = State(initialValue: "")
    }

    @State private var localDraft: String

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 10) {
                        if messages.isEmpty {
                            Text("Say hi to \(claw.displayName). Replies usually take a few seconds.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .padding(.top, 40)
                        }
                        ForEach(messages) { message in
                            MessageBubble(message: message).id(message.id)
                        }
                    }
                    .padding()
                }
                .onChange(of: messages.count) { _, _ in
                    if let last = messages.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                }
            }

            if let error {
                Text(error).font(.caption).foregroundStyle(.red).padding(.horizontal)
            }

            if !suggestions.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(suggestions, id: \.self) { s in
                            Button(s) { localDraft = s }
                                .buttonStyle(.bordered)
                                .font(.caption)
                        }
                    }
                    .padding(.horizontal)
                }
                .padding(.bottom, 4)
            }

            HStack(alignment: .bottom) {
                TextField("Message \(claw.displayName)…", text: $localDraft, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.roundedBorder)
                Button {
                    Task { await send() }
                } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.title)
                }
                .disabled(localDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
            }
            .padding()
        }
        .navigationTitle(claw.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: claw.clawId) { await pollLoop() }
        .onChange(of: draft) { _, new in
            if !new.isEmpty { localDraft = new; draft = "" }
        }
    }

    private func pollLoop() async {
        while !Task.isCancelled {
            await load()
            let awaiting = messages.contains { $0.isOwner && $0.status == "awaiting-reply" }
            try? await Task.sleep(for: .seconds(awaiting ? 2 : 6))
        }
    }

    private func load() async {
        do {
            messages = try await model.api.conversation(clawId: claw.clawId).messages
            error = nil
        } catch APIError.unauthorized {
            model.logout()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func send() async {
        let text = localDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        sending = true
        defer { sending = false }
        do {
            try await model.api.sendMessage(clawId: claw.clawId, messageId: UUID().uuidString.lowercased(), text: text)
            localDraft = ""
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct MessageBubble: View {
    let message: ConversationMessage

    var body: some View {
        HStack {
            if message.isOwner { Spacer(minLength: 40) }
            VStack(alignment: message.isOwner ? .trailing : .leading, spacing: 4) {
                Text(message.text)
                    .padding(10)
                    .background(message.isOwner ? Color.accentColor : Color(.secondarySystemBackground))
                    .foregroundStyle(message.isOwner ? .white : .primary)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                HStack(spacing: 4) {
                    Text(message.date, style: .time)
                    if message.isOwner {
                        switch message.status {
                        case "awaiting-reply": Image(systemName: "clock")
                        case "failed": Label("Couldn't reach your assistant", systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                        default: Image(systemName: "checkmark")
                        }
                    }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
            if !message.isOwner { Spacer(minLength: 40) }
        }
    }
}
