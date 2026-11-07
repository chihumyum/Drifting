//! The published 0.1 schema: the 19 Drizzle migrations frozen at 0.1.0-alpha.1
//! and after, and the part of the 0.1 client's `database.rs` bound to them
//! (`__drizzle_migrations`, `meta/_journal.json`). The importer reads only
//! libraries at the last 0.1 schema; an older 0.1.x library is brought up to
//! it on the staging copy with exactly the 0.1 client's rules, never in place.

use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};

use crate::error::{ImportError, Result};

include!(concat!(env!("OUT_DIR"), "/legacy_migrations.rs"));

/// Drizzle's statement separator.
const BREAKPOINT: &str = "--> statement-breakpoint";
/// Drizzle's migration ledger.
pub const MIGRATIONS_TABLE: &str = "__drizzle_migrations";

/// SHA-256 of every published migration file, in journal order. Published
/// migrations are immutable (AGENTS.md); a changed file is refused.
const PINNED: [&str; 19] = [
    "2ee852a7490b3dfb8fb9095a29d90d8c54c0b2bbfc0d00e0c7567be15f38c1e2",
    "b188d6c3c38c0af7662d7516593c767bba26df67a100d9ecf7be93048246b9b0",
    "35ea9b635f4f5d671335684c109275444d406fb2715301dcb667703ab2304b90",
    "b61e084d2af4244ded43dd2ad05242a4a0e846d7150a2bd8c46caeeb38e76341",
    "865ebe4a9c9855cafad7780f33ba185bdfaa3d86db4ed32ec0562933bbfb0a05",
    "25b99bdfaf7e002c8601cf6106999d549a2b74727ad4b94aa71fbff4ca00e5b0",
    "198749706178b6e9463c52d13c462243d1be176df2cf69f02cc2e1a1855b378c",
    "dbf9fdd00d8e77a1eeb2f2040ea2bf9e475ee5e2cd77da30b37d09aea48dfc80",
    "ec491eb0c8358a2611087aa148f54132331f9925bc926581f8868cce4f486cdd",
    "34b58b003ebda07506a64dcf9bf87a65947338fe4104b3eca705cafd37b62db0",
    "2df862717de44cf574953fa2e0fa21e3d4c67ac03c78d64ee333530e0aa73c30",
    "1e939f1d59b5b38a7e1b691ebf385e6dd22ae9c327f9a353099419d11c1fcd4f",
    "1907f847b19214811219b01e660ea457fa222710aa2b2c4ce3fc074eb3d7c6f0",
    "800f277b2bbc4168c4f598eb014735a1cad6a6ad0fcea05f1cf754967c7e902f",
    "c351465ec21d1804cf2823eb93c8eda954fd18600620a644330dbdc59a8ce34b",
    "b0612c046831086bba37d0f13aa4703c34f3a75bcde6711b9969935f0fabc796",
    "c087b2a2065a52e8ae24a740401141a331ebc4732881e3fe1b25657e9e3800be",
    "2853d2dcc7a6d34408a8dcf0c0287a38fea6730f2b6e617587a2ff3a484345e6",
    "b8d218d1a6d003692e1efcf85ff5cb8f3af42d524ddd874bbb4e8f5db1929efe",
];

/// The number of published 0.1 migrations: a library at this level has the
/// last 0.1 schema, the only one the mapping reads.
pub const LATEST: usize = PINNED.len();

/// One published migration.
#[derive(Clone, Copy, Debug)]
pub struct Migration {
    pub tag: &'static str,
    /// The journal's `when`, recorded in `__drizzle_migrations.created_at`.
    pub when: i64,
    pub sql: &'static str,
}

impl Migration {
    pub fn sha256(&self) -> String {
        hex(&Sha256::digest(self.sql.as_bytes()))
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The published migrations, after checking each against its pinned hash.
pub fn migrations() -> Result<Vec<Migration>> {
    if EMBEDDED.len() != PINNED.len() {
        return Err(ImportError::SchemaMismatch(format!(
            "{} migrations embedded, {} pinned",
            EMBEDDED.len(),
            PINNED.len()
        )));
    }
    let mut out = Vec::with_capacity(EMBEDDED.len());
    let mut last = i64::MIN;
    for ((tag, when, sql), pinned) in EMBEDDED.iter().zip(PINNED) {
        let m = Migration {
            tag,
            when: *when,
            sql,
        };
        if m.sha256() != pinned {
            return Err(ImportError::SchemaMismatch(format!(
                "published migration {tag} was edited"
            )));
        }
        if *when <= last {
            return Err(ImportError::SchemaMismatch(format!(
                "journal timestamps are not increasing at {tag}"
            )));
        }
        last = *when;
        out.push(m);
    }
    Ok(out)
}

/// Where a library's schema stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Level {
    /// Published migrations already applied.
    pub applied: usize,
    pub latest: usize,
}

impl Level {
    pub fn is_latest(&self) -> bool {
        self.applied == self.latest
    }
}

struct Applied {
    hash: String,
    when: i64,
}

fn applied(conn: &Connection) -> Result<Vec<Applied>> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1)",
        [MIGRATIONS_TABLE],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(ImportError::NotALibrary(format!(
            "no {MIGRATIONS_TABLE} table"
        )));
    }
    let mut stmt = conn.prepare(&format!(
        "SELECT hash, created_at FROM {MIGRATIONS_TABLE} ORDER BY created_at ASC"
    ))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Applied {
                hash: r.get(0)?,
                when: r.get(1)?,
            })
        })
        .map_err(|e| ImportError::SchemaMismatch(format!("migration history unreadable: {e}")))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| ImportError::SchemaMismatch(format!("migration history unreadable: {e}")))?;
    Ok(rows)
}

