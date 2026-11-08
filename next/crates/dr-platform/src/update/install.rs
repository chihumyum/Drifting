//! Putting a verified update in place.
//!
//! - **macOS**: the artifact is a `.app.tar.gz` holding one `<Name>.app/`
//!   folder. Like Tauri's updater, the folder's own name is dropped and its
//!   contents replace the running bundle at its current path, so the same
//!   archive installs whether a Tauri client or this one downloaded it.
//! - **Windows**: the artifact is the NSIS installer. It runs with the flags
//!   Tauri's updater passes (`/P /R /UPDATE /ARGS …`), so the installer
//!   behaves the same whichever client started it; this process then quits.
//!   Installing as the app quits, without reopening it, drops `/R`.
//!
//! The bundle's own `CFBundleShortVersionString` must be the version the
//! update was offered as (`replace_bundle`'s `expected_version`), so a
//! signed older bundle cannot come in under a newer number.

use std::ffi::OsString;
use std::io;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum InstallError {
    #[error("the update archive is malformed: {0}")]
    Archive(String),
    #[error("the update is a different app ({found}, expected {expected})")]
    WrongApp { expected: String, found: String },
    #[error("the update is version {found}, not the offered {expected}")]
    WrongVersion { expected: String, found: String },
    /// The bundle's folder is not writable by this user (for example
    /// `/Applications` on a standard account). Nothing was changed.
    #[error("installing the update needs an administrator")]
    NeedsAuthorization,
    #[error("could not install the update: {0}")]
    Io(#[from] io::Error),
}

/// The `.app` bundle holding `executable` (`<bundle>/Contents/MacOS/<name>`).
pub fn bundle_of(executable: &Path) -> Option<&Path> {
    let macos = executable.parent()?;
    if macos.file_name()? != "MacOS" {
        return None;
    }
    let contents = macos.parent()?;
    if contents.file_name()? != "Contents" {
        return None;
    }
    let bundle = contents.parent()?;
    (bundle.extension()? == "app").then_some(bundle)
}

/// Extracts `archive` beside `bundle`, checks it is the same app (and, given
/// `expected_version`, that version), and swaps it in. An error before the
/// swap leaves `bundle` untouched; an error during the swap puts the
/// previous bundle back.
pub fn replace_bundle(
    archive: &Path,
    bundle: &Path,
    expected_bundle_id: &str,
    expected_version: Option<&semver::Version>,
) -> Result<(), InstallError> {
    let parent = bundle
        .parent()
        .ok_or_else(|| InstallError::Archive("the bundle has no parent folder".into()))?;
    let name = bundle
        .file_name()
        .ok_or_else(|| InstallError::Archive("the bundle has no name".into()))?
        .to_string_lossy()
        .into_owned();
    let token = uuid::Uuid::new_v4().simple().to_string();
    // Siblings of the bundle, so both renames stay on one volume.
    let staging = parent.join(format!(".{name}.update-{token}"));
    let backup = parent.join(format!(".{name}.previous-{token}"));

    match std::fs::create_dir(&staging) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
            return Err(InstallError::NeedsAuthorization);
        }
        Err(error) => return Err(error.into()),
    }
    let staged = (|| {
        extract_app_archive(archive, &staging)?;
        check_bundle(&staging, expected_bundle_id, expected_version)
    })();
    if let Err(error) = staged {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }

    if let Err(error) = std::fs::rename(bundle, &backup) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(match error.kind() {
            io::ErrorKind::PermissionDenied => InstallError::NeedsAuthorization,
            _ => error.into(),
        });
    }
    if let Err(error) = std::fs::rename(&staging, bundle) {
        let _ = std::fs::rename(&backup, bundle);
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error.into());
    }
    let _ = std::fs::remove_dir_all(&backup);
    // Finder and Launch Services notice the new bundle sooner (Tauri does
    // the same).
    let _ = std::process::Command::new("/usr/bin/touch")
        .arg(bundle)
        .status();
    Ok(())
}

