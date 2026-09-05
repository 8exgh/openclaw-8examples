import AVFoundation
import Combine
import Speech

@MainActor
final class GlassesAudio: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    struct Input: Identifiable { let id: String; let name: String }
    @Published private(set) var active = false
    @Published private(set) var status = "Session off"
    @Published private(set) var transcript = ""
    @Published private(set) var inputs: [Input] = []
    @Published var selectedInput = ""
    @Published var usePhoneMicrophone = false
    var onRequest: ((String) -> Void)?

    private let engine = AVAudioEngine()
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-CA"))
    private let speaker = AVSpeechSynthesizer()
    private var recognition: SFSpeechRecognitionTask?
    private var audioRequest: SFSpeechAudioBufferRecognitionRequest?
    private var hasTap = false
    private var generation = UUID()
    private var silence: Task<Void, Never>?
    private var rotation: Task<Void, Never>?
    private var expiry: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []
    private var speechQueue: [String] = []
    private var lastTranscript = ""
    private var starting = false
    private var startGeneration = UUID()

    override init() {
        super.init()
        speaker.delegate = self
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let type = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            if type == AVAudioSession.InterruptionType.began.rawValue {
                Task { @MainActor in self?.stop(reason: "Audio interrupted. Start a new session when ready.") }
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.active else { return }
                if !self.routeIsCorrect() { self.stop(reason: "Glasses disconnected. Session stopped.") }
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.stop(reason: "Audio service restarted. Reopen the app before starting a session.") }
        })
    }

    func findGlasses() {
        guard !active else { return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
            try session.setActive(true)
            inputs = (session.availableInputs ?? []).filter { $0.portType == .bluetoothHFP }
                .map { Input(id: $0.uid, name: $0.portName) }
            if inputs.count == 1 { selectedInput = inputs[0].id }
            try session.setActive(false, options: .notifyOthersOnDeactivation)
            status = inputs.isEmpty ? "Pair your glasses in the Meta AI app and iPhone Bluetooth settings." : "Choose your glasses, then start a session."
        } catch { status = error.localizedDescription }
    }

    func start() async {
        guard !active, !starting else { return }
        starting = true
        defer { starting = false }
        let ticket = startGeneration
        let microphone = await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission { continuation.resume(returning: $0) }
        }
        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard ticket == startGeneration else { return }
        guard microphone, speech == .authorized else { status = "Enable microphone and speech recognition in Settings."; return }
        guard recognizer?.isAvailable == true else { status = "Speech recognition is unavailable. You can type your request."; return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
            try session.setActive(true)
            let input = session.availableInputs?.first {
                usePhoneMicrophone ? $0.portType == .builtInMic : $0.uid == selectedInput && $0.portType == .bluetoothHFP
            }
            guard let input else { throw AudioError.noGlasses }
            try session.setPreferredInput(input)
            guard routeIsCorrect() else { throw AudioError.noGlasses }
            active = true
            try listen()
            expiry?.cancel()
            expiry = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(15 * 60)) } catch { return }
                self?.stop(reason: "The 15-minute session ended. Start another when ready.")
            }
        } catch { stop(reason: error.localizedDescription) }
    }

    private func routeIsCorrect() -> Bool {
        let route = AVAudioSession.sharedInstance().currentRoute
        if usePhoneMicrophone { return route.inputs.contains { $0.portType == .builtInMic } }
        return route.inputs.contains { $0.portType == .bluetoothHFP && $0.uid == selectedInput }
            && route.outputs.contains { $0.portType == .bluetoothHFP }
    }

    private func listen() throws {
        guard active, speechQueue.isEmpty, !speaker.isSpeaking else { return }
        cancelRecognition()
        guard routeIsCorrect(), let recognizer, recognizer.isAvailable else { throw AudioError.noGlasses }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        request.contextualStrings = ["OpenClaw", "Hey OpenClaw"]
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        audioRequest = request
        let currentGeneration = generation
        recognition = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self, self.active, self.generation == currentGeneration else { return }
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                    if self.transcript != self.lastTranscript {
                        self.lastTranscript = self.transcript
                        self.silence?.cancel()
                        if WakePhrase.request(in: self.transcript) != nil {
                            self.status = "Hearing your request…"
                        }
                        // End unaddressed utterances too, so mentioning OpenClaw in
                        // conversation does not become a command in a later fragment.
                        self.silence = Task { [weak self] in
                            do { try await Task.sleep(for: .milliseconds(1400)) } catch { return }
                            self?.finishUtterance()
                        }
                    }
                    if result.isFinal { self.finishUtterance() }
                } else if error != nil {
                    self.stop(reason: "Speech recognition stopped. Start a new session or type your request.")
                }
            }
        }
        let node = engine.inputNode
        let format = node.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw AudioError.noGlasses }
        node.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
        hasTap = true
        engine.prepare()
        try engine.start()
        status = "Listening for ‘OpenClaw’"
        rotation = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(50)) } catch { return }
            self?.finishUtterance()
        }
    }

    private func finishUtterance() {
        guard active else { return }
        let request = WakePhrase.request(in: transcript)
        cancelRecognition()
        if let request {
            let control = request.trimmingCharacters(in: .punctuationCharacters).lowercased()
            if control == "stop listening" || control == "stop session" { stop(); return }
            onRequest?(request)
        }
        do { try listen() } catch { stop(reason: error.localizedDescription) }
    }

    private func cancelRecognition() {
        generation = UUID()
        silence?.cancel(); rotation?.cancel()
        engine.stop()
        if hasTap { engine.inputNode.removeTap(onBus: 0); hasTap = false }
        audioRequest?.endAudio()
        recognition?.cancel()
        recognition = nil; audioRequest = nil
        transcript = ""; lastTranscript = ""
    }

    func speak(_ text: String) {
        guard active, routeIsCorrect(), !text.isEmpty else { return }
        speechQueue.append(text)
        if !speaker.isSpeaking { speakNext() }
    }
    private func speakNext() {
        guard active, routeIsCorrect() else { stop(reason: "Glasses disconnected. Session stopped."); return }
        guard !speechQueue.isEmpty else {
            do { try listen() } catch { stop(reason: error.localizedDescription) }
            return
        }
        cancelRecognition() // Do not interpret OpenClaw's own spoken answer as a new command.
        let utterance = AVSpeechUtterance(string: speechQueue.removeFirst())
        utterance.voice = AVSpeechSynthesisVoice(language: "en-CA")
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        status = "OpenClaw is speaking"
        speaker.speak(utterance)
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in self?.speakNext() }
    }
    func stop(reason: String = "Session off") {
        startGeneration = UUID()
        active = false
        expiry?.cancel()
        cancelRecognition()
        speechQueue.removeAll()
        speaker.stopSpeaking(at: .immediate)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        status = reason
    }
    private enum AudioError: LocalizedError {
        case noGlasses
        var errorDescription: String? { "Select connected glasses with microphone audio enabled. The phone microphone is used only when you choose it." }
    }
}