/// Check the recorded migrations against the published ones (the 0.1
/// client's prefix rule) and report the level. Reads only.
pub fn level(conn: &Connection) -> Result<Level> {
    let published = migrations()?;
    let rows = applied(conn)?;
    for pair in rows.windows(2) {
        if pair[0].when >= pair[1].when {
            return Err(ImportError::SchemaMismatch(
                "migration timestamps are duplicated or out of order".into(),
            ));
        }
    }
    if rows.len() > published.len() {
        let newest = rows.last().map(|r| r.when).unwrap_or_default();
        let latest = published.last().map(|m| m.when).unwrap_or_default();
        if newest > latest {
            return Err(ImportError::Newer {
                found: rows.len(),
                known: published.len(),
            });
        }
        return Err(ImportError::SchemaMismatch(
            "migration history contains a non-prefix entry".into(),
        ));
    }
    for (row, m) in rows.iter().zip(&published) {
        if row.when != m.when || row.hash != m.sha256() {
            return Err(ImportError::SchemaMismatch(format!(
                "migration {} is not the published one",
                m.tag
            )));
        }
    }
    if rows.is_empty() {
        return Err(ImportError::SchemaMismatch(
            "no migration recorded (not a 0.1.0-alpha.1 or later library)".into(),
        ));
    }
    Ok(Level {
        applied: rows.len(),
        latest: published.len(),
    })
}

/// Apply the missing published migrations in one transaction, foreign keys
/// suspended, as the 0.1 client's `apply_migrations` does. Only ever called
/// on the importer's own staging copy. Returns the level before.
pub fn catch_up(conn: &Connection) -> Result<Level> {
    let before = level(conn)?;
    if before.is_latest() {
        return Ok(before);
    }
    let published = migrations()?;
    conn.pragma_update(None, "foreign_keys", false)?;
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> Result<()> {
        for m in published.iter().skip(before.applied) {
            for statement in m.sql.split(BREAKPOINT) {
                if statement.trim().is_empty() {
                    continue;
                }
                conn.execute_batch(statement).map_err(|e| {
                    ImportError::SchemaMismatch(format!("migration {} failed: {e}", m.tag))
                })?;
            }
            conn.execute(
                &format!("INSERT INTO {MIGRATIONS_TABLE} (hash, created_at) VALUES (?1, ?2)"),
                params![m.sha256(), m.when],
            )?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(e) => {
            if !conn.is_autocommit() {
                let _ = conn.execute_batch("ROLLBACK");
            }
            let _ = conn.pragma_update(None, "foreign_keys", true);
            return Err(e);
        }
    }
    conn.pragma_update(None, "foreign_keys", true)?;
    Ok(before)
}

/// A new database at `upto` published migrations: what an older 0.1 build
/// created. For tests and fixtures.
pub fn create_at(conn: &Connection, upto: usize) -> Result<()> {
    let published = migrations()?;
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {MIGRATIONS_TABLE} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)"
    ))?;
    conn.pragma_update(None, "foreign_keys", false)?;
    for m in published.iter().take(upto) {
        for statement in m.sql.split(BREAKPOINT) {
            if !statement.trim().is_empty() {
                conn.execute_batch(statement)?;
            }
        }
        conn.execute(
            &format!("INSERT INTO {MIGRATIONS_TABLE} (hash, created_at) VALUES (?1, ?2)"),
            params![m.sha256(), m.when],
        )?;
    }
    conn.pragma_update(None, "foreign_keys", true)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_embedded_migrations_are_the_published_ones() {
        let all = migrations().unwrap();
        assert_eq!(all.len(), 19);
        assert!(all[0].tag.starts_with("0000_"));
        assert!(all[18].tag.starts_with("0018_"));
    }

    #[test]
    fn an_older_library_catches_up_on_its_copy() {
        let conn = Connection::open_in_memory().unwrap();
        create_at(&conn, 12).unwrap();
        assert_eq!(
            level(&conn).unwrap(),
            Level {
                applied: 12,
                latest: 19
            }
        );
        let before = catch_up(&conn).unwrap();
        assert_eq!(before.applied, 12);
        assert!(level(&conn).unwrap().is_latest());
        // Idempotent.
        assert_eq!(catch_up(&conn).unwrap().applied, 19);
        // The tables of the last 0.1 schema are there.
        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name IN ('material_folder', 'library_state', 'writing_day')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 3);
    }

    #[test]
    fn foreign_histories_are_refused() {
        let conn = Connection::open_in_memory().unwrap();
        create_at(&conn, 3).unwrap();
        conn.execute(
            &format!("UPDATE {MIGRATIONS_TABLE} SET hash = 'x' WHERE created_at = (SELECT max(created_at) FROM {MIGRATIONS_TABLE})"),
            [],
        )
        .unwrap();
        assert!(matches!(level(&conn), Err(ImportError::SchemaMismatch(_))));

        let newer = Connection::open_in_memory().unwrap();
        create_at(&newer, 19).unwrap();
        newer
            .execute(
                &format!(
                    "INSERT INTO {MIGRATIONS_TABLE} (hash, created_at) VALUES ('y', 99999999999999)"
                ),
                [],
            )
            .unwrap();
        assert!(matches!(
            level(&newer),
            Err(ImportError::Newer { found: 20, .. })
        ));

        let empty = Connection::open_in_memory().unwrap();
        assert!(matches!(level(&empty), Err(ImportError::NotALibrary(_))));
    }
}