/// Unpacks the single top-level folder's contents into `destination`.
/// Refuses absolute paths, `..`, several top-level entries and writes
/// through a symbolic link the archive itself created.
fn extract_app_archive(archive: &Path, destination: &Path) -> Result<(), InstallError> {
    let file = std::fs::File::open(archive)?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    archive.set_preserve_permissions(true);
    archive.set_unpack_xattrs(false);
    archive.set_overwrite(false);
    let mut top: Option<OsString> = None;
    for entry in archive.entries().map_err(archive_error)? {
        let mut entry = entry.map_err(archive_error)?;
        let path = entry.path().map_err(archive_error)?.into_owned();
        let mut components = path.components();
        let first = match components.next() {
            Some(Component::Normal(first)) => first.to_owned(),
            Some(Component::CurDir) => match components.next() {
                Some(Component::Normal(first)) => first.to_owned(),
                None => continue,
                _ => {
                    return Err(InstallError::Archive(format!(
                        "unsafe path {}",
                        path.display()
                    )));
                }
            },
            _ => {
                return Err(InstallError::Archive(format!(
                    "unsafe path {}",
                    path.display()
                )));
            }
        };
        match &top {
            None => {
                if !Path::new(&first)
                    .extension()
                    .is_some_and(|ext| ext == "app")
                {
                    return Err(InstallError::Archive(
                        "the archive does not hold an .app".into(),
                    ));
                }
                top = Some(first);
            }
            Some(top) if *top != first => {
                return Err(InstallError::Archive(
                    "the archive holds more than one top-level entry".into(),
                ));
            }
            Some(_) => {}
        }
        let mut relative = PathBuf::new();
        for component in components {
            match component {
                Component::Normal(part) => relative.push(part),
                Component::CurDir => {}
                _ => {
                    return Err(InstallError::Archive(format!(
                        "unsafe path {}",
                        path.display()
                    )));
                }
            }
        }
        if relative.as_os_str().is_empty() {
            continue;
        }
        let target = destination.join(&relative);
        let mut ancestor = destination.to_path_buf();
        for part in relative.parent().into_iter().flat_map(Path::components) {
            ancestor.push(part);
            if std::fs::symlink_metadata(&ancestor).is_ok_and(|meta| meta.file_type().is_symlink())
            {
                return Err(InstallError::Archive(format!(
                    "{} writes through a symbolic link",
                    path.display()
                )));
            }
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        entry.unpack(&target).map_err(archive_error)?;
    }
    if top.is_none() {
        return Err(InstallError::Archive("the archive is empty".into()));
    }
    Ok(())
}

fn archive_error(error: io::Error) -> InstallError {
    InstallError::Archive(error.to_string())
}

/// `Contents/Info.plist` names the same bundle id, the expected version and
/// an executable that is there. `bundle-mac` writes the version's
/// `major.minor.patch` (`CFBundleShortVersionString` takes digits and dots
/// only), so that is what is compared.
fn check_bundle(
    bundle: &Path,
    expected_bundle_id: &str,
    expected_version: Option<&semver::Version>,
) -> Result<(), InstallError> {
    let plist = bundle.join("Contents/Info.plist");
    let text = std::fs::read_to_string(&plist)
        .map_err(|_| InstallError::Archive("the app has no readable Info.plist".into()))?;
    let found = plist_string(&text, "CFBundleIdentifier")
        .ok_or_else(|| InstallError::Archive("Info.plist names no bundle id".into()))?;
    if found != expected_bundle_id {
        return Err(InstallError::WrongApp {
            expected: expected_bundle_id.into(),
            found,
        });
    }
    if let Some(version) = expected_version {
        let expected = format!("{}.{}.{}", version.major, version.minor, version.patch);
        let found = plist_string(&text, "CFBundleShortVersionString").unwrap_or_default();
        if found != expected {
            return Err(InstallError::WrongVersion { expected, found });
        }
    }
    let executable = plist_string(&text, "CFBundleExecutable")
        .ok_or_else(|| InstallError::Archive("Info.plist names no executable".into()))?;
    if !bundle.join("Contents/MacOS").join(&executable).is_file() {
        return Err(InstallError::Archive(format!(
            "the executable {executable} is missing"
        )));
    }
    Ok(())
}

/// The string after `<key>name</key>` in an XML property list. Bundles are
/// built by our scripts as XML; a binary plist fails closed.
fn plist_string(text: &str, key: &str) -> Option<String> {
    let after = &text[text.find(&format!("<key>{key}</key>"))? + key.len() + 11..];
    let start = after.find("<string>")? + "<string>".len();
    let rest = &after[start..];
    let before_tag = &after[..start - "<string>".len()];
    if !before_tag.trim().is_empty() {
        return None;
    }
    let end = rest.find("</string>")?;
    Some(rest[..end].trim().to_owned())
}

/// How to start the NSIS installer for an update: Tauri's passive flags, so
/// one installer serves an update from either client.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstallerLaunch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
}

