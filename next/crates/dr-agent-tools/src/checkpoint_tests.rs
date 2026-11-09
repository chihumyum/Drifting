//! Deterministic interleaving inside the real facade write path.
use super::*;
use dr_doc::v3::novel::{MOD_PROSE, TPL_CHAPTER};
use dr_testkit::seed::{self, Preset};

#[test]
fn author_edit_after_checkpoint_never_rebases_old_coverage_and_retry_recaptures() {
    for body_race in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(dir.path(), "k6-checkpoint-race").unwrap();
        ws.set_auto_links(false);
        let seed = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seed.books[0].book_id().clone();
        let entry = seed.books[0]
            .book
            .view()
            .entries()
            .into_iter()
            .find(|e| {
                e.template
                    .as_ref()
                    .is_some_and(|t| t.as_str() == TPL_CHAPTER)
            })
            .unwrap()
            .id
            .to_string();
        seed.write_to(ws.library()).unwrap();
        let tools = AgentTools::new();
        let actor = Actor::agent("checkpoint-race", 1, "write");
        let key = turn_key(&book, &actor);
        let lease = tools.lease(&key.session);
        let read = resolve::resolve(
            &ws,
            &book,
            "module.read_prose",
            json!({"owner":entry,"module":MOD_PROSE}),
        )
        .unwrap();
        let prose = tools.read(&ws, &actor, &key, &read, &lease).unwrap()["output"].clone();
        let metadata = resolve::resolve(&ws, &book, "entry.get", json!({"id":entry})).unwrap();
        tools.read(&ws, &actor, &key, &metadata, &lease).unwrap();
        let p = &prose["paragraphs"][0];
        let doc = format!("body:{entry}/{MOD_PROSE}");
        let (name, args) = if body_race {
            (
                "prose.replace",
                json!({"doc":doc,"block_id":p["block_id"],"find":p["text"],"replace":"Agent must not overwrite"}),
            )
        } else {
            (
                "entry.update",
                json!({"id":entry,"title":"Agent must not overwrite"}),
            )
        };
        let resolved = resolve::resolve(&ws, &book, name, args).unwrap();
        let observed = std::cell::RefCell::new(Value::Null);
        let journal = std::cell::Cell::new(0);
        let result=tools.write_with_checkpoint(&ws,&actor,&key,resolved,|| {
            if body_race {
                ws.call(&Actor::User,"prose.replace",json!({"doc":doc,"block_id":p["block_id"],"find":p["text"],"replace":"Author between checkpoint and write"})).unwrap();
            } else {
                ws.call(&Actor::User,"entry.update",json!({"book":book,"id":entry,"title":"Author between checkpoint and write"})).unwrap();
            }
            *observed.borrow_mut()=json!([ws.observe(&format!("book:{book}")).unwrap(),ws.observe(&doc).unwrap()]);
            journal.set(ws.journal(None,1000).unwrap().len());
        });
        assert!(matches!(result, Err(Error::Conflict(_))), "{result:?}");
        assert_eq!(
            json!([
                ws.observe(&format!("book:{book}")).unwrap(),
                ws.observe(&doc).unwrap()
            ]),
            *observed.borrow()
        );
        assert_eq!(ws.journal(None, 1000).unwrap().len(), journal.get());
        assert!(
            ws.library()
                .settlements(Some("checkpoint-race"), None)
                .unwrap()
                .is_empty()
        );
        assert!(
            tools
                .turns
                .lock()
                .unwrap()
                .get(&key)
                .unwrap()
                .checkpointed
                .is_empty()
        );
        assert!(
            !tools
                .turns
                .lock()
                .unwrap()
                .get(&key)
                .unwrap()
                .reads
                .contains_key(&format!("book:{book}"))
        );
        tools.read(&ws, &actor, &key, &metadata, &lease).unwrap();
        let retry = resolve::resolve(
            &ws,
            &book,
            "entry.update",
            json!({"id":entry,"title":"After explicit reread"}),
        )
        .unwrap();
        tools.write(&ws, &actor, &key, retry).unwrap();
        let points = ws
            .call(
                &Actor::User,
                "entry_snapshot.list",
                json!({"book":book,"entry":entry}),
            )
            .unwrap();
        assert_eq!(
            points["output"].as_array().unwrap().len(),
            2,
            "failed attempts must not consume the first-success checkpoint slot"
        );
        ws.close();
    }
}
