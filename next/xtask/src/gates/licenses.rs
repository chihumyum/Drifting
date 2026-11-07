//! Licenses (rule 3), from `cargo metadata` alone:
//!
//! - every workspace member is AGPL-3.0-or-later, except the permissive
//!   crates listed here (`gpui-prose`, MIT OR Apache-2.0);
//! - a permissive crate depends on no `dr-*` crate, in any kind of
//!   dependency;
//! - every third-party crate's licence expression is satisfiable with the
//!   allow list.

use super::Outcome;
use super::metadata::Metadata;
use crate::repo::Repo;

pub const WORKSPACE_LICENSE: &str = "AGPL-3.0-or-later";

/// Members under a permissive licence, and that licence.
pub const PERMISSIVE: &[(&str, &str)] = &[
    ("gpui-ime", "MIT OR Apache-2.0"),
    ("gpui-prose", "MIT OR Apache-2.0"),
    ("prose-linebreak", "MIT OR Apache-2.0"),
    ("prose-metrics", "Apache-2.0"),
];

/// Licences a dependency may be used under: permissive ones and the weak
/// copyleft MPL-2.0, all compatible with distributing the client under the
/// AGPL. Anything else needs a decision first (and an entry here).
pub const ALLOWED: &[&str] = &[
    "0BSD",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "BSL-1.0",
    "CC0-1.0",
    "CDLA-Permissive-2.0",
    "ISC",
    "MIT",
    "MIT-0",
    "MPL-2.0",
    "NCSA",
    "Unicode-3.0",
    "Unicode-DFS-2016",
    "Unlicense",
    "Zlib",
];

/// Whether an SPDX expression can be satisfied with licences `ok` accepts.
/// `A / B` (old Cargo style) is `A OR B`, `X+` is `X` or later, `X WITH E`
/// is `X` with an exception.
pub fn satisfiable(expr: &str, ok: &dyn Fn(&str) -> bool) -> Result<bool, String> {
    let spaced = expr
        .replace('(', " ( ")
        .replace(')', " ) ")
        .replace('/', " OR ");
    let tokens: Vec<&str> = spaced.split_whitespace().collect();
    let mut pos = 0;
    let v = or_expr(&tokens, &mut pos, ok)?;
    if pos != tokens.len() {
        return Err(format!("unexpected {:?} in {expr:?}", tokens[pos]));
    }
    Ok(v)
}

fn or_expr(t: &[&str], pos: &mut usize, ok: &dyn Fn(&str) -> bool) -> Result<bool, String> {
    let mut v = and_expr(t, pos, ok)?;
    while t.get(*pos).is_some_and(|s| s.eq_ignore_ascii_case("OR")) {
        *pos += 1;
        v |= and_expr(t, pos, ok)?;
    }
    Ok(v)
}

fn and_expr(t: &[&str], pos: &mut usize, ok: &dyn Fn(&str) -> bool) -> Result<bool, String> {
    let mut v = atom(t, pos, ok)?;
    while t.get(*pos).is_some_and(|s| s.eq_ignore_ascii_case("AND")) {
        *pos += 1;
        v &= atom(t, pos, ok)?;
    }
    Ok(v)
}

fn atom(t: &[&str], pos: &mut usize, ok: &dyn Fn(&str) -> bool) -> Result<bool, String> {
    match t.get(*pos) {
        Some(&"(") => {
            *pos += 1;
            let v = or_expr(t, pos, ok)?;
            if t.get(*pos) != Some(&")") {
                return Err("unbalanced parentheses".into());
            }
            *pos += 1;
            Ok(v)
        }
        Some(id) if !["AND", "OR", "WITH", ")"].contains(id) => {
            *pos += 1;
            if t.get(*pos).is_some_and(|s| s.eq_ignore_ascii_case("WITH")) {
                *pos += 2;
            }
            Ok(ok(id.trim_end_matches('+')))
        }
        other => Err(format!("expected a licence, found {other:?}")),
    }
}

pub fn run(repo: &Repo) -> Result<Outcome, String> {
    let meta = Metadata::load(repo)?;
    let mut o = Outcome::default();
    check(&meta, &mut o);
    let third: usize = meta.resolved().filter(|p| !p.member).count();
    o.summary = format!(
        "{} members, {third} third-party crates",
        meta.members().count()
    );
    Ok(o)
}

pub fn check(meta: &Metadata, o: &mut Outcome) {
    let allowed = |l: &str| ALLOWED.contains(&l);
    for m in meta.members() {
        let want = PERMISSIVE
            .iter()
            .find(|(n, _)| *n == m.name)
            .map_or(WORKSPACE_LICENSE, |(_, l)| l);
        if m.license.as_deref() != Some(want) {
            o.fail(format!(
                "{}: licence {:?}, expected {want:?} (license.workspace = true)",
                m.name, m.license
            ));
        }
        if want != WORKSPACE_LICENSE {
            for e in meta.edges.get(&m.id).into_iter().flatten() {
                let dep = meta.name(&e.to);
                if dep.starts_with("dr-") {
                    o.fail(format!(
                        "{}: a {want} crate depends on {dep}; permissive crates use no dr-* crate",
                        m.name
                    ));
                }
            }
        }
    }
    for p in meta.resolved().filter(|p| !p.member) {
        match p.license.as_deref() {
            None => o.fail(format!(
                "{} {}: no licence field; review it and record the decision in xtask/src/gates/licenses.rs",
                p.name, p.version
            )),
            Some(l) => match satisfiable(l, &allowed) {
                Ok(true) => {}
                Ok(false) => o.fail(format!(
                    "{} {}: licence {l:?} is not on the allow list",
                    p.name, p.version
                )),
                Err(e) => o.fail(format!("{} {}: {e}", p.name, p.version)),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spdx_expressions() {
        let ok = |l: &str| ALLOWED.contains(&l);
        for (e, want) in [
            ("MIT OR Apache-2.0", true),
            ("MIT/Apache-2.0", true),
            ("Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT", true),
            ("(MIT OR Apache-2.0) AND Unicode-3.0", true),
            ("MPL-2.0+", true),
            ("Apache-2.0 OR GPL-2.0-only", true),
            ("GPL-3.0-or-later", false),
            ("MIT AND GPL-2.0-only", false),
            ("LGPL-2.1-or-later", false),
        ] {
            assert_eq!(satisfiable(e, &ok).unwrap(), want, "{e}");
        }
        assert!(satisfiable("(MIT", &ok).is_err());
    }
}
