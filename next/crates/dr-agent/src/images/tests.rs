use super::*;

fn encode(format: image::ImageFormat) -> Vec<u8> {
    let picture = image::load_from_memory(&dr_testkit::media::quadrants(60, 40))
        .unwrap()
        .to_rgb8();
    let mut out = std::io::Cursor::new(Vec::new());
    picture.write_to(&mut out, format).unwrap();
    out.into_inner()
}

#[test]
fn png_jpeg_and_webp_are_read_from_their_bytes_and_nothing_else_is() {
    let png = dr_testkit::media::png(320, 200);
    let image = inspect(&png).unwrap();
    assert_eq!(
        image,
        ImageRef {
            sha256: format!("{:x}", Sha256::digest(&png)),
            mime: "image/png".into(),
            width: 320,
            height: 200,
            size: png.len() as u64,
        }
    );
    assert!(image.is_valid());
    assert_eq!(image.extension(), Some("png"));
    for (format, mime, extension) in [
        (image::ImageFormat::Jpeg, "image/jpeg", "jpg"),
        (image::ImageFormat::WebP, "image/webp", "webp"),
    ] {
        let image = inspect(&encode(format)).unwrap();
        assert_eq!(
            (image.mime.as_str(), image.width, image.height),
            (mime, 60, 40)
        );
        assert_eq!(image.extension(), Some(extension));
    }
    // HEIC and AVIF (what an iPhone or a web page often gives), a GIF, a
    // PDF and text are not sent.
    let gif = b"GIF89a\x01\x00\x01\x00\x00\x00\x00;".to_vec();
    for bytes in [
        dr_testkit::media::HEIC.to_vec(),
        dr_testkit::media::AVIF.to_vec(),
        gif,
        dr_testkit::media::sample_pdf(),
        "不是图片".as_bytes().to_vec(),
        Vec::new(),
    ] {
        assert_eq!(inspect(&bytes), Err(ImageError::Unsupported));
    }
    // A PNG whose body is cut off still has its size; one whose header is
    // cut is not an image.
    assert_eq!(inspect(&png[..png.len() / 2]).unwrap().width, 320);
    assert_eq!(inspect(&png[..12]), Err(ImageError::Unsupported));
}

#[test]
fn the_limits_are_a_side_of_8000_pixels_and_7_mib() {
    assert_eq!(
        inspect(&dr_testkit::media::png(8000, 1)).unwrap().width,
        8000
    );
    assert_eq!(
        inspect(&dr_testkit::media::png(8001, 1)),
        Err(ImageError::TooLarge)
    );
    assert_eq!(
        inspect(&dr_testkit::media::png(1, 8001)),
        Err(ImageError::TooLarge)
    );
    let mut big = dr_testkit::media::png(4, 4);
    big.resize(MAX_IMAGE_BYTES as usize + 1, 0);
    assert_eq!(inspect(&big), Err(ImageError::TooLarge));
}

#[test]
fn a_message_payload_names_its_images_and_one_without_is_unchanged() {
    let image = inspect(&dr_testkit::media::png(4, 3)).unwrap();
    assert_eq!(user_payload("潮声", &[]), json!({"text":"潮声"}));
    let payload = user_payload("", std::slice::from_ref(&image));
    assert_eq!(payload["text"], "");
    assert_eq!(payload_images(&payload), vec![Some(image.clone())]);
    // A record another device should not have written keeps its place
    // and is left out: a digest that is a path, an unknown format, sizes
    // out of range, a missing field.
    let mut path = serde_json::to_value(&image).unwrap();
    path["sha256"] = json!("../../library");
    let mut gif = serde_json::to_value(&image).unwrap();
    gif["mime"] = json!("image/gif");
    let mut huge = serde_json::to_value(&image).unwrap();
    huge["size"] = json!(MAX_IMAGE_BYTES + 1);
    let mut wide = serde_json::to_value(&image).unwrap();
    wide["width"] = json!(0);
    let payload =
        json!({"text":"", "images":[path, gif, huge, wide, {"sha256":image.sha256}, image]});
    let read = payload_images(&payload);
    assert_eq!(read.len(), 6);
    assert!(read[..5].iter().all(Option::is_none));
    assert_eq!(read[5].as_ref(), Some(&image));
    assert!(payload_images(&json!({"text":"x","images":"no"})).is_empty());
}

