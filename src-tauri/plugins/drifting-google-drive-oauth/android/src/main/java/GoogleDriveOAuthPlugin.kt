package cc.drifting.googledriveoauth

import android.accounts.Account
import android.app.Activity
import androidx.activity.result.ActivityResult
import androidx.activity.result.IntentSenderRequest
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.auth.api.identity.RevokeAccessRequest
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Scope

private const val DRIVE_APPDATA_SCOPE = "https://www.googleapis.com/auth/drive.appdata"

@InvokeArg
class AuthorizeArgs {
    lateinit var clientId: String
    var expectedAccountSubject: String? = null
}

@InvokeArg
class AccountArgs {
    lateinit var clientId: String
    lateinit var expectedAccountSubject: String
}

@TauriPlugin
class GoogleDriveOAuthPlugin(private val activity: Activity) : Plugin(activity) {
    private val authorizationClient = Identity.getAuthorizationClient(activity)
    private var pendingAuthorize: Invoke? = null
    private var pendingExpectedSubject: String? = null

    @Command
    fun authorize(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(AuthorizeArgs::class.java)
        } catch (_: Exception) {
            resolveError(invoke, "configuration-required")
            return
        }
        if (!validClientId(args.clientId) || !playServicesAvailable()) {
            resolveError(invoke, "configuration-required")
            return
        }
        if (pendingAuthorize != null) {
            resolveError(invoke, "cancelled")
            return
        }
        requestAuthorization(invoke, args.expectedAccountSubject, interactive = true)
    }

    @Command
    fun freshToken(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(AccountArgs::class.java)
        } catch (_: Exception) {
            resolveError(invoke, "configuration-required")
            return
        }
        if (!validClientId(args.clientId) || !validSubject(args.expectedAccountSubject)) {
            resolveError(invoke, "configuration-required")
            return
        }
        requestAuthorization(invoke, args.expectedAccountSubject, interactive = false)
    }

    @Command
    fun revoke(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(AccountArgs::class.java)
        } catch (_: Exception) {
            resolveRevokeError(invoke, "configuration-required")
            return
        }
        if (!validClientId(args.clientId) || !validSubject(args.expectedAccountSubject)) {
            resolveRevokeError(invoke, "configuration-required")
            return
        }

        // Resolve the SDK-owned account first. Drifting stores only the stable
        // subject and ownership marker; it never persists an email address.
        val request = AuthorizationRequest.builder()
            .setRequestedScopes(listOf(Scope(DRIVE_APPDATA_SCOPE)))
            .build()
        authorizationClient.authorize(request)
            .addOnSuccessListener { result ->
                if (result.hasResolution()) {
                    // No SDK-owned account is not proof that Google's remote
                    // grant is gone. Keep Drifting ownership so the user can
                    // reauthorize the same subject and retry revocation.
                    resolveRevokeError(invoke, "needs-reauth")
                    return@addOnSuccessListener
                }
                val account = result.toGoogleSignInAccount()
                val subject = account?.id
                if (subject == null) {
                    resolveRevokeError(invoke, "needs-reauth")
                    return@addOnSuccessListener
                }
                if (subject != args.expectedAccountSubject) {
                    resolveRevokeError(invoke, "account-mismatch")
                    return@addOnSuccessListener
                }
                val androidAccount: Account = account.account ?: run {
                    resolveRevokeError(invoke, "needs-reauth")
                    return@addOnSuccessListener
                }
                val revoke = RevokeAccessRequest.builder()
                    .setAccount(androidAccount)
                    .setScopes(listOf(Scope(DRIVE_APPDATA_SCOPE)))
                    .build()
                authorizationClient.revokeAccess(revoke)
                    .addOnSuccessListener { resolveRevokeSuccess(invoke) }
                    .addOnFailureListener { error ->
                        resolveRevokeError(invoke, mapFailure(error))
                    }
            }
            .addOnFailureListener { error -> resolveRevokeError(invoke, mapFailure(error)) }
    }

    @Command
    fun handleUrl(invoke: Invoke) {
        // iOS alone needs the SDK redirect callback. Android authorization is
        // completed through the PendingIntent Activity Result API.
        resolveError(invoke, "unsupported-platform")
    }

    private fun requestAuthorization(
        invoke: Invoke,
        expectedSubject: String?,
        interactive: Boolean,
    ) {
        val request = AuthorizationRequest.builder()
            .setRequestedScopes(listOf(Scope(DRIVE_APPDATA_SCOPE)))
            .build()
        authorizationClient.authorize(request)
            .addOnSuccessListener { result ->
                if (result.hasResolution()) {
                    if (!interactive) {
                        resolveError(invoke, "needs-reauth")
                        return@addOnSuccessListener
                    }
                    val intentSender = result.pendingIntent?.intentSender ?: run {
                        resolveError(invoke, "needs-reauth")
                        return@addOnSuccessListener
                    }
                    pendingAuthorize = invoke
                    pendingExpectedSubject = expectedSubject
                    startIntentSenderForResult(
                        invoke,
                        IntentSenderRequest.Builder(intentSender).build(),
                        "authorizeResult",
                    )
                    return@addOnSuccessListener
                }
                resolveAuthorization(invoke, result, expectedSubject)
            }
            .addOnFailureListener { error -> resolveError(invoke, mapFailure(error)) }
    }

    @ActivityCallback
    private fun authorizeResult(invoke: Invoke, result: ActivityResult) {
        val pending = pendingAuthorize
        val expected = pendingExpectedSubject
        pendingAuthorize = null
        pendingExpectedSubject = null
        if (pending !== invoke || result.resultCode != Activity.RESULT_OK || result.data == null) {
            resolveError(invoke, "cancelled")
            return
        }
        try {
            resolveAuthorization(
                invoke,
                authorizationClient.getAuthorizationResultFromIntent(result.data!!),
                expected,
            )
        } catch (error: ApiException) {
            resolveError(invoke, mapFailure(error))
        }
    }

    private fun resolveAuthorization(
        invoke: Invoke,
        result: AuthorizationResult,
        expectedSubject: String?,
    ) {
        val granted = result.grantedScopes.map { it.trim() }
        if (!granted.contains(DRIVE_APPDATA_SCOPE)) {
            resolveError(invoke, "permission-denied")
            return
        }
        val subject = result.toGoogleSignInAccount()?.id
        val accessToken = result.accessToken
        if (!validSubject(subject) || accessToken.isNullOrBlank()) {
            resolveError(invoke, "needs-reauth")
            return
        }
        if (expectedSubject != null && subject != expectedSubject) {
            resolveError(invoke, "account-mismatch")
            return
        }
        val response = JSObject()
        response.put("ok", true)
        response.put("accountSubject", subject)
        response.put("accessToken", accessToken)
        // AuthorizationResult intentionally does not expose token expiry. Rust
        // consumes this value immediately and asks AuthorizationClient again
        // before every later Google request.
        response.put("expiresAtMs", 0L)
        response.put("errorCode", null)
        invoke.resolve(response)
    }

    private fun playServicesAvailable(): Boolean =
        GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(activity) ==
            ConnectionResult.SUCCESS

    private fun mapFailure(error: Exception): String = when (error) {
        is ApiException -> when (error.statusCode) {
            CommonStatusCodes.SIGN_IN_REQUIRED,
            CommonStatusCodes.INVALID_ACCOUNT,
            CommonStatusCodes.RESOLUTION_REQUIRED -> "needs-reauth"
            CommonStatusCodes.NETWORK_ERROR -> "offline"
            CommonStatusCodes.DEVELOPER_ERROR -> "configuration-required"
            CommonStatusCodes.CANCELED -> "cancelled"
            else -> "transient"
        }
        else -> "transient"
    }

    private fun validClientId(value: String?): Boolean =
        value != null && value.length in 16..255 && value.endsWith(".apps.googleusercontent.com")

    private fun validSubject(value: String?): Boolean =
        value != null && value.length in 1..255 && value.all {
            it.code in 48..57 || it.code in 65..90 || it.code in 97..122 ||
                it == '.' || it == '_' || it == '~' || it == '-' || it == ':'
        }

    private fun resolveError(invoke: Invoke, code: String) {
        val response = JSObject()
        response.put("ok", false)
        response.put("accountSubject", null)
        response.put("accessToken", null)
        response.put("expiresAtMs", null)
        response.put("errorCode", code)
        invoke.resolve(response)
    }

    private fun resolveRevokeSuccess(invoke: Invoke) {
        val response = JSObject()
        response.put("ok", true)
        response.put("alreadyMissing", false)
        response.put("errorCode", null)
        invoke.resolve(response)
    }

    private fun resolveRevokeError(invoke: Invoke, code: String) {
        val response = JSObject()
        response.put("ok", false)
        response.put("alreadyMissing", false)
        response.put("errorCode", code)
        invoke.resolve(response)
    }
}
