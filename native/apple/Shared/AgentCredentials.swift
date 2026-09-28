import Foundation
import Security

/// Where the author's provider API keys live. Keys never enter a
/// conversation file, a log or a status message; views show `masked` only.
protocol AgentCredentialStore: AnyObject {
    func key(for provider: AgentProviderID) throws -> String?
    func setKey(_ key: String, for provider: AgentProviderID) throws
    func removeKey(for provider: AgentProviderID) throws
}

/// Other secrets of the writing assistant (MCP environment values and
/// headers) under the same Keychain service, by account name.
protocol AgentSecretStore: AnyObject {
    func secret(account: String) throws -> String?
    func setSecret(_ value: String, account: String) throws
    func removeSecret(account: String) throws
}

extension AgentCredentialStore {
    /// “已保存 ····a1b2”, or nil when no key is stored.
    func maskedKey(for provider: AgentProviderID) -> String? {
        guard let key = try? key(for: provider), !key.isEmpty else { return nil }
        return AgentCredentials.masked(key)
    }
}

enum AgentCredentials {
    /// The lab's own Keychain namespace, distinct from the production
    /// `Drifting` service (docs/apple-native/architecture.md).
    static let service = "Drifting Native Lab"
    static func account(_ provider: AgentProviderID) -> String { "byok.\(provider.rawValue)" }

    /// Only the last four characters are ever shown.
    static func masked(_ key: String) -> String {
        let tail = key.count > 8 ? String(key.suffix(4)) : ""
        return "已保存 ····\(tail)"
    }

    /// Trims pasted whitespace; an empty key is refused.
    static func normalized(_ key: String) -> String? {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed.contains(where: { $0.isNewline }) ? nil : trimmed
    }
}

/// Generic-password items under `Drifting Native Lab` / `byok.<provider>`.
/// The lab is unsigned, so the macOS file keychain is used rather than the
/// data-protection keychain (which needs an access-group entitlement).
/// MCP secrets use the same service with `mcp.…` accounts.
final class AgentKeychainCredentialStore: AgentCredentialStore, AgentSecretStore {
    private let service: String

    init(service: String = AgentCredentials.service) { self.service = service }

    private func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    func key(for provider: AgentProviderID) throws -> String? {
        try read(AgentCredentials.account(provider), what: "API Key")
    }

    func setKey(_ key: String, for provider: AgentProviderID) throws {
        guard let key = AgentCredentials.normalized(key) else { throw LabError.message("API Key 不能为空。") }
        try write(key, account: AgentCredentials.account(provider), label: "\(service) · \(provider.label) API Key", what: "API Key")
    }

    func removeKey(for provider: AgentProviderID) throws {
        try remove(AgentCredentials.account(provider), what: "API Key")
    }

    func secret(account: String) throws -> String? { try read(account, what: "密钥") }

    func setSecret(_ value: String, account: String) throws {
        try write(value, account: account, label: "\(service) · MCP 密钥", what: "密钥")
    }

    func removeSecret(account: String) throws { try remove(account, what: "密钥") }

    private func read(_ account: String, what: String) throws -> String? {
        var request = query(account)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw Self.failure(status, reading: true, what: what) }
        return String(data: data, encoding: .utf8)
    }

    private func write(_ value: String, account: String, label: String, what: String) throws {
        let data = Data(value.utf8)
        let update = SecItemUpdate(query(account) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw Self.failure(update, reading: false, what: what) }
        var item = query(account)
        item[kSecValueData as String] = data
        item[kSecAttrLabel as String] = label
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw Self.failure(status, reading: false, what: what) }
    }

    private func remove(_ account: String, what: String) throws {
        let status = SecItemDelete(query(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Self.failure(status, reading: false, what: what) }
    }

    private static func failure(_ status: OSStatus, reading: Bool, what: String) -> LabError {
        .message(reading ? "无法从钥匙串读取\(what)（错误 \(status)）。请检查 macOS 的钥匙串访问提示。"
                         : "无法把\(what)保存到钥匙串（错误 \(status)）。")
    }
}

/// Tests and previews: keys live only in memory and never touch the Keychain.
final class AgentMemoryCredentialStore: AgentCredentialStore, AgentSecretStore {
    private var keys: [AgentProviderID: String]
    /// Other secrets by account, as the Keychain would hold them.
    private(set) var secrets: [String: String] = [:]

    init(_ keys: [AgentProviderID: String] = [:]) { self.keys = keys }

    func secret(account: String) throws -> String? { secrets[account] }
    func setSecret(_ value: String, account: String) throws { secrets[account] = value }
    func removeSecret(account: String) throws { secrets[account] = nil }

    func key(for provider: AgentProviderID) throws -> String? { keys[provider] }

    func setKey(_ key: String, for provider: AgentProviderID) throws {
        guard let key = AgentCredentials.normalized(key) else { throw LabError.message("API Key 不能为空。") }
        keys[provider] = key
    }

    func removeKey(for provider: AgentProviderID) throws { keys[provider] = nil }
}
