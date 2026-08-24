import Foundation
import GoogleSignIn
import Tauri
import UIKit

private let driveAppDataScope = "https://www.googleapis.com/auth/drive.appdata"
// AppAuth's OAuth token endpoint reports an expired, revoked, or otherwise
// unusable refresh grant with this stable domain/code pair. GoogleSignIn wraps
// it as an underlying NSError when restorePreviousSignIn cannot refresh the
// saved account.
private let appAuthOAuthTokenErrorDomain = "org.openid.appauth.oauth_token"
private let appAuthInvalidGrantErrorCode = -10

private struct AuthorizeArgs: Decodable {
  let clientId: String
  let expectedAccountSubject: String?
}

private struct AccountArgs: Decodable {
  let clientId: String
  let expectedAccountSubject: String
}

private struct URLArgs: Decodable {
  let url: String
}

private struct OAuthResponse: Encodable {
  let ok: Bool
  let accountSubject: String?
  let accessToken: String?
  let expiresAtMs: UInt64?
  let errorCode: String?
}

private struct RevokeResponse: Encodable {
  let ok: Bool
  let alreadyMissing: Bool
  let errorCode: String?
  let diagnostics: RevokeDiagnostics?
}

private struct DiagnosticError: Encodable {
  let family: String
  let domain: String
  let code: Int
  let reason: String?
  let httpStatus: Int?
}

private struct RevokeDiagnostics: Encodable {
  let schemaVersion: Int
  let operation: String
  let platform: String
  let phase: String
  let elapsedMs: UInt64
  let completedPhases: [String]
  let errorChain: [DiagnosticError]
}

private enum RevokeAccountResult {
  case present
  case failure(String, Error?)
}

