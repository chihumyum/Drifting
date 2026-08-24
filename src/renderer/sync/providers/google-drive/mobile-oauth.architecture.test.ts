import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

const rust = read('src-tauri/src/google_drive_sync.rs');
const nativeEntry = read('src-tauri/src/lib.rs');
const commands = read('src-tauri/src/commands.rs');
const contracts = read('src/renderer/platform/contracts.ts');
const kotlin = read(
  'src-tauri/plugins/drifting-google-drive-oauth/android/src/main/java/GoogleDriveOAuthPlugin.kt',
);
const swift = read(
  'src-tauri/plugins/drifting-google-drive-oauth/ios/Sources/GoogleDriveOAuthPlugin.swift',
);

describe('Google Drive official mobile OAuth architecture', () => {
  it('requests only drive.appdata through the official SDK clients and uses stable subjects', () => {
    const scope = 'https://www.googleapis.com/auth/drive.appdata';
    expect(kotlin).toContain('Identity.getAuthorizationClient(activity)');
    expect(kotlin).toContain('AuthorizationRequest.builder()');
    expect(kotlin).toContain('result.toGoogleSignInAccount()?.id');
    expect(kotlin).toContain(scope);
    expect(kotlin).not.toMatch(/\.email\b|getEmail\s*\(/u);
    expect(kotlin).not.toContain('WebView');

    expect(swift).toContain('import GoogleSignIn');
    expect(swift).toContain('GIDSignIn.sharedInstance.signIn(');
    expect(swift).toContain('user.userID');
    expect(swift).toContain(scope);
    expect(swift).not.toMatch(/\.email\b|profile\?\.email/u);
    expect(swift).not.toContain('WKWebView');

    for (const source of [kotlin, swift]) {
      expect(source).not.toMatch(
        /googleapis\.com\/auth\/drive(?:\.file)?(?:["'\s])/u,
      );
    }
  });

  it('keeps mobile credential persistence token-free and renderer results opaque', () => {
    const mobileMaterialStart = rust.indexOf('struct MobileSdkCredentialV1');
    const mobileMaterialEnd = rust.indexOf('struct OpenGeneration', mobileMaterialStart);
    const mobileMaterial = rust.slice(mobileMaterialStart, mobileMaterialEnd);
    expect(mobileMaterialStart).toBeGreaterThan(0);
    expect(mobileMaterialEnd).toBeGreaterThan(mobileMaterialStart);
    expect(mobileMaterial).toContain('platform: String');
    expect(mobileMaterial).toContain('client_id: String');
    expect(mobileMaterial).not.toMatch(/access_token|refresh_token|email|session_uri/u);
    expect(rust).toContain('MobileSdkAccount(MobileSdkCredentialV1)');
    expect(rust).toContain('.fresh_token(&material.client_id, &credential.account_subject)');

    const dtoStart = contracts.indexOf('export interface GoogleDriveNativeOAuthResult');
    const dtoEnd = contracts.indexOf('export interface DeepLinkEventPayload', dtoStart);
    const oauthDtos = contracts.slice(dtoStart, dtoEnd);
    expect(oauthDtos).toContain('credentialSecretRef: string');
    expect(oauthDtos).toContain('accountSubject: string');
    expect(oauthDtos).not.toMatch(/accessToken|refreshToken|email|sessionUri/u);
  });

  it('fails closed without per-platform build configuration and registered plugins', () => {
    const cargo = read('src-tauri/Cargo.toml');
    const build = read('src-tauri/build.rs');
    const androidBuild = read(
      'src-tauri/plugins/drifting-google-drive-oauth/android/build.gradle.kts',
    );
    const iosPackage = read(
      'src-tauri/plugins/drifting-google-drive-oauth/ios/Package.swift',
    );
    const iosCategoryBridge = read(
      'src-tauri/gen/apple/Sources/drifting/AppAuthIOSCategoryBridge.m',
    );
    const iosProject = read('src-tauri/gen/apple/project.yml');
    const iosGeneratedProject = read(
      'src-tauri/gen/apple/drifting.xcodeproj/project.pbxproj',
    );
    const iosPlist = read('src-tauri/gen/apple/drifting_iOS/Info.plist');
    const iosTauriConfig = read('src-tauri/tauri.ios.conf.json');

    expect(cargo).toContain('tauri-plugin-drifting-google-drive-oauth');
    expect(nativeEntry).toContain('tauri_plugin_drifting_google_drive_oauth::init()');
    expect(commands).toContain(
      'crate::google_drive_sync::google_drive_oauth_build_configured()',
    );
    for (const name of [
      'DRIFTING_GOOGLE_DESKTOP_CLIENT_ID',
      'DRIFTING_GOOGLE_DESKTOP_CLIENT_SECRET',
      'DRIFTING_GOOGLE_IOS_CLIENT_ID',
      'DRIFTING_GOOGLE_IOS_REVERSED_CLIENT_ID',
      'DRIFTING_GOOGLE_ANDROID_CLIENT_ID',
    ]) {
      expect(build).toContain(name);
      expect(rust).toContain(name);
    }
    expect(rust).toContain('valid_ios_oauth_build_config(client_id, reversed)');
    expect(iosPlist).toContain('$(DRIFTING_GOOGLE_IOS_CLIENT_ID)');
    expect(iosPlist).toContain('$(DRIFTING_GOOGLE_IOS_REVERSED_CLIENT_ID)');
    expect(iosTauriConfig).toContain('$(DRIFTING_GOOGLE_IOS_REVERSED_CLIENT_ID)');
    expect(androidBuild).toContain('com.google.android.gms:play-services-auth:21.6.0');
    expect(iosPackage).toContain('https://github.com/google/GoogleSignIn-iOS');
    expect(iosPackage).toContain('exact: "9.2.0"');
    expect(iosCategoryBridge).toContain(
      '@implementation OIDAuthorizationService (DriftingIOSPresentation)',
    );
    expect(iosCategoryBridge).toContain('presentingViewController:');
    expect(iosCategoryBridge).toContain('prefersEphemeralSession:');
    expect(iosProject).not.toContain('OTHER_LDFLAGS: $(inherited) -ObjC');
    expect(iosGeneratedProject).not.toContain(
      'OTHER_LDFLAGS = "$(inherited) -ObjC";',
    );
  });

  it('does not grant the renderer direct access to private mobile plugin commands', () => {
    const capabilities = read('src-tauri/capabilities/mobile.json');
    expect(capabilities).not.toContain('drifting-google-drive-oauth');
    expect(nativeEntry).toContain('.plugin(tauri_plugin_drifting_google_drive_oauth::init())');
    expect(nativeEntry).toContain('google_drive_oauth_connect');
  });

  it('keeps ambiguous SDK revoke state non-terminal so ownership survives', () => {
    expect(kotlin).toContain('resolveRevokeError(invoke, "needs-reauth")');
    expect(kotlin).not.toContain('resolveRevokeMissing');
    expect(swift).toContain('self.resolveRevokeError(');
    expect(swift).toContain('phase: "resolve-sdk-user"');
    expect(swift).toContain('Missing SDK state is not proof');
  });

  it('maps Android SDK failures by official status constants without inventing permission denial', () => {
    const failureMap = kotlin.slice(
      kotlin.indexOf('private fun mapFailure'),
      kotlin.indexOf('private fun validClientId'),
    );
    expect(kotlin).toContain('import com.google.android.gms.common.api.CommonStatusCodes');
    expect(failureMap).toContain('CommonStatusCodes.CANCELED');
    expect(failureMap).toContain('CommonStatusCodes.NETWORK_ERROR -> "offline"');
    expect(failureMap).not.toContain('13 -> "cancelled"');
    expect(failureMap).not.toContain('17 -> "permission-denied"');
    expect(kotlin).toContain('if (!granted.contains(DRIVE_APPDATA_SCOPE))');
    expect(kotlin).toContain('resolveError(invoke, "permission-denied")');
  });

  it('maps iOS SDK failures by GoogleSignIn 9.2 enum cases instead of stale integers', () => {
    const errorMap = swift.slice(
      swift.indexOf('private func mapError'),
      swift.indexOf('private func validClientId'),
    );
    for (const sdkCase of [
      'hasNoAuthInKeychain',
      'refreshTokenExpired',
      'canceled',
      'EMM',
      'ambiguousClaims',
      'mismatchWithCurrentUser',
      'keychain',
      'scopesAlreadyGranted',
      'jsonSerializationFailure',
    ]) {
      expect(errorMap).toContain(`GIDSignInError.${sdkCase}.rawValue`);
    }
    expect(errorMap).not.toMatch(/case\s+-\d/u);
    expect(errorMap).toContain('GIDSignInError.keychain.rawValue,');
    expect(errorMap).toContain('GIDSignInError.jsonSerializationFailure.rawValue:');
    expect(errorMap).toContain('return "transient"');
  });

  it('classifies AppAuth invalid_grant as same-account reauthorization', () => {
    expect(swift).toContain(
      'private let appAuthOAuthTokenErrorDomain = "org.openid.appauth.oauth_token"',
    );
    expect(swift).toContain('private let appAuthInvalidGrantErrorCode = -10');
    expect(swift).toContain('containsAppAuthInvalidGrant(nsError)');
    expect(swift).toContain('return "needs-reauth"');
    expect(swift).toContain('return "invalid-grant"');
    expect(swift).not.toContain('invalid_grant');
  });

  it('captures only allowlisted iOS revoke error-chain fields', () => {
    expect(swift).toContain('NSUnderlyingErrorKey');
    expect(swift).toContain('domain == NSURLErrorDomain');
    expect(swift).toContain('domain == NSOSStatusErrorDomain');
    expect(swift).toContain('"disconnect-revoke-request"');
    expect(swift).toContain('errorChain: diagnosticErrorChain(error, productCode: code)');
    expect(swift).not.toContain('localizedDescription');
    expect(swift).not.toMatch(/userInfo\s*\.description/u);
    expect(rust).toContain('native_revoke_diagnostics(');
    expect(contracts).toContain('raw NSError text and userInfo never cross IPC');
  });

  it('consumes iOS Google callback URLs natively before the renderer deep-link queue', () => {
    expect(nativeEntry).toContain('is_private_google_oauth_callback_url(&url)');
    expect(nativeEntry).toContain('handle_private_google_oauth_callback(&app, &url).await');
    expect(rust).toContain('.drifting_google_drive_oauth().handle_url(url).await');
    expect(rust).toContain('starts_with("com.googleusercontent.apps.")');
  });
});
