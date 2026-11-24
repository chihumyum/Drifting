//! CM4a: an author message with images, through the real runtime and a
//! scripted model. The images are dr-testkit's synthetic PNGs.

use std::sync::Arc;

use dr_agent::{
    driver::scripted::{ScriptedDriver, Step},
    images::{DIR, MAX_IMAGES_PER_MESSAGE},
    tools::ToolOutput,
    *,
};
use dr_model::{
    DocId,
    id::{BookId, ConversationId},
};
use dr_store::Library;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Workspace, WorkspaceOptions, library_options};
use futures::{FutureExt, future::BoxFuture};

struct NoTools;
impl ToolExecutor for NoTools {
    fn descriptors(&self) -> Vec<ToolDescriptor> {
        Vec::new()
    }
    fn execute(
        &self,
        _context: ToolContext,
        _call: ToolCall,
    ) -> BoxFuture<'static, Result<ToolOutput>> {
        async { Err(Error::Tool("no tools here".into())) }.boxed()
    }
}

fn setup() -> (tempfile::TempDir, Workspace, BookId) {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path(), library_options("cm4a")).unwrap();
    let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    let book = seeded.books[0].book_id().clone();
    seeded.write_to(&lib).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    (dir, ws, book)
}

fn reply(text: &str) -> Vec<Step> {
    vec![
        Step::Event(DriverEvent::TextDelta {
            index: 0,
            text: text.into(),
        }),
        Step::Event(DriverEvent::Finish(FinishReason::Complete)),
    ]
}

/// A model whose list says it takes images.
fn seeing() -> RunConfig {
    let mut config = RunConfig::new(Provider::Anthropic, "synthetic-seeing");
    config.capabilities = Some(ModelCapabilities {
        context_window: Some(200_000),
        image_input: Some(true),
        ..Default::default()
    });
    config
}

/// A model whose list says nothing about images (on the OpenAI API route
/// every model sees them: `an_openai_api_model_gets_the_bytes_whatever_its_list_says`).
fn blind() -> RunConfig {
    let mut config = RunConfig::new(Provider::Anthropic, "synthetic-blind");
    config.capabilities = Some(ModelCapabilities {
        context_window: Some(200_000),
        ..Default::default()
    });
    config
}

fn attach(images: &[&Vec<u8>]) -> ImageAttachments {
    ImageAttachments {
        images: images
            .iter()
            .map(|bytes| Arc::from(bytes.as_slice()))
            .collect(),
        unseen_reply: "这个模型看不了图片".into(),
    }
}

fn start(book: &BookId, conversation: &ConversationId, config: RunConfig, text: &str) -> Start {
    Start {
        config,
        book: book.clone(),
        conversation: conversation.clone(),
        input: text.into(),
    }
}

#[test]
fn a_seeing_model_gets_the_bytes_and_the_conversation_names_them() {
    let (dir, ws, book) = setup();
    let driver = Arc::new(ScriptedDriver::new(vec![
        reply("一张地图"),
        reply("还是那张地图"),
    ]));
    let runtime = Runtime::new(
        ws.clone(),
        driver.clone(),
        Arc::new(NoTools),
        Options::default(),
    )
    .unwrap();
    let conversation = ConversationId::new_v7();
    let (map, quadrants) = (
        dr_testkit::media::png(320, 200),
        dr_testkit::media::quadrants(60, 40),
    );
    let run = runtime
        .start_with_images(
            start(&book, &conversation, seeing(), "照这张草图建一个模块"),
            attach(&[&map, &quadrants, &map]),
        )
        .unwrap();
    assert_eq!(run.join().unwrap(), State::Completed);

    // The synchronized conversation names the images, never their bytes.
    let transcript = conversation_entries(&ws, &conversation);
    let payload = &transcript[0].payload;
    assert_eq!(payload["text"], "照这张草图建一个模块");
    let named = images::payload_images(payload);
    assert_eq!(named.len(), 3);
    let first = named[0].clone().unwrap();
    assert_eq!(
        (first.width, first.height, first.mime.as_str()),
        (320, 200, "image/png")
    );
    assert_eq!(named[2], named[0], "the same bytes twice are one image");
    assert!(!payload.to_string().contains("base64"));
    assert!(payload.to_string().len() < 1024);

    // The bytes are on this device, one file for the same bytes.
    let folder = dir.path().join(DIR).join(conversation.as_str());
    assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 2);
    assert_eq!(
        images::read(ws.library(), &conversation, &first).unwrap(),
        map
    );

    // The request carries all three, by the message's id and place.
    let requests = driver.requests();
    let user = requests[0]
        .conversation
        .iter()
        .find(|e| e.payload.get("images").is_some())
        .unwrap();
    assert_eq!(requests[0].images.len(), 3);
    assert_eq!(requests[0].images.get(&user.id, 0).unwrap(), map.as_slice());
    assert_eq!(
        requests[0].images.get(&user.id, 1).unwrap(),
        quadrants.as_slice()
    );

    // A later text-only message in the conversation still carries them.
    let run = runtime
        .start(start(&book, &conversation, seeing(), "再看一遍"))
        .unwrap();
    assert_eq!(run.join().unwrap(), State::Completed);
    assert_eq!(driver.requests()[1].images.len(), 3);

    // A model that cannot see images gets none of the bytes when the
    // author goes on in words (its adapter writes a line for each).
    let blind_driver = Arc::new(ScriptedDriver::new(vec![reply("好")]));
    drop(runtime);
    let runtime = Runtime::new(
        ws.clone(),
        blind_driver.clone(),
        Arc::new(NoTools),
        Options::default(),
    )
    .unwrap();
    let run = runtime
        .start(start(&book, &conversation, blind(), "换个模型接着说"))
        .unwrap();
    assert_eq!(run.join().unwrap(), State::Completed);
    assert!(blind_driver.requests()[0].images.is_empty());
    drop(runtime);
    ws.shutdown().unwrap();
}

