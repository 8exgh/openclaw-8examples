import SwiftUI

struct LoginView: View {
    @Environment(AppModel.self) private var model
    @State private var username = ""
    @State private var password = ""
    @State private var showServer = false

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 8) {
                        Image("8ExamplesLogo")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 72, height: 72)
                        Text("8Examples AI Assistant")
                            .font(.largeTitle.bold())
                        Text("Sign in with your AI assistant username and password — the same ones you use at chat.8examples.com.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                }

                Section {
                    TextField("Username", text: $username)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                }

                if let error = model.errorMessage {
                    Section { Text(error).foregroundStyle(.red) }
                }

                Section {
                    Button {
                        Task { await model.login(username: username, password: password) }
                    } label: {
                        HStack {
                            Spacer()
                            if model.busy { ProgressView() } else { Text("Sign in").bold() }
                            Spacer()
                        }
                    }
                    .disabled(username.isEmpty || password.isEmpty || model.busy)
                }

                Section {
                    DisclosureGroup("Server", isExpanded: $showServer) {
                        TextField("https://8examples.com", text: $model.serverURLString)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("")
            .onSubmit { Task { await model.login(username: username, password: password) } }
        }
    }
}
