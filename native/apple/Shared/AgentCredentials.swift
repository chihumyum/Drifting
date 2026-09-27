import Foundation
import Security

/// Where the author's provider API keys live. Keys never enter a
/// conversation file, a log or a status message; views show `masked` only.
protocol AgentCredentialStore: AnyObject {
    func key(for provider: AgentProviderID) throws -> String?
    func setKey(_ key: String, for provider: AgentProviderID) throws
    func removeKey(for provider: AgentProviderID) throws
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
final class AgentKeychainCredentialStore: AgentCredentialStore {
    private let service: String

    init(service: String = AgentCredentials.service) { self.service = service }

    private func query(_ provider: AgentProviderID) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: AgentCredentials.account(provider)]
    }

    func key(for provider: AgentProviderID) throws -> String? {
        var request = query(provider)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw Self.failure(status, reading: true) }
        return String(data: data, encoding: .utf8)
    }

    func setKey(_ key: String, for provider: AgentProviderID) throws {
        guard let key = AgentCredentials.normalized(key) else { throw LabError.message("API Key 不能为空。") }
        let data = Data(key.utf8)
        let update = SecItemUpdate(query(provider) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw Self.failure(update, reading: false) }
        var item = query(provider)
        item[kSecValueData as String] = data
        item[kSecAttrLabel as String] = "\(service) · \(provider.label) API Key"
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw Self.failure(status, reading: false) }
    }

    func removeKey(for provider: AgentProviderID) throws {
        let status = SecItemDelete(query(provider) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Self.failure(status, reading: false) }
    }

    private static func failure(_ status: OSStatus, reading: Bool) -> LabError {
        .message(reading ? "无法从钥匙串读取 API Key（错误 \(status)）。请检查 macOS 的钥匙串访问提示。"
                         : "无法把 API Key 保存到钥匙串（错误 \(status)）。")
    }
}

/// Tests and previews: keys live only in memory and never touch the Keychain.
final class AgentMemoryCredentialStore: AgentCredentialStore {
    private var keys: [AgentProviderID: String]

    init(_ keys: [AgentProviderID: String] = [:]) { self.keys = keys }

    func key(for provider: AgentProviderID) throws -> String? { keys[provider] }

    func setKey(_ key: String, for provider: AgentProviderID) throws {
        guard let key = AgentCredentials.normalized(key) else { throw LabError.message("API Key 不能为空。") }
        keys[provider] = key
    }

    func removeKey(for provider: AgentProviderID) throws { keys[provider] = nil }
}