fn conversation_entries(
    ws: &Workspace,
    id: &ConversationId,
) -> Vec<dr_model::conversation::ConversationEntry> {
    conversation(ws.library(), id).unwrap()
}

#[test]
fn a_model_that_cannot_see_is_not_asked_and_the_agent_says_so() {
    let (_dir, ws, book) = setup();
    let driver = Arc::new(ScriptedDriver::new(vec![reply("不该被调用")]));
    let runtime = Runtime::new(
        ws.clone(),
        driver.clone(),
        Arc::new(NoTools),
        Options::default(),
    )
    .unwrap();
    let conversation = ConversationId::new_v7();
    let map = dr_testkit::media::png(64, 48);
    // An image alone, without words, is a message.
    let run = runtime
        .start_with_images(start(&book, &conversation, blind(), ""), attach(&[&map]))
        .unwrap();
    let session = run.session.clone();
    assert_eq!(run.join().unwrap(), State::Completed);
    assert!(driver.requests().is_empty(), "the model was not asked");
    let transcript = conversation_entries(&ws, &conversation);
    assert_eq!(transcript.len(), 2);
    assert_eq!(transcript[0].payload["text"], "");
    assert_eq!(images::payload_images(&transcript[0].payload).len(), 1);
    let answer: AssistantMessage = serde_json::from_value(transcript[1].payload.clone()).unwrap();
    assert_eq!(
        answer.blocks,
        vec![ContentBlock::Text {
            index: 0,
            text: "这个模型看不了图片".into()
        }]
    );
    assert!(answer.complete);
    let log = events(ws.library(), &session, 0).unwrap();
    assert!(log.iter().any(|row| matches!(
        &row.event,
        Event::UserMessage { images, .. } if images.len() == 1
    )));

    // DeepSeek's route never sees images, whatever its capabilities say.
    let mut deepseek = RunConfig::new(Provider::Deepseek, "deepseek-flash");
    deepseek.capabilities = Some(ModelCapabilities {
        image_input: Some(true),
        ..Default::default()
    });
    assert!(!deepseek.sees_images());
    let run = runtime
        .start_with_images(
            start(&book, &conversation, deepseek, "看看"),
            attach(&[&map]),
        )
        .unwrap();
    assert_eq!(run.join().unwrap(), State::Completed);
    assert!(driver.requests().is_empty());
    drop(runtime);
    ws.shutdown().unwrap();
}

