//! The inputs the fuzz targets crashed on (`fuzz/`), replayed through the
//! same code the target runs. Both are fuzzer-made bytes (synthetic):
//!
//! - `load-bytes-unchecked-checksum.bin`: a corrupted blob that made Loro
//!   1.17.1's `import_batch` ask for 28.7 GB (`loro-dev/loro#1262`, fixed
//!   upstream in 1.18.0); `core.rs` also checks every blob first.
//! - `load-bytes-anchor-missing-container.bin`: an anchor naming a container
//!   that does not exist, on which Loro panics; fixed in `anchor.rs`.

#[path = "../fuzz/fuzz_targets/common.rs"]
mod common;

use dr_doc::import_v1::BookDoc;
use dr_doc::prose::ProseDoc;
use dr_model::id::BookId;
use dr_model::{DocId, Origin};

fn split_blobs(data: &[u8]) -> Vec<Vec<u8>> {
    let (head, rest) = data.split_at(data.len().min(2));
    let mut blobs = Vec::new();
    let mut cut = 0;
    for b in head {
        let at = (*b as usize).min(rest.len());
        if at > cut {
            blobs.push(rest[cut..at].to_vec());
            cut = at;
        }
    }
    blobs.push(rest[cut..].to_vec());
    blobs
}

/// What the `load_bytes` target does with one input.
fn load_bytes(data: &[u8]) {
    let blobs = split_blobs(data);
    let id = DocId::parse("node:fuzz").unwrap();
    if let Ok(mut d) = ProseDoc::load(id.clone(), 7, &blobs) {
        common::exercise_prose(&mut d, data);
    }
    let mut d = ProseDoc::create(id, 7).unwrap();
    for b in &blobs {
        let _ = d.import(b, Origin::Sync);
    }
    common::exercise_prose(&mut d, data);
    let book = BookId::parse("fuzz").unwrap();
    if let Ok(mut b) = BookDoc::load(book.clone(), 7, &blobs) {
        common::exercise_book(&mut b);
    }
    let mut b = BookDoc::create(book, 7).unwrap();
    for x in &blobs {
        let _ = b.import(x, Origin::Sync);
    }
    common::exercise_book(&mut b);
}

#[test]
fn a_blob_with_a_bad_checksum_is_an_error_not_an_allocation() {
    let data = include_bytes!("fuzz-regressions/load-bytes-unchecked-checksum.bin");
    load_bytes(data);
    // Direct `import_batch` check for upstream `loro-dev/loro#1262` (1.18.0).
    assert!(
        loro::LoroDoc::new()
            .import_batch(&split_blobs(data))
            .is_err()
    );
}

#[test]
fn an_anchor_into_a_missing_container_does_not_panic() {
    load_bytes(include_bytes!(
        "fuzz-regressions/load-bytes-anchor-missing-container.bin"
    ));
}

fn unhex(hex: &str) -> Vec<u8> {
    assert_eq!(hex.len() % 2, 0);
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}

/// Synthetic snapshot + incremental update produced by `loro = "=1.17.1"`
/// (`loro-internal = "=1.17.1"`, `loro-common = "=1.17.0"`): genesis, a
/// bold-marked H1 paragraph in the snapshot, and a paragraph split + body
/// continuation in the incremental update.
#[test]
fn loro_1_17_1_snapshot_and_update_load_cleanly_in_1_18_0() {
    let snapshot = unhex(concat!(
        "6c6f726f0000000000000000000000002c62880c0003740100004c4f524f0000",
        "0b050b011b022a0000000000000052ac043577b8e9e901010101010108000000",
        "090182c49fd50c000100060104010200041204626f6c640768656164696e6704",
        "626f647900170104020a000506000312110609050c000c000401070801001f15",
        "e4b880e4b883e4b880e5bfabe785a7e6aeb5e890bd8403000180030103010002",
        "006672012a14000200767602d2d892a8f38eeef4e9010a2a16000c00e9e9b877",
        "3504ac52000000000005000501100152ac043577b8e9e9010100000000000501",
        "000001000b020401000006040102000814017603646f6303626964046d657461",
        "04626f6479001a0104060400010204000605000201040006040b05050c00020a",
        "0100300302050f6e6f64653a636f6d7061742d313137010a8001020516304031",
        "3638353532303539303235343039303936353000007f0087009a00040089aa08",
        "a601000000050000000c00000000000000002a00000000000c00e9e9b8773504",
        "ac5200000000d1ec814147010000f30000004c4f524f00000100020176030403",
        "646f63040f6e6f64653a636f6d7061742d313137000152ac043577b8e9e90001",
        "00000006008204626f647902010016e4b880e4b883e4b880e5bfabe785a7e6ae",
        "b5e890bd0a022a0000000000000052ac043577b8e9e90304080a000102040001",
        "010a110e0d10090c0b01040c0a010a080001090400010a0a110006070a070002",
        "03000304626f6c640768656164696e6703626964030300010184030103028003",
        "020416304031363835353230353930323534303930393635308000002b000200",
        "9b005ae70100000005000000060080046d6574610006008204626f64798cc0b4",
        "f8d200000000000000",
    ));
    let update = unhex(concat!(
        "6c6f726f000000000000000000000000df469fe400048a010b0d100d0111012a",
        "000000000000000001010000000000090182c49fd50c00010006010401020004",
        "11036269640768656164696e6704626f6479002001040212000a111200111211",
        "242324230a11050c000c000c000c000401051001002c0d0ae5a29ee9878fe7bb",
        "ade586998001000506702d736e61708003010301860501008006000505702d75",
        "7064",
    ));
    let id = DocId::parse("node:compat-117").unwrap();
    let mut doc = ProseDoc::load(id, 99, &[snapshot, update]).unwrap();
    let paras: Vec<_> = doc.view().paragraphs().collect();
    assert_eq!(paras.len(), 2);
    assert_eq!(paras[0].text(), "一七一快照段落");
    assert_eq!(paras[0].attrs.heading, Some(dr_model::prose::Heading::H1));
    assert!(paras[0].runs[0].marks.bold);
    assert_eq!(paras[1].text(), "增量续写");
    assert_eq!(paras[1].attrs.heading, None);

    let mut undo = doc.undo_manager();
    let (r, _) = doc.edit(Origin::User, |t| t.insert_text(0, "新"));
    r.unwrap();
    assert_eq!(
        doc.view().paragraphs().next().unwrap().text(),
        "新一七一快照段落"
    );
    assert!(undo.undo(&mut doc).unwrap().is_some());
    assert_eq!(
        doc.view().paragraphs().next().unwrap().text(),
        "一七一快照段落"
    );
}