final class GoogleDriveOAuthPlugin: Plugin {
  @objc public func authorize(_ invoke: Invoke) {
    let args: AuthorizeArgs
    do {
      args = try invoke.parseArgs(AuthorizeArgs.self)
    } catch {
      resolveOAuthError(invoke, code: "configuration-required")
      return
    }
    guard validClientId(args.clientId),
          args.expectedAccountSubject.map(validSubject) ?? true else {
      resolveOAuthError(invoke, code: "configuration-required")
      return
    }

    DispatchQueue.main.async {
      GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: args.clientId)
      guard let presenter = self.manager.viewController else {
        self.resolveOAuthError(invoke, code: "configuration-required")
        return
      }

      // Google Sign-In always includes its basic identity scopes. drive.appdata
      // is the only additional API scope Drifting requests.
      GIDSignIn.sharedInstance.signIn(
        withPresenting: presenter,
        hint: args.expectedAccountSubject,
        additionalScopes: [driveAppDataScope]
      ) { result, error in
        guard let user = result?.user else {
          self.resolveOAuthError(invoke, code: self.mapError(error))
          return
        }
        self.resolveUser(invoke, user: user, expectedSubject: args.expectedAccountSubject)
      }
    }
  }

  @objc public func freshToken(_ invoke: Invoke) {
    let args: AccountArgs
    do {
      args = try invoke.parseArgs(AccountArgs.self)
    } catch {
      resolveOAuthError(invoke, code: "configuration-required")
      return
    }
    guard validClientId(args.clientId), validSubject(args.expectedAccountSubject) else {
      resolveOAuthError(invoke, code: "configuration-required")
      return
    }

    DispatchQueue.main.async {
      GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: args.clientId)
      if let current = GIDSignIn.sharedInstance.currentUser {
        self.refresh(
          invoke,
          user: current,
          expectedSubject: args.expectedAccountSubject)
        return
      }
      GIDSignIn.sharedInstance.restorePreviousSignIn { user, error in
        guard let user else {
          self.resolveOAuthError(invoke, code: self.mapError(error))
          return
        }
        self.refresh(
          invoke,
          user: user,
          expectedSubject: args.expectedAccountSubject)
      }
    }
  }

  @objc public func revoke(_ invoke: Invoke) {
    let startedAt = ProcessInfo.processInfo.systemUptime
    let args: AccountArgs
    do {
      args = try invoke.parseArgs(AccountArgs.self)
    } catch {
      resolveRevokeError(
        invoke,
        code: "configuration-required",
        diagnostics: makeRevokeDiagnostics(
          code: "configuration-required",
          phase: "parse-arguments",
          startedAt: startedAt,
          completedPhases: ["invoke-received"],
          error: error))
      return
    }
    guard validClientId(args.clientId), validSubject(args.expectedAccountSubject) else {
      resolveRevokeError(
        invoke,
        code: "configuration-required",
        diagnostics: makeRevokeDiagnostics(
          code: "configuration-required",
          phase: "validate-arguments",
          startedAt: startedAt,
          completedPhases: ["invoke-received", "arguments-parsed"],
          error: nil))
      return
    }

    DispatchQueue.main.async {
      GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: args.clientId)
      self.resolveUserForRevoke(args.expectedAccountSubject) { result in
        switch result {
        case .failure(let code, let error):
          // Missing SDK state is not proof that Google's remote grant is
          // revoked. Preserve Drifting ownership and require same-subject
          // reauthorization before another revoke attempt.
          self.resolveRevokeError(
            invoke,
            code: code,
            diagnostics: self.makeRevokeDiagnostics(
              code: code,
              phase: "resolve-sdk-user",
              startedAt: startedAt,
              completedPhases: [
                "invoke-received", "arguments-parsed", "arguments-validated", "sdk-configured",
              ],
              error: error))
        case .present:
          GIDSignIn.sharedInstance.disconnect { error in
            if let error {
              let code = self.mapError(error)
              self.resolveRevokeError(
                invoke,
                code: code,
                diagnostics: self.makeRevokeDiagnostics(
                  code: code,
                  phase: "disconnect-revoke-request",
                  startedAt: startedAt,
                  completedPhases: [
                    "invoke-received", "arguments-parsed", "arguments-validated",
                    "sdk-configured", "sdk-user-resolved", "account-subject-matched",
                    "revoke-request-started",
                  ],
                  error: error))
            } else {
              invoke.resolve(RevokeResponse(
                ok: true,
                alreadyMissing: false,
                errorCode: nil,
                diagnostics: self.makeRevokeDiagnostics(
                  code: "success",
                  phase: "disconnect-complete",
                  startedAt: startedAt,
                  completedPhases: [
                    "invoke-received", "arguments-parsed", "arguments-validated",
                    "sdk-configured", "sdk-user-resolved", "account-subject-matched",
                    "revoke-request-started", "revoke-request-completed", "sdk-signed-out",
                  ],
                  error: nil)))
            }
          }
        }
      }
    }
  }

  @objc public func handleUrl(_ invoke: Invoke) {
    let args: URLArgs
    do {
      args = try invoke.parseArgs(URLArgs.self)
    } catch {
      resolveOAuthError(invoke, code: "configuration-required")
      return
    }
    guard let url = URL(string: args.url) else {
      resolveOAuthError(invoke, code: "configuration-required")
      return
    }
    DispatchQueue.main.async {
      if GIDSignIn.sharedInstance.handle(url) {
        // This result is an acknowledgement only. The access token is returned
        // by the still-pending authorize invocation and never enters WebView IPC.
        invoke.resolve(OAuthResponse(
          ok: true,
          accountSubject: nil,
          accessToken: nil,
          expiresAtMs: nil,
          errorCode: nil))
      } else {
        self.resolveOAuthError(invoke, code: "configuration-required")
      }
    }
  }

  private func refresh(_ invoke: Invoke, user: GIDGoogleUser, expectedSubject: String) {
    guard user.userID == expectedSubject else {
      resolveOAuthError(invoke, code: "account-mismatch")
      return
    }
    guard user.grantedScopes?.contains(driveAppDataScope) == true else {
      resolveOAuthError(invoke, code: "permission-denied")
      return
    }
    user.refreshTokensIfNeeded { refreshed, error in
      guard let refreshed else {
        self.resolveOAuthError(invoke, code: self.mapError(error))
        return
      }
      self.resolveUser(invoke, user: refreshed, expectedSubject: expectedSubject)
    }
  }

  private func resolveUserForRevoke(
    _ expectedSubject: String,
    completion: @escaping (RevokeAccountResult) -> Void
  ) {
    if let current = GIDSignIn.sharedInstance.currentUser {
      if current.userID == expectedSubject {
        completion(.present)
      } else {
        completion(.failure("account-mismatch", nil))
      }
      return
    }
    GIDSignIn.sharedInstance.restorePreviousSignIn { user, error in
      guard let user else {
        completion(.failure(self.mapError(error), error))
        return
      }
      if user.userID == expectedSubject {
        completion(.present)
      } else {
        completion(.failure("account-mismatch", nil))
      }
    }
  }

  private func resolveUser(
    _ invoke: Invoke,
    user: GIDGoogleUser,
    expectedSubject: String?
  ) {
    guard let subject = user.userID, validSubject(subject) else {
      resolveOAuthError(invoke, code: "needs-reauth")
      return
    }
    if let expectedSubject, subject != expectedSubject {
      resolveOAuthError(invoke, code: "account-mismatch")
      return
    }
    guard user.grantedScopes?.contains(driveAppDataScope) == true else {
      resolveOAuthError(invoke, code: "permission-denied")
      return
    }
    let token = user.accessToken.tokenString
    guard !token.isEmpty else {
      resolveOAuthError(invoke, code: "needs-reauth")
      return
    }
    let expiration = user.accessToken.expirationDate.map {
      UInt64(max(0, $0.timeIntervalSince1970 * 1000))
    }
    invoke.resolve(OAuthResponse(
      ok: true,
      accountSubject: subject,
      accessToken: token,
      expiresAtMs: expiration,
      errorCode: nil))
  }

  private func resolveOAuthError(_ invoke: Invoke, code: String) {
    invoke.resolve(OAuthResponse(
      ok: false,
      accountSubject: nil,
      accessToken: nil,
      expiresAtMs: nil,
      errorCode: code))
  }

  private func resolveRevokeError(
    _ invoke: Invoke,
    code: String,
    diagnostics: RevokeDiagnostics
  ) {
    #if DEBUG
      let chain = diagnostics.errorChain.map {
        "\($0.family):\($0.domain):\($0.code):\($0.reason ?? "none")"
      }.joined(separator: ",")
      print(
        "[DriftingGoogleDriveOAuth] operation=revoke phase=\(diagnostics.phase) " +
        "code=\(code) elapsedMs=\(diagnostics.elapsedMs) chain=\(chain)"
      )
    #endif
    invoke.resolve(RevokeResponse(
      ok: false,
      alreadyMissing: false,
      errorCode: code,
      diagnostics: diagnostics))
  }

  private func makeRevokeDiagnostics(
    code: String,
    phase: String,
    startedAt: TimeInterval,
    completedPhases: [String],
    error: Error?
  ) -> RevokeDiagnostics {
    let elapsed = max(0, ProcessInfo.processInfo.systemUptime - startedAt)
    return RevokeDiagnostics(
      schemaVersion: 1,
      operation: "revoke",
      platform: "ios",
      phase: phase,
      elapsedMs: UInt64(min(elapsed * 1000, 1_800_000)),
      completedPhases: completedPhases,
      errorChain: diagnosticErrorChain(error, productCode: code))
  }

  private func diagnosticErrorChain(_ error: Error?, productCode: String) -> [DiagnosticError] {
    guard let error else {
      return [DiagnosticError(
        family: productCode == "account-mismatch" ? "account-state" : "input",
        domain: "drifting",
        code: 0,
        reason: productCode,
        httpStatus: nil)]
    }
    var chain: [DiagnosticError] = []
    var current: NSError? = error as NSError
    while let item = current, chain.count < 4 {
      let domain = normalizedDomain(item.domain)
      let reason = normalizedReason(item, domain: domain)
      let family = normalizedFamily(item, domain: domain)
      let httpStatus = domain == "http" && (100...599).contains(item.code) ? item.code : nil
      chain.append(DiagnosticError(
        family: family,
        domain: domain,
        code: item.code,
        reason: reason,
        httpStatus: httpStatus))
      current = item.userInfo[NSUnderlyingErrorKey] as? NSError
    }
    return chain
  }

  private func normalizedDomain(_ domain: String) -> String {
    if domain == NSURLErrorDomain { return "ns-url" }
    if domain == kGIDSignInErrorDomain { return "google-sign-in" }
    if domain == NSOSStatusErrorDomain { return "os-status" }
    let lower = domain.lowercased()
    if lower.contains("http") { return "http" }
    if lower.contains("sessionfetcher") || lower.contains("gtm") { return "google-fetcher" }
    if lower.contains("oauth") || lower.contains("appauth") { return "oauth" }
    return "other"
  }

  private func normalizedFamily(_ error: NSError, domain: String) -> String {
    if domain == "ns-url" { return "network" }
    if domain == "http" { return "http" }
    if domain == "google-fetcher" { return "network" }
    if domain == "oauth" { return "oauth" }
    if domain == "os-status" { return "keychain" }
    if domain == "google-sign-in" {
      switch error.code {
      case GIDSignInError.keychain.rawValue:
        return "keychain"
      case GIDSignInError.hasNoAuthInKeychain.rawValue,
           GIDSignInError.refreshTokenExpired.rawValue,
           GIDSignInError.mismatchWithCurrentUser.rawValue:
        return "account-state"
      case GIDSignInError.jsonSerializationFailure.rawValue:
        return "serialization"
      default:
        return "google-sign-in"
      }
    }
    return "unknown"
  }

  private func normalizedReason(_ error: NSError, domain: String) -> String? {
    if error.domain == appAuthOAuthTokenErrorDomain &&
       error.code == appAuthInvalidGrantErrorCode {
      return "invalid-grant"
    }
    if domain == "http" && (100...599).contains(error.code) { return "http-status" }
    guard domain == "ns-url" else { return nil }
    switch error.code {
    case URLError.notConnectedToInternet.rawValue:
      return "offline"
    case URLError.timedOut.rawValue:
      return "timeout"
    case URLError.cannotFindHost.rawValue, URLError.dnsLookupFailed.rawValue:
      return "dns"
    case URLError.cannotConnectToHost.rawValue:
      return "connect"
    case URLError.networkConnectionLost.rawValue:
      return "connection-lost"
    case URLError.secureConnectionFailed.rawValue,
         URLError.serverCertificateHasBadDate.rawValue,
         URLError.serverCertificateUntrusted.rawValue,
         URLError.serverCertificateHasUnknownRoot.rawValue,
         URLError.serverCertificateNotYetValid.rawValue,
         URLError.clientCertificateRejected.rawValue,
         URLError.clientCertificateRequired.rawValue:
      return "tls"
    default:
      return "network-other"
    }
  }

  private func mapError(_ error: Error?) -> String {
    guard let error else { return "transient" }
    let nsError = error as NSError
    if containsAppAuthInvalidGrant(nsError) { return "needs-reauth" }
    var networkError: NSError? = nsError
    while let current = networkError {
      if current.domain == NSURLErrorDomain {
        switch current.code {
        case URLError.notConnectedToInternet.rawValue,
             URLError.cannotFindHost.rawValue,
             URLError.dnsLookupFailed.rawValue,
             URLError.cannotConnectToHost.rawValue,
             URLError.networkConnectionLost.rawValue:
          return "offline"
        default:
          return "transient"
        }
      }
      networkError = current.userInfo[NSUnderlyingErrorKey] as? NSError
    }
    guard nsError.domain == kGIDSignInErrorDomain else { return "transient" }
    switch nsError.code {
    case GIDSignInError.hasNoAuthInKeychain.rawValue,
         GIDSignInError.refreshTokenExpired.rawValue:
      return "needs-reauth"
    case GIDSignInError.canceled.rawValue:
      return "cancelled"
    case GIDSignInError.EMM.rawValue:
      return "permission-denied"
    case GIDSignInError.ambiguousClaims.rawValue:
      return "configuration-required"
    case GIDSignInError.mismatchWithCurrentUser.rawValue:
      return "account-mismatch"
    case GIDSignInError.keychain.rawValue,
         GIDSignInError.scopesAlreadyGranted.rawValue,
         GIDSignInError.jsonSerializationFailure.rawValue:
      return "transient"
    default:
      return "transient"
    }
  }

  private func containsAppAuthInvalidGrant(_ error: NSError) -> Bool {
    var current: NSError? = error
    var depth = 0
    while let item = current, depth < 4 {
      if item.domain == appAuthOAuthTokenErrorDomain &&
         item.code == appAuthInvalidGrantErrorCode {
        return true
      }
      current = item.userInfo[NSUnderlyingErrorKey] as? NSError
      depth += 1
    }
    return false
  }

  private func validClientId(_ value: String) -> Bool {
    value.count >= 16 && value.count <= 255 &&
      value.hasSuffix(".apps.googleusercontent.com")
  }

  private func validSubject(_ value: String) -> Bool {
    !value.isEmpty && value.count <= 255 && value.utf8.allSatisfy {
      ($0 >= 48 && $0 <= 57) ||
        ($0 >= 65 && $0 <= 90) ||
        ($0 >= 97 && $0 <= 122) ||
        $0 == 45 || $0 == 46 || $0 == 58 || $0 == 95 || $0 == 126
    }
  }
}

@_cdecl("init_plugin_drifting_google_drive_oauth")
func initPlugin() -> Plugin {
  GoogleDriveOAuthPlugin()
}