/// S2 (作者 2026-11-24): with an OpenAI API key every model takes images, as
/// in the 0.1 client: OpenAI's model list says nothing either way, and a
/// model that cannot is refused by the service, through the usual error
/// path. The model is asked, with the bytes; the Agent does not say it
/// cannot see.
#[test]
fn an_openai_api_model_gets_the_bytes_whatever_its_list_says() {
    let (_dir, ws, book) = setup();
    let driver = Arc::new(ScriptedDriver::new(vec![reply("一张图"), reply("两张图")]));
    let runtime = Runtime::new(
        ws.clone(),
        driver.clone(),
        Arc::new(NoTools),
        Options::default(),
    )
    .unwrap();
    let conversation = ConversationId::new_v7();
    let map = dr_testkit::media::png(64, 48);
    let silent = RunConfig::new(Provider::Openai, "synthetic-openai");
    let mut listed = silent.clone();
    listed.capabilities = Some(ModelCapabilities {
        context_window: Some(200_000),
        ..Default::default()
    });
    for config in [silent, listed] {
        assert!(config.sees_images());
        let run = runtime
            .start_with_images(start(&book, &conversation, config, "看"), attach(&[&map]))
            .unwrap();
        assert_eq!(run.join().unwrap(), State::Completed);
    }
    let requests = driver.requests();
    assert_eq!(requests.len(), 2, "the model was asked each time");
    assert_eq!(requests[1].images.len(), 2);
    let transcript = conversation_entries(&ws, &conversation);
    assert!(
        !transcript
            .iter()
            .any(|e| e.payload.to_string().contains("这个模型看不了图片"))
    );
    drop(runtime);
    ws.shutdown().unwrap();
}

#[test]
fn what_cannot_be_sent_is_refused_before_anything_is_written() {
    let (dir, ws, book) = setup();
    let driver = Arc::new(ScriptedDriver::new(Vec::new()));
    let runtime = Runtime::new(
        ws.clone(),
        driver.clone(),
        Arc::new(NoTools),
        Options::default(),
    )
    .unwrap();
    let conversation = ConversationId::new_v7();
    let map = dr_testkit::media::png(64, 48);
    let heic = dr_testkit::media::HEIC.to_vec();
    let five: Vec<_> = (0..=MAX_IMAGES_PER_MESSAGE).map(|_| &map).collect();
    let mut no_reply = attach(&[&map]);
    no_reply.unseen_reply = " ".into();
    for (config, images) in [
        (seeing(), attach(&five)),
        (seeing(), attach(&[&map, &heic])),
        (blind(), no_reply),
    ] {
        assert!(matches!(
            runtime.start_with_images(start(&book, &conversation, config, "看"), images),
            Err(Error::Protocol(_))
        ));
    }
    // Nothing at all is still no message.
    assert!(
        runtime
            .start_with_images(start(&book, &conversation, seeing(), " "), attach(&[]))
            .is_err()
    );
    assert!(ws.library().agent_sessions(None).unwrap().is_empty());
    assert!(!dir.path().join(DIR).exists());
    assert!(driver.requests().is_empty());
    drop(runtime);
    ws.shutdown().unwrap();
}

#[test]
fn a_purged_conversations_images_go_when_the_library_opens_again() {
    let (dir, ws, book) = setup();
    let driver = Arc::new(ScriptedDriver::new(vec![reply("一"), reply("二")]));
    let runtime = Runtime::new(
        ws.clone(),
        driver.clone(),
        Arc::new(NoTools),
        Options::default(),
    )
    .unwrap();
    let (gone, kept) = (ConversationId::new_v7(), ConversationId::new_v7());
    let map = dr_testkit::media::png(64, 48);
    for id in [&gone, &kept] {
        let run = runtime
            .start_with_images(start(&book, id, seeing(), "看"), attach(&[&map]))
            .unwrap();
        assert_eq!(run.join().unwrap(), State::Completed);
    }
    let folder = |id: &ConversationId| dir.path().join(DIR).join(id.as_str());
    assert!(folder(&gone).is_dir() && folder(&kept).is_dir());
    ws.library()
        .purge_doc(&DocId::Conversation(gone.clone()).to_string())
        .unwrap();
    // A folder no conversation of this library ever had stays too.
    let stray = ConversationId::new_v7();
    std::fs::create_dir_all(folder(&stray)).unwrap();
    runtime.recover().unwrap();
    assert!(!folder(&gone).exists());
    assert!(folder(&kept).is_dir());
    assert!(folder(&stray).is_dir());
    let image = images::payload_images(&conversation_entries(&ws, &kept)[0].payload)[0]
        .clone()
        .unwrap();
    assert_eq!(images::read(ws.library(), &kept, &image).unwrap(), map);
    drop(runtime);
    ws.shutdown().unwrap();
}
