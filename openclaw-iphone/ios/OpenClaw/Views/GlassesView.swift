import SwiftUI

struct GlassesView: View {
    @Environment(AppModel.self) private var app
    var body: some View {
        NavigationStack {
            if let claw = app.selectedClaw {
                GlassesContent(model: app.glasses, voice: app.glasses.voice, assistantName: claw.displayName)
                    .navigationTitle("Glasses")
                    .toolbar { ClawPicker() }
            } else { EmptyClawsView() }
        }
    }
}

private struct GlassesContent: View {
    @ObservedObject var model: GlassesModel
    @ObservedObject var voice: GlassesAudio
    let assistantName: String
    @State private var draft = ""
    @State private var showingSettings = false

    var body: some View {
        List {
            Section {
                LabeledContent("Assistant", value: assistantName)
                Text("Speak a request through your glasses and hear the result. Your existing app account connects you.")
                    .foregroundStyle(.secondary)
                if DemoMode.isActive {
                    Text("Glasses connections are off in screenshot mode.")
                } else if model.connecting {
                    ProgressView("Connecting…")
                } else if !model.hasConfiguration {
                    Button("Set up glasses connection") { showingSettings = true }
                } else if !model.isConnected {
                    Button("Reconnect glasses backend") { Task { await model.connect() } }
                }
                if !model.notice.isEmpty { Text(model.notice).font(.callout).foregroundStyle(.secondary) }
            }
            if model.isConnected {
                Section("Talk through your glasses") {
                    Label(voice.status, systemImage: voice.active ? "waveform" : "eyeglasses")
                        .font(.headline).accessibilityAddTraits(.updatesFrequently)
                    if !voice.active {
                        Button("Find connected glasses") { voice.findGlasses() }
                        if !voice.inputs.isEmpty {
                            Picker("Microphone", selection: $voice.selectedInput) {
                                Text("Choose glasses").tag("")
                                ForEach(voice.inputs) { input in Text(input.name).tag(input.id) }
                            }
                        }
                        Toggle("Use phone microphone for testing", isOn: $voice.usePhoneMicrophone)
                    }
                    Button {
                        if voice.active { voice.stop() } else { Task { await voice.start() } }
                    } label: {
                        Label(voice.active ? "Stop session" : "Start listening session", systemImage: voice.active ? "stop.circle.fill" : "mic.circle.fill")
                            .font(.title3.weight(.semibold))
                    }
                    if !voice.transcript.isEmpty { Text(voice.transcript).foregroundStyle(.secondary) }
                    Text("After starting, say “OpenClaw, …” and your request. Say “OpenClaw, stop listening” to finish. Sessions last up to 15 minutes.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Requests and summaries") {
                    Toggle("Read new summaries during a session", isOn: $model.readNewSummaries)
                    Toggle("Notify me when work is done", isOn: Binding(get: { model.notificationsEnabled }, set: { enabled in
                        Task { await model.setNotifications(enabled) }
                    }))
                    if model.profile?.pushEnabled == false {
                        Text("Notifications need to be enabled on the glasses backend. Your inbox and spoken replies are available.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    TextField("Type a request", text: $draft, axis: .vertical).lineLimit(2...5)
                    Button("Send to assistant") {
                        let text = draft
                        Task { await model.send(text); if model.pending == nil { draft = "" } }
                    }.disabled(model.busy || model.pending != nil || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if let pending = model.pending {
                        Text(pending.text).font(.callout)
                        Button("Retry saved request") { Task { await model.retry() } }.disabled(model.busy)
                        Text("Your saved request will be checked before starting any new work.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section("Summary inbox") {
                    if model.events.isEmpty { Text("Completed work and replies will appear here.").foregroundStyle(.secondary) }
                    ForEach(model.events.reversed()) { event in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(event.kind == "uncertain" ? "Outcome needs checking" : event.kind == "failed" ? "Request not started" : "Assistant update")
                                    .font(.caption.weight(.semibold)).foregroundStyle(event.kind == "uncertain" ? Color.orange : Color.secondary)
                                Spacer()
                                Text(event.date, style: .time).font(.caption).foregroundStyle(.secondary)
                            }
                            Text(event.summary)
                            if event.text != event.summary { DisclosureGroup("Full reply") { Text(event.text).textSelection(.enabled) } }
                            Button { voice.speak(event.summary) } label: { Label("Read through glasses", systemImage: "speaker.wave.2") }
                                .disabled(!voice.active)
                        }.padding(.vertical, 6)
                    }
                }
            }
        }
        .refreshable { await model.refresh() }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { showingSettings = true } label: { Image(systemName: "gearshape").accessibilityLabel("Glasses connection settings") }
                    .disabled(DemoMode.isActive)
            }
        }
        .sheet(isPresented: $showingSettings) { GlassesConnectionSettings(model: model) }
        .onChange(of: model.selectedClaw) { _, _ in draft = "" }
    }
}

@MainActor
private struct GlassesConnectionSettings: View {
    @ObservedObject var model: GlassesModel
    @Environment(\.dismiss) private var dismiss
    @State private var address: String
    init(model: GlassesModel) { self.model = model; _address = State(initialValue: model.relayAddress) }
    var body: some View {
        NavigationStack {
            Form {
                Section("Glasses connection") {
                    TextField("HTTPS server address", text: $address)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Text("Use the address supplied for your glasses backend. It connects with the account already signed into this app.")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button("Save and connect") {
                        Task { await model.configure(address: address); if model.isConnected { dismiss() } }
                    }.disabled(model.busy || model.connecting || address.isEmpty)
                    if !model.notice.isEmpty { Text(model.notice).foregroundStyle(.secondary) }
                }
            }
            .navigationTitle("Connection settings")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
    }
}
