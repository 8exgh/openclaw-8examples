import Foundation

enum WakePhrase {
    static func request(in transcript: String) -> String? {
        let pattern = #"(?:^\s*(?:hey\s+)?|\bhey\s+)open\s*claw\b[\s,:.!?-]*([\s\S]*)"#
        guard let expression = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let match = expression.firstMatch(in: transcript, range: NSRange(transcript.startIndex..., in: transcript)),
              let range = Range(match.range(at: 1), in: transcript) else { return nil }
        let request = transcript[range].trimmingCharacters(in: .whitespacesAndNewlines)
        return request.isEmpty ? nil : request
    }
}