pub fn installer_launch(installer: &Path, relaunch_args: &[OsString]) -> InstallerLaunch {
    let mut args: Vec<OsString> = ["/P", "/R", "/UPDATE", "/ARGS"]
        .into_iter()
        .map(OsString::from)
        .collect();
    args.extend(relaunch_args.iter().cloned());
    InstallerLaunch {
        program: installer.to_owned(),
        args,
    }
}

impl InstallerLaunch {
    /// Installs without reopening the app afterwards (an update installed as
    /// the author quits): Tauri's flags without `/R`.
    pub fn without_relaunch(mut self) -> Self {
        self.args.retain(|arg| arg != "/R");
        self
    }

    /// Starts the installer. The caller then quits so the installer can
    /// replace the executable.
    pub fn spawn(&self) -> io::Result<()> {
        std::process::Command::new(&self.program)
            .args(&self.args)
            .spawn()
            .map(drop)
    }
}

/// Synthetic bundles and update archives for tests (other crates' with the
/// `test-support` feature). Nothing here is a real build.
#[cfg(any(test, feature = "test-support"))]
pub mod test_bundles {
    use std::path::{Path, PathBuf};

    /// A synthetic bundle whose executable holds `marker`, at `version`
    /// (written as `bundle-mac` writes it: `major.minor.patch`).
    pub fn write_app(dir: &Path, bundle_id: &str, marker: &str, version: &str) -> PathBuf {
        let app = dir.join("Drifting.app");
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        let short = version.split('-').next().unwrap();
        std::fs::write(
            app.join("Contents/Info.plist"),
            format!(
                "<?xml version=\"1.0\"?>\n<plist version=\"1.0\"><dict>\n  <key>CFBundleExecutable</key><string>drifting</string>\n  <key>CFBundleIdentifier</key>\n  <string>{bundle_id}</string>\n  <key>CFBundleShortVersionString</key><string>{short}</string>\n</dict></plist>\n"
            ),
        )
        .unwrap();
        std::fs::write(app.join("Contents/MacOS/drifting"), marker).unwrap();
        app
    }

