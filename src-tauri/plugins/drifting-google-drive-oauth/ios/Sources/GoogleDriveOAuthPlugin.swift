import Foundation
import GoogleSignIn
import Tauri
import UIKit

private let driveAppDataScope = "https://www.googleapis.com/auth/drive.appdata"

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
}

private enum RevokeAccountResult {
  case present
  case failure(String)
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
    let args: AccountArgs
    do {
      args = try invoke.parseArgs(AccountArgs.self)
    } catch {
      resolveRevokeError(invoke, code: "configuration-required")
      return
    }
    guard validClientId(args.clientId), validSubject(args.expectedAccountSubject) else {
      resolveRevokeError(invoke, code: "configuration-required")
      return
    }

    DispatchQueue.main.async {
      GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: args.clientId)
      self.resolveUserForRevoke(args.expectedAccountSubject) { result in
        switch result {
        case .failure(let code):
          // Missing SDK state is not proof that Google's remote grant is
          // revoked. Preserve Drifting ownership and require same-subject
          // reauthorization before another revoke attempt.
          self.resolveRevokeError(invoke, code: code)
        case .present:
          GIDSignIn.sharedInstance.disconnect { error in
            if let error {
              self.resolveRevokeError(invoke, code: self.mapError(error))
            } else {
              invoke.resolve(RevokeResponse(ok: true, alreadyMissing: false, errorCode: nil))
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
        completion(.failure("account-mismatch"))
      }
      return
    }
    GIDSignIn.sharedInstance.restorePreviousSignIn { user, error in
      guard let user else {
        completion(.failure(self.mapError(error)))
        return
      }
      if user.userID == expectedSubject {
        completion(.present)
      } else {
        completion(.failure("account-mismatch"))
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

  private func resolveRevokeError(_ invoke: Invoke, code: String) {
    invoke.resolve(RevokeResponse(ok: false, alreadyMissing: false, errorCode: code))
  }

  private func mapError(_ error: Error?) -> String {
    guard let error else { return "transient" }
    let nsError = error as NSError
    guard nsError.domain == kGIDSignInErrorDomain else { return "transient" }
    switch nsError.code {
    case -2, -10:
      return "configuration-required"
    case -4, -11:
      return "needs-reauth"
    case -5:
      return "cancelled"
    case -6:
      return "permission-denied"
    case -9:
      return "account-mismatch"
    default:
      return "transient"
    }
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
