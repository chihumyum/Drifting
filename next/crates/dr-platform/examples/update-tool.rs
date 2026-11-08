//! The release side of updates, in Tauri's formats, so the 0.1 pipeline's key
//! and manifests keep working (see the F7 doc):
//!
//! ```text
//! cargo run -p dr-platform --example update-tool -- keygen <dir>
//!     a throwaway, unencrypted key pair for local tests:
//!     <dir>/test-updater.pub (what DRIFTING_DEV_UPDATER_PUBLIC_KEY takes)
//!     <dir>/test-updater.key (what `sign` takes)
//! cargo run -p dr-platform --example update-tool -- sign <file>
//!     writes <file>.sig with the key in TAURI_SIGNING_PRIVATE_KEY (and
//!     TAURI_SIGNING_PRIVATE_KEY_PASSWORD), exactly as `tauri signer sign`
//! cargo run -p dr-platform --example update-tool -- verify <file> <public key>
//! cargo run -p dr-platform --example update-tool -- manifest --version <v> \
//!     --platform <os-arch> --url <url> --signature-file <file.sig> \
//!     [--notes-file <md>] [--merge <existing.json>] [--local] --output <json>
//!     (`--local` allows a file:// URL, for rehearsals only)
//! cargo run -p dr-platform --example update-tool -- apply <manifest> \
//!     <public key> <bundle.app> [--current <version>]
//!     the whole client flow against local files: check, download, verify,
//!     and swap the bundle at <bundle.app> (a development bundle only)
//! ```
//!
//! It never reads the release key from anywhere but the environment, and
//! never uploads anything.

use std::collections::BTreeMap;
use std::io::Cursor;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result, bail};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("keygen") => keygen(Path::new(args.get(1).context("keygen <dir>")?)),
        Some("sign") => sign(Path::new(args.get(1).context("sign <file>")?)),
        Some("verify") => verify(
            Path::new(args.get(1).context("verify <file> <public key>")?),
            args.get(2).context("verify <file> <public key>")?,
        ),
        Some("manifest") => manifest(&args[1..]),
        Some("apply") => apply(&args[1..]),
        _ => bail!("usage: update-tool keygen|sign|verify|manifest …; see the source"),
    }
}

fn keygen(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let pair = minisign::KeyPair::generate_unencrypted_keypair()?;
    let public = STANDARD.encode(pair.pk.to_box()?.into_string());
    let secret = STANDARD.encode(
        pair.sk
            .to_box(Some("Drifting test updater key"))?
            .into_string(),
    );
    std::fs::write(dir.join("test-updater.pub"), &public)?;
    std::fs::write(dir.join("test-updater.key"), &secret)?;
    println!("{}", dir.join("test-updater.pub").display());
    Ok(())
}

fn secret_key() -> Result<minisign::SecretKey> {
    let encoded = std::env::var("TAURI_SIGNING_PRIVATE_KEY")
        .context("set TAURI_SIGNING_PRIVATE_KEY (the key file's content, or a path to it)")?;
    let encoded = if Path::new(encoded.trim()).is_file() {
        std::fs::read_to_string(encoded.trim())?
    } else {
        encoded
    };
    let text = String::from_utf8(STANDARD.decode(encoded.trim())?)?;
    let boxed = minisign::SecretKeyBox::from_string(&text)?;
    let password = std::env::var("TAURI_SIGNING_PRIVATE_KEY_PASSWORD")
        .ok()
        .filter(|p| !p.is_empty());
    Ok(match password {
        Some(password) => boxed.into_secret_key(Some(password))?,
        None => boxed.into_unencrypted_secret_key()?,
    })
}

fn sign(file: &Path) -> Result<()> {
    let key = secret_key()?;
    let bytes = std::fs::read(file)?;
    let name = file.file_name().context("no file name")?.to_string_lossy();
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let trusted = format!("timestamp:{timestamp}\tfile:{name}");
    let signature = minisign::sign(None, &key, Cursor::new(bytes), Some(&trusted), None)?;
    let output = format!("{}.sig", file.display());
    std::fs::write(&output, STANDARD.encode(signature.into_string()))?;
    println!("{output}");
    Ok(())
}

fn verify(file: &Path, public_key: &str) -> Result<()> {
    let public_key = if Path::new(public_key).is_file() {
        std::fs::read_to_string(public_key)?
    } else {
        public_key.to_owned()
    };
    let key = dr_platform::update::UpdaterKey::parse(&public_key)?;
    let signature = std::fs::read_to_string(format!("{}.sig", file.display()))?;
    let verified = key.verify_file(file, &signature)?;
    println!(
        "ok: {} (signed as {})",
        file.display(),
        verified.signed_file().unwrap_or("no file name")
    );
    Ok(())
}