    /// A `.app.tar.gz` laid out as Tauri's bundler and `bundle-mac` make it.
    pub fn archive_of(app: &Path, output: &Path) {
        let file = std::fs::File::create(output).unwrap();
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            file,
            flate2::Compression::fast(),
        ));
        builder
            .append_dir_all(app.file_name().unwrap(), app)
            .unwrap();
        builder.into_inner().unwrap().finish().unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::test_bundles::{archive_of, write_app};
    use super::*;
    use std::io::Write as _;

    #[test]
    fn replaces_the_bundle_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let built = tempfile::tempdir().unwrap();
        let installed = write_app(dir.path(), "cc.drifting.next.dev", "old", "0.2.0");
        std::fs::write(installed.join("Contents/stale-file"), "x").unwrap();
        let app = write_app(built.path(), "cc.drifting.next.dev", "new", "0.2.1");
        let archive = built.path().join("Drifting.app.tar.gz");
        archive_of(&app, &archive);

        let offered = semver::Version::parse("0.2.1").unwrap();
        replace_bundle(&archive, &installed, "cc.drifting.next.dev", Some(&offered)).unwrap();
        assert_eq!(
            std::fs::read_to_string(installed.join("Contents/MacOS/drifting")).unwrap(),
            "new"
        );
        assert!(!installed.join("Contents/stale-file").exists());
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(leftovers, vec![OsString::from("Drifting.app")]);
    }

    #[test]
    fn refuses_another_app_and_leaves_the_bundle_alone() {
        let dir = tempfile::tempdir().unwrap();
        let built = tempfile::tempdir().unwrap();
        let installed = write_app(dir.path(), "cc.drifting.next.dev", "old", "0.2.0");
        let app = write_app(built.path(), "com.example.other", "evil", "0.2.1");
        let archive = built.path().join("Other.app.tar.gz");
        archive_of(&app, &archive);
        assert!(matches!(
            replace_bundle(&archive, &installed, "cc.drifting.next.dev", None),
            Err(InstallError::WrongApp { .. })
        ));
        assert_eq!(
            std::fs::read_to_string(installed.join("Contents/MacOS/drifting")).unwrap(),
            "old"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn refuses_an_older_bundle_offered_as_a_newer_version() {
        let dir = tempfile::tempdir().unwrap();
        let built = tempfile::tempdir().unwrap();
        let installed = write_app(dir.path(), "cc.drifting.next.dev", "old", "0.2.1");
        let app = write_app(built.path(), "cc.drifting.next.dev", "older", "0.2.0");
        let archive = built.path().join("Drifting.app.tar.gz");
        archive_of(&app, &archive);
        let offered = semver::Version::parse("0.2.2").unwrap();
        assert!(matches!(
            replace_bundle(&archive, &installed, "cc.drifting.next.dev", Some(&offered)),
            Err(InstallError::WrongVersion { ref expected, ref found })
                if expected == "0.2.2" && found == "0.2.0"
        ));
        assert_eq!(
            std::fs::read_to_string(installed.join("Contents/MacOS/drifting")).unwrap(),
            "old"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn refuses_archives_that_escape_or_are_not_an_app() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("out");
        std::fs::create_dir(&destination).unwrap();

        // `tar::Builder` refuses to write `..`, so assemble the header by hand.
        let traversal = dir.path().join("traversal.tar.gz");
        {
            let file = std::fs::File::create(&traversal).unwrap();
            let mut gz = flate2::write::GzEncoder::new(file, flate2::Compression::fast());
            let mut header = tar::Header::new_gnu();
            let name = b"Drifting.app/../../escaped";
            header.as_gnu_mut().unwrap().name[..name.len()].copy_from_slice(name);
            header.set_size(1);
            header.set_mode(0o644);
            header.set_entry_type(tar::EntryType::Regular);
            header.set_cksum();
            gz.write_all(header.as_bytes()).unwrap();
            gz.write_all(b"x").unwrap();
            gz.write_all(&[0; 511]).unwrap();
            gz.write_all(&[0; 1024]).unwrap();
            gz.finish().unwrap();
        }
        assert!(matches!(
            extract_app_archive(&traversal, &destination),
            Err(InstallError::Archive(_))
        ));
        assert!(!dir.path().join("escaped").exists());

        let not_app = dir.path().join("notapp.tar.gz");
        let folder = dir.path().join("Folder");
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(folder.join("file"), "x").unwrap();
        archive_of(&folder, &not_app);
        assert!(matches!(
            extract_app_archive(&not_app, &destination),
            Err(InstallError::Archive(_))
        ));
    }

    #[test]
    fn refuses_writes_through_a_link_the_archive_made() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("out");
        std::fs::create_dir(&destination).unwrap();
        let outside = dir.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        let archive = dir.path().join("link.tar.gz");
        {
            let file = std::fs::File::create(&archive).unwrap();
            let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
                file,
                flate2::Compression::fast(),
            ));
            let mut link = tar::Header::new_gnu();
            link.set_entry_type(tar::EntryType::Symlink);
            link.set_size(0);
            builder
                .append_link(&mut link, "Drifting.app/Contents", &outside)
                .unwrap();
            let mut file_header = tar::Header::new_gnu();
            file_header.set_size(1);
            file_header.set_mode(0o644);
            builder
                .append_data(&mut file_header, "Drifting.app/Contents/planted", &b"x"[..])
                .unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }
        assert!(matches!(
            extract_app_archive(&archive, &destination),
            Err(InstallError::Archive(_))
        ));
        assert!(!outside.join("planted").exists());
    }

    #[test]
    fn finds_the_bundle_of_its_executable() {
        assert_eq!(
            bundle_of(Path::new(
                "/Applications/Drifting.app/Contents/MacOS/drifting"
            )),
            Some(Path::new("/Applications/Drifting.app"))
        );
        assert_eq!(bundle_of(Path::new("/usr/local/bin/drifting")), None);
    }

    #[test]
    fn the_installer_gets_tauris_update_flags() {
        let launch = installer_launch(
            Path::new("C:/Temp/Drifting-setup.exe"),
            &[OsString::from("--from-update")],
        );
        assert_eq!(
            launch.args,
            ["/P", "/R", "/UPDATE", "/ARGS", "--from-update"]
                .map(OsString::from)
                .to_vec()
        );
        assert_eq!(
            launch.without_relaunch().args,
            ["/P", "/UPDATE", "/ARGS", "--from-update"]
                .map(OsString::from)
                .to_vec()
        );
    }

    #[test]
    fn reads_plist_strings_with_any_spacing() {
        let text = "<key>CFBundleIdentifier</key>\n\t<string> cc.x </string><key>B</key><string>y</string>";
        assert_eq!(
            plist_string(text, "CFBundleIdentifier").as_deref(),
            Some("cc.x")
        );
        assert_eq!(plist_string(text, "B").as_deref(), Some("y"));
        assert_eq!(plist_string(text, "C"), None);
        assert_eq!(
            plist_string("<key>A</key><true/><string>z</string>", "A"),
            None
        );
    }
}