fn fake(n: u64, size: u64) -> ImageRef {
    ImageRef {
        sha256: format!("{n:064x}"),
        mime: "image/png".into(),
        width: 10,
        height: 10,
        size,
    }
}

fn message(id: &str, images: &[ImageRef]) -> dr_model::conversation::ConversationEntry {
    dr_model::conversation::ConversationEntry {
        id: id.into(),
        session: "s".into(),
        turn: 1,
        kind: dr_model::conversation::ConversationEntryKind::User,
        payload: user_payload("", images),
    }
}

#[test]
fn a_request_carries_the_newest_images_within_its_limits() {
    let bytes: Arc<[u8]> = Arc::from(&b"bytes"[..]);
    // Six messages of four small images: the newest twenty go.
    let small: Vec<_> = (0..6)
        .map(|m| {
            message(
                &format!("m{m}"),
                &(0..4).map(|i| fake(m * 4 + i, 100)).collect::<Vec<_>>(),
            )
        })
        .collect();
    let mut asked = Vec::new();
    let chosen = select(&small, |image| {
        asked.push(image.sha256.clone());
        Some(bytes.clone())
    });
    assert_eq!(chosen.len(), MAX_IMAGES_PER_REQUEST);
    for m in 1..6 {
        for i in 0..4 {
            assert!(chosen.get(&format!("m{m}"), i).is_some(), "m{m} {i}");
        }
    }
    assert!((0..4).all(|i| chosen.get("m0", i).is_none()));
    assert_eq!(asked.len(), 20, "an image that does not go is not read");
    // Four of 7 MiB fit (28 MiB); a fifth would pass 32 MiB, a 1 MiB one still fits.
    let big = MAX_IMAGE_BYTES;
    let conversation = vec![
        message("old", &[fake(1, 1024 * 1024)]),
        message("older", &[fake(2, big)]),
        message(
            "new",
            &[fake(3, big), fake(4, big), fake(5, big), fake(6, big)],
        ),
    ];
    let chosen = select(&conversation, |_| Some(bytes.clone()));
    assert!((0..4).all(|i| chosen.get("new", i).is_some()));
    assert!(chosen.get("older", 0).is_none());
    assert!(chosen.get("old", 0).is_some());
    // Bytes this device does not hold are left out without taking a place;
    // an assistant message and a record that is not valid are not images.
    let mut assistant = message("assistant", &[fake(7, 100)]);
    assistant.kind = dr_model::conversation::ConversationEntryKind::Assistant;
    let mut invalid = message("invalid", &[fake(8, 100)]);
    invalid.payload["images"][0]["sha256"] = json!("../x");
    let chosen = select(
        &[
            message("here", &[fake(9, 100), fake(10, 100)]),
            assistant,
            invalid,
        ],
        |image| (image.sha256 != format!("{:064x}", 9)).then(|| bytes.clone()),
    );
    assert_eq!(chosen.len(), 1);
    assert!(chosen.get("here", 1).is_some());
}

#[test]
fn the_same_bytes_are_one_file_and_changed_bytes_are_not_read() {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path(), dr_workspace::library_options("cm4a")).unwrap();
    let conversation = ConversationId::new_v7();
    let other = ConversationId::new_v7();
    let png = dr_testkit::media::png(64, 48);
    let image = put(&lib, &conversation, &png).unwrap();
    assert_eq!(put(&lib, &conversation, &png).unwrap(), image);
    let folder = dir.path().join(DIR).join(conversation.as_str());
    let files: Vec<_> = std::fs::read_dir(&folder)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(files, [format!("{}.png", image.sha256)]);
    assert_eq!(read(&lib, &conversation, &image).unwrap(), png);
    // Another conversation does not hold them.
    assert_eq!(read(&lib, &other, &image), None);
    // Bytes that changed on disk are not these.
    let path = folder.join(&files[0]);
    let mut changed = png.clone();
    *changed.last_mut().unwrap() ^= 1;
    std::fs::write(&path, &changed).unwrap();
    assert_eq!(read(&lib, &conversation, &image), None);
    // Putting them again repairs the file.
    put(&lib, &conversation, &png).unwrap();
    assert_eq!(read(&lib, &conversation, &image).unwrap(), png);
    // A record that is not valid never becomes a path.
    let mut escape = image.clone();
    escape.sha256 = "../".repeat(21) + "a";
    assert_eq!(read(&lib, &conversation, &escape), None);
    assert!(put(&lib, &conversation, dr_testkit::media::HEIC).is_err());
}