fn manifest(args: &[String]) -> Result<()> {
    let mut values = BTreeMap::new();
    let mut rest = args.iter();
    while let Some(key) = rest.next() {
        if key == "--local" {
            values.insert("--local", "");
            continue;
        }
        let value = rest
            .next()
            .with_context(|| format!("{key} needs a value"))?;
        values.insert(key.as_str(), value.as_str());
    }
    let get = |key: &str| {
        values
            .get(key)
            .copied()
            .with_context(|| format!("missing {key}"))
    };
    let version = get("--version")?;
    semver::Version::parse(version.trim_start_matches('v')).context("--version is not SemVer")?;
    let url = get("--url")?;
    let local = values.contains_key("--local");
    if !url.starts_with("https://") && !(local && url.starts_with("file://")) {
        bail!("--url must be HTTPS");
    }
    let signature = std::fs::read_to_string(get("--signature-file")?)?
        .trim()
        .to_owned();
    if signature.is_empty() {
        bail!("the signature file is empty");
    }
    let mut manifest: serde_json::Value = match values.get("--merge") {
        Some(existing) => serde_json::from_slice(&std::fs::read(existing)?)?,
        None => serde_json::json!({ "platforms": {} }),
    };
    if let Some(existing) = manifest.get("version").and_then(|v| v.as_str())
        && existing != version
    {
        bail!("--merge holds version {existing}, not {version}");
    }
    manifest["version"] = version.into();
    if let Some(notes) = values.get("--notes-file") {
        let text = std::fs::read_to_string(notes)?;
        // The release title names the version; the app shows only the body.
        let body = text
            .strip_prefix('#')
            .and_then(|rest| rest.split_once('\n').map(|(_, body)| body))
            .unwrap_or(&text);
        manifest["notes"] = body.trim().into();
    }
    if manifest.get("pub_date").is_none() {
        // Tauri's updater rejects a manifest whose date is not RFC 3339.
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        manifest["pub_date"] = rfc3339(now).into();
    }
    manifest["platforms"][get("--platform")?] =
        serde_json::json!({ "signature": signature, "url": url });
    std::fs::write(
        get("--output")?,
        format!("{}\n", serde_json::to_string_pretty(&manifest)?),
    )?;
    Ok(())
}

fn apply(args: &[String]) -> Result<()> {
    use dr_platform::update::{LocalFetch, Offer, Target, Updater, UpdaterConfig, UrlPolicy};
    let [manifest, public_key, bundle, rest @ ..] = args else {
        bail!("apply <manifest> <public key> <bundle.app> [--current <version>]");
    };
    let current = match rest {
        [flag, version] if flag == "--current" => version.clone(),
        [] => "0.0.0".to_owned(),
        _ => bail!("unexpected arguments {rest:?}"),
    };
    let public_key = if Path::new(public_key).is_file() {
        std::fs::read_to_string(public_key)?
    } else {
        public_key.clone()
    };
    let manifest_url = if manifest.contains("://") {
        manifest.clone()
    } else {
        format!("file://{}", std::fs::canonicalize(manifest)?.display())
    };
    let updater = Updater::new(
        UpdaterConfig {
            manifest_url,
            public_key,
            current_version: semver::Version::parse(&current)?,
            target: Target::current().context("no updater target for this platform")?,
            url_policy: UrlPolicy::AllowLocal,
            // Rehearsals only ever touch a development bundle.
            bundle_id: dr_platform::identity::DEVELOPMENT.bundle_id.to_owned(),
        },
        LocalFetch,
    )?;
    let available = match updater.check()? {
        Offer::Newer(available) => available,
        Offer::Current => {
            println!("the manifest offers {current}, the current version");
            return Ok(());
        }
        Offer::Older(offered) => {
            println!("the manifest offers {offered}, older than {current}: not installed");
            return Ok(());
        }
    };
    let downloads = std::env::temp_dir().join(format!("drifting-update-{}", std::process::id()));
    let started = std::time::Instant::now();
    let downloaded = updater.download(&available, &downloads, &mut |_| {})?;
    println!(
        "verified {} ({}) in {} ms",
        available.version,
        downloaded.path.display(),
        started.elapsed().as_millis()
    );
    // What the app's quit hook does (M42): the swap alone.
    let started = std::time::Instant::now();
    downloaded.replace_bundle(Path::new(bundle))?;
    let swapped = started.elapsed();
    let _ = std::fs::remove_dir_all(&downloads);
    println!(
        "installed {} into {bundle} in {} ms",
        available.version,
        swapped.as_millis()
    );
    Ok(())
}

/// `YYYY-MM-DDTHH:MM:SSZ` from Unix seconds (Howard Hinnant's civil_from_days).
fn rfc3339(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

#[test]
fn dates_are_rfc3339() {
    assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
    assert_eq!(rfc3339(1_762_473_600), "2025-11-07T00:00:00Z");
    assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
}
