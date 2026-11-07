//! Test helpers: a fresh library in a temporary directory, JSON calls.
#![allow(dead_code)]

use std::sync::Arc;

use dr_store::Library;
use dr_workspace::{Actor, Faults, Workspace, WorkspaceOptions, library_options};
use serde_json::{Value, json};

pub struct Env {
    pub dir: tempfile::TempDir,
    ws: Option<Workspace>,
    pub faults: Arc<Faults>,
}

impl Drop for Env {
    fn drop(&mut self) {
        if let Some(ws) = &self.ws {
            ws.close();
        }
    }
}

pub fn open_at(dir: &std::path::Path, faults: Arc<Faults>) -> Workspace {
    let lib = Library::open(dir, library_options("test")).expect("library");
    Workspace::open(
        lib,
        WorkspaceOptions {
            faults: Some(faults),
            ..WorkspaceOptions::default()
        },
    )
    .expect("workspace")
}

pub fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let faults = Arc::new(Faults::default());
    let ws = open_at(dir.path(), faults.clone());
    Env {
        dir,
        ws: Some(ws),
        faults,
    }
}

impl Env {
    /// Close everything and open the library again from disk.
    pub fn reopen(&mut self) {
        let ws = self.ws.take().expect("open");
        ws.shutdown().expect("shut down");
        self.ws = Some(open_at(self.dir.path(), self.faults.clone()));
    }

    pub fn ws(&self) -> &Workspace {
        self.ws.as_ref().expect("open")
    }

    pub fn call(&self, name: &str, input: Value) -> Value {
        call(self.ws(), &Actor::User, name, input)
    }

    pub fn try_call(&self, name: &str, input: Value) -> dr_workspace::Result<Value> {
        self.ws().call(&Actor::User, name, input)
    }

    pub fn out(&self, name: &str, input: Value) -> Value {
        self.call(name, input)["output"].clone()
    }

    pub fn book(&self) -> String {
        self.out("book.create", json!({"name": "Test Book"}))["id"]
            .as_str()
            .unwrap()
            .to_string()
    }
}

pub fn call(ws: &Workspace, actor: &Actor, name: &str, input: Value) -> Value {
    match ws.call(actor, name, input.clone()) {
        Ok(v) => v,
        Err(e) => panic!("{name} {input}: {e} ({})", e.code()),
    }
}

pub fn ids(list: &Value) -> Vec<String> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|x| x["id"].as_str().unwrap().to_string())
        .collect()
}

pub fn field(list: &Value, key: &str) -> Vec<Value> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|x| x[key].clone())
        .collect()
}

/// Effects of an outcome as `action kind` strings.
pub fn effects(outcome: &Value) -> Vec<String> {
    outcome["effects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            format!(
                "{} {}",
                e["action"].as_str().unwrap(),
                e["kind"].as_str().unwrap()
            )
        })
        .collect()
}
