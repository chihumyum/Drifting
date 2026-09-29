//! Synthetic benchmark host. Instrumentation and cache candidates exist only
//! in the runner's scratch copy of drifting-core, never in the application.
use drifting_core::database::{DatabaseGateway, TransactionBehavior};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::sync::{mpsc, Arc, Mutex};

const CLIENT: &str = "database-cache-benchmark";

fn handle(gateway: &DatabaseGateway, message: &Value) -> Result<Value, String> {
    let args = &message["args"];
    let string = |key: &str| args[key].as_str().ok_or_else(|| format!("Missing {key}"));
    let tx = || -> Result<Option<u64>, String> {
        args["transactionId"]
            .as_str()
            .map(|s| s.parse().map_err(|_| "Invalid transaction".into()))
            .transpose()
    };
    match message["command"].as_str().ok_or("Missing command")? {
        "database_open" => Ok(json!(gateway.open(
            string("databaseName")?.into(),
            CLIENT.into(),
            false
        )?)),
        "database_close" => {
            gateway.close(CLIENT.into())?;
            Ok(Value::Null)
        }
        "database_query" => Ok(json!(gateway.query(
            string("sql")?.into(),
            serde_json::from_value(args["parameters"].clone()).map_err(|e| e.to_string())?,
            tx()?,
            CLIENT.into()
        )?)),
        "database_execute" => Ok(json!(gateway.execute(
            string("sql")?.into(),
            serde_json::from_value(args["parameters"].clone()).map_err(|e| e.to_string())?,
            tx()?,
            CLIENT.into()
        )?)),
        "database_begin" => {
            let behavior = match string("behavior")? {
                "deferred" => TransactionBehavior::Deferred,
                "immediate" => TransactionBehavior::Immediate,
                "exclusive" => TransactionBehavior::Exclusive,
                _ => return Err("Invalid transaction behavior".into()),
            };
            Ok(json!({"id": gateway.begin(behavior, CLIENT.into())?.to_string()}))
        }
        "database_commit" => {
            gateway.commit(tx()?.ok_or("Missing transaction")?, CLIENT.into())?;
            Ok(Value::Null)
        }
        "database_rollback" => {
            gateway.rollback(tx()?.ok_or("Missing transaction")?, CLIENT.into())?;
            Ok(Value::Null)
        }
        "benchmark_stats" => Ok(json!(drifting_core::database::benchmark_stats(
            args["reset"].as_bool().unwrap_or(false)
        ))),
        _ => Err("Unknown benchmark command".into()),
    }
}

fn main() -> Result<(), String> {
    let directory = std::env::args()
        .nth(1)
        .ok_or("Missing synthetic directory")?;
    if !std::path::Path::new(&directory)
        .join(".synthetic-database-cache-benchmark")
        .is_file()
    {
        return Err("Refusing a directory without the synthetic marker".into());
    }
    let gateway = DatabaseGateway::new(directory.into())?;
    let (sender, receiver) = mpsc::channel::<Value>();
    let receiver = Arc::new(Mutex::new(receiver));
    // Match the existing metrics harness: an awaiting transaction must not
    // prevent another renderer request from submitting its COMMIT.
    let workers: Vec<_> = (0..16)
        .map(|_| {
            let receiver = receiver.clone();
            let gateway = gateway.clone();
            std::thread::spawn(move || loop {
                let message = match receiver.lock().unwrap().recv() {
                    Ok(value) => value,
                    Err(_) => break,
                };
                let reply = match handle(&gateway, &message) {
                    Ok(value) => json!({"id": message["id"], "value": value}),
                    Err(error) => json!({"id": message["id"], "error": error}),
                };
                let mut output = io::stdout().lock();
                writeln!(output, "{reply}").unwrap();
                output.flush().unwrap();
            })
        })
        .collect();
    for line in io::stdin().lock().lines() {
        let message =
            serde_json::from_str(&line.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        sender.send(message).map_err(|e| e.to_string())?;
    }
    drop(sender);
    for worker in workers {
        worker.join().map_err(|_| "Benchmark worker panicked")?;
    }
    Ok(())
}
