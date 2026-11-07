//! The library notices on its own when it was moved to another device or
//! replaced by an older copy, and starts a new epoch (loro-schema: a copy
//! that kept its peers would silently diverge).

mod common;

use std::fs;
use std::path::Path;

use common::*;
use dr_store::EpochChange;
use dr_store::{Device, Library, OpenDoc, Origin};

fn open_on(lib: &Path, device: &Path) -> Library {
    let mut o = options();
    o.device = Some(Device::open(device).unwrap());
    Library::open(lib, o).unwrap()
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

fn edit(lib: &Library, s: &str) {
    let h = lib
        .open_doc("node:a", OpenDoc::Existing)
        .or_else(|_| Ok::<_, ()>(create(lib, "node:a")))
        .unwrap();
    insert(&h, Origin::User, 0, s);
    h.close();
}

#[test]
fn a_normal_reopen_keeps_the_epoch_and_peers() {
    let tmp = tempfile::tempdir().unwrap();
    let (lib_dir, dev) = (tmp.path().join("lib"), tmp.path().join("device"));
    let lib = open_on(&lib_dir, &dev);
    assert_eq!(lib.epoch_change(), None);
    edit(&lib, "一");
    let (epoch, peer) = (lib.epoch(), lib.peer_for("node:a").unwrap());
    lib.close().unwrap();
    let lib = open_on(&lib_dir, &dev);
    assert_eq!(lib.epoch_change(), None);
    assert_eq!(lib.epoch(), epoch);
    assert_eq!(lib.peer_for("node:a").unwrap(), peer);
}

#[test]
fn a_library_opened_on_another_device_gets_a_new_epoch() {
    let tmp = tempfile::tempdir().unwrap();
    let lib_dir = tmp.path().join("lib");
    let lib = open_on(&lib_dir, &tmp.path().join("mac-a"));
    edit(&lib, "一");
    let (epoch, peer) = (lib.epoch(), lib.peer_for("node:a").unwrap());
    lib.close().unwrap();
    // Copied to another machine (another installation id).
    let lib = open_on(&lib_dir, &tmp.path().join("mac-b"));
    assert_eq!(lib.epoch_change(), Some(EpochChange::OtherDevice));
    assert_ne!(lib.epoch(), epoch);
    assert_ne!(lib.peer_for("node:a").unwrap(), peer);
    let rotated = lib.epoch();
    lib.close().unwrap();
    // It stays put on the new machine.
    let lib = open_on(&lib_dir, &tmp.path().join("mac-b"));
    assert_eq!(lib.epoch_change(), None);
    assert_eq!(lib.epoch(), rotated);
}

#[test]
fn an_older_copy_put_back_gets_a_new_epoch_once() {
    let tmp = tempfile::tempdir().unwrap();
    let (lib_dir, dev, backup) = (
        tmp.path().join("lib"),
        tmp.path().join("device"),
        tmp.path().join("backup"),
    );
    let lib = open_on(&lib_dir, &dev);
    edit(&lib, "一");
    lib.close().unwrap();
    copy_dir(&lib_dir, &backup); // a Time Machine copy

    let lib = open_on(&lib_dir, &dev);
    edit(&lib, "二");
    edit(&lib, "三");
    // The new edits leave the device.
    lib.sync_to_disk().unwrap();
    let (epoch, peer) = (lib.epoch(), lib.peer_for("node:a").unwrap());
    lib.close().unwrap();

    // The older copy is put back in place.
    fs::remove_dir_all(&lib_dir).unwrap();
    copy_dir(&backup, &lib_dir);
    let lib = open_on(&lib_dir, &dev);
    assert_eq!(lib.epoch_change(), Some(EpochChange::OlderCopy));
    assert_ne!(lib.epoch(), epoch);
    assert_ne!(
        lib.peer_for("node:a").unwrap(),
        peer,
        "no reuse of the ops that left"
    );
    assert_eq!(text(&lib.load_copy("node:a").unwrap()), "一\n");
    let rotated = lib.epoch();
    lib.close().unwrap();
    let lib = open_on(&lib_dir, &dev);
    assert_eq!(lib.epoch_change(), None, "rotates once, not on every open");
    assert_eq!(lib.epoch(), rotated);
}

#[test]
fn the_writing_day_key_comes_from_the_0_1_identity_file() {
    let tmp = tempfile::tempdir().unwrap();
    let id = format!("install-{}", "0f".repeat(32));
    fs::write(
        tmp.path().join("sync-installation-v2.json"),
        format!("{{\"version\":2,\"installation_id\":\"{id}\"}}"),
    )
    .unwrap();
    let device = Device::open(tmp.path()).unwrap();
    assert_eq!(device.installation_id(), id);
    assert_eq!(
        device.writing_device_key(),
        dr_store::identity::writing_device_key(&id)
    );
}

#[test]
fn moving_the_app_data_and_the_library_to_another_machine_is_noticed() {
    let tmp = tempfile::tempdir().unwrap();
    let (lib_dir, dev) = (tmp.path().join("lib"), tmp.path().join("device"));
    let open_as = |machine: &str| {
        let mut o = options();
        o.device = Some(Device::open_with_machine_id(&dev, Some(machine.into())).unwrap());
        Library::open(&lib_dir, o).unwrap()
    };
    let lib = open_as("MACHINE-A");
    edit(&lib, "一");
    let (epoch, peer) = (lib.epoch(), lib.peer_for("node:a").unwrap());
    let key_a = lib.options().device.as_ref().unwrap().writing_device_key();
    lib.close().unwrap();
    // Migration Assistant: the identity file and the library both arrive on
    // machine B. Without the machine binding both would look unchanged.
    let lib = open_as("MACHINE-B");
    let device = lib.options().device.clone().unwrap();
    assert!(device.machine_changed());
    assert_ne!(
        device.writing_device_key(),
        key_a,
        "a new device for writing days"
    );
    assert_eq!(lib.epoch_change(), Some(EpochChange::OtherDevice));
    assert_ne!(lib.epoch(), epoch);
    assert_ne!(lib.peer_for("node:a").unwrap(), peer);
    lib.close().unwrap();
    let lib = open_as("MACHINE-B");
    assert_eq!(lib.epoch_change(), None, "settled on the new machine");
}

/// M10: the device takes over the 0.1 installation id of the library it
/// imports. Its writing-day key is the 0.1 one at once (the library's own
/// options read it), and the library, reopened, sees the same device: no
/// new epoch.
#[test]
fn a_taken_over_0_1_identity_is_the_same_device_on_the_next_open() {
    let tmp = tempfile::tempdir().unwrap();
    let (root, dev) = (tmp.path().join("lib"), tmp.path().join("device"));
    let lib = open_on(&root, &dev);
    edit(&lib, "x");
    let epoch = lib.epoch();
    let old = format!("install-{}", "1a".repeat(32));
    assert!(lib.adopt_installation_id(&old).unwrap());
    let device = lib.options().device.clone().unwrap();
    assert_eq!(
        device.writing_device_key(),
        dr_store::identity::writing_device_key(&old)
    );
    assert!(!lib.adopt_installation_id(&old).unwrap(), "already");
    lib.close().unwrap();

    let lib = open_on(&root, &dev);
    assert_eq!(lib.epoch_change(), None);
    assert_eq!(lib.epoch(), epoch);
    assert_eq!(
        lib.options().device.as_ref().unwrap().installation_id(),
        old
    );
    lib.close().unwrap();

    // Without a device there is nothing to take over.
    let lib = Library::open(&root, options()).unwrap();
    assert!(!lib.adopt_installation_id(&old).unwrap());
    lib.close().unwrap();
}

/// Two machines that both took over the same 0.1 installation id (the old
/// data folder was copied from one to the other and imported on both) are
/// still two devices for a library copied between them: the library records
/// the machine too.
#[test]
fn a_library_copied_between_machines_sharing_a_0_1_identity_gets_a_new_epoch() {
    let tmp = tempfile::tempdir().unwrap();
    let old = format!("install-{}", "2b".repeat(32));
    let on = |machine: &str| {
        let device = Device::open_with_machine_id(
            tmp.path().join(format!("device-{machine}")),
            Some(machine.into()),
        )
        .unwrap();
        let root = tmp.path().join(format!("lib-{machine}"));
        let mut o = options();
        o.device = Some(device);
        (root, o)
    };
    let (root_a, options_a) = on("MACHINE-A");
    let lib = Library::open(&root_a, options_a).unwrap();
    assert!(lib.adopt_installation_id(&old).unwrap());
    edit(&lib, "一");
    let (epoch, peer) = (lib.epoch(), lib.peer_for("node:a").unwrap());
    lib.close().unwrap();

    // Machine B took over the same 0.1 id, then the library folder is
    // copied there.
    let (root_b, options_b) = on("MACHINE-B");
    {
        let scratch = Library::open(tmp.path().join("scratch"), options_b.clone()).unwrap();
        assert!(scratch.adopt_installation_id(&old).unwrap());
        scratch.close().unwrap();
    }
    copy_dir(&root_a, &root_b);
    let lib = Library::open(&root_b, options_b.clone()).unwrap();
    assert_eq!(lib.epoch_change(), Some(EpochChange::OtherDevice));
    assert_ne!(lib.epoch(), epoch);
    assert_ne!(lib.peer_for("node:a").unwrap(), peer);
    lib.close().unwrap();
    let lib = Library::open(&root_b, options_b).unwrap();
    assert_eq!(lib.epoch_change(), None, "settled on machine B");
    lib.close().unwrap();
}
