#!/usr/bin/env python3
"""Copies the strings the new client uses out of the 0.1 client's locales.

    python3 crates/dr-i18n/script/sync-locales.py          # rewrite locales/
    python3 crates/dr-i18n/script/sync-locales.py --check  # fail if stale

Reads `crates/dr-i18n/keys.txt` (one dotted key per line; `prefix.*` takes a
whole subtree, `#` starts a comment) and, for each of the nine languages,
writes the matching subset of `src/renderer/locales/<lang>.json` to
`crates/dr-i18n/locales/<lang>.json` and of the Windows overlay
`src/renderer/locales/windows/<lang>.json` to `locales/windows/<lang>.json`.
A key with plural forms (`key_one`, `key_other`, ...) is listed without the
suffix; every form present is copied.

The new client's own strings (sentences the 0.1 client never had) are
written by hand in `crates/dr-i18n/own/<lang>.json`, same shape as the 0.1
files, every key in all nine languages (plural forms where the language has
them). They are merged into `locales/` as they are: no keys.txt entry
needed. A key that is also in the 0.1 en.json is refused (the 0.1 string is
the source while it exists).

The 0.1 locales stay the source until stage 7 (docs/rust-rewrite/
simplifications.md, section 7): when the old client is deleted, the copies
here become the source and this script goes.
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CRATE = HERE.parent
OWN = CRATE / "own"
REPO = CRATE.parent.parent.parent
SOURCE = REPO / "src" / "renderer" / "locales"
LOCALES = ["zh-CN", "zh-TW", "en", "ja", "ko", "es", "de", "fr", "pt-BR"]
PLURAL_SUFFIXES = ["_zero", "_one", "_two", "_few", "_many", "_other"]


def read_manifest():
    keys = []
    for raw in (CRATE / "keys.txt").read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if line:
            keys.append(line)
    return keys


def flatten(tree, prefix=""):
    out = {}
    for key, value in tree.items():
        path = f"{prefix}.{key}" if prefix else key
        if isinstance(value, dict):
            out.update(flatten(value, path))
        else:
            out[path] = value
    return out


def select(flat, manifest, reference):
    """The entries of `flat` the manifest names, judged by `reference` (en)."""
    chosen = {}
    for entry in manifest:
        if entry.endswith(".*"):
            prefix = entry[:-1]
            for key in reference:
                if key.startswith(prefix) and key in flat:
                    chosen[key] = flat[key]
                # A language without plurals keeps the plain key where
                # English has `_one`/`_other` (it is that language's
                # `_other`, as i18next reads it).
                for suffix in PLURAL_SUFFIXES:
                    stem = key[: -len(suffix)]
                    if key.startswith(prefix) and key.endswith(suffix) and stem in flat:
                        chosen[stem] = flat[stem]
            continue
        hit = False
        if entry in flat:
            chosen[entry] = flat[entry]
            hit = True
        for suffix in PLURAL_SUFFIXES:
            if entry + suffix in flat:
                chosen[entry + suffix] = flat[entry + suffix]
                hit = True
        if not hit and reference is flat:
            raise SystemExit(f"keys.txt: {entry} is not in en.json")
    return chosen


def unflatten(flat):
    tree = {}
    for path, value in flat.items():
        node = tree
        parts = path.split(".")
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = value
    return tree


def render(flat):
    return json.dumps(unflatten(dict(sorted(flat.items()))), ensure_ascii=False, indent=2) + "\n"


def base(key):
    for suffix in PLURAL_SUFFIXES:
        if key.endswith(suffix):
            return key[: -len(suffix)]
    return key


def read_own(en_source):
    """The new client's own strings per language; checked for gaps and clashes."""
    own = {}
    for locale in LOCALES:
        path = OWN / f"{locale}.json"
        own[locale] = flatten(json.loads(path.read_text(encoding="utf-8"))) if path.exists() else {}
    keys = {base(k) for flat in own.values() for k in flat}
    for key in sorted(keys):
        clash = [k for k in en_source if base(k) == key]
        if clash:
            raise SystemExit(f"own/: {key} is also a 0.1 string ({clash[0]}); use the 0.1 one")
        for locale in LOCALES:
            if not any(base(k) == key for k in own[locale]):
                raise SystemExit(f"own/{locale}.json: {key} is missing")
    return own


def main():
    check = "--check" in sys.argv[1:]
    if not SOURCE.is_dir():
        print("sync-locales: the 0.1 locales are gone; the copies here are the source now.")
        return
    manifest = read_manifest()
    en = flatten(json.loads((SOURCE / "en.json").read_text(encoding="utf-8")))
    select(en, manifest, en)  # reports unknown keys
    own = read_own(en)
    stale = []
    for locale in LOCALES:
        for folder, out_dir in [(SOURCE, CRATE / "locales"), (SOURCE / "windows", CRATE / "locales" / "windows")]:
            source = folder / f"{locale}.json"
            flat = flatten(json.loads(source.read_text(encoding="utf-8"))) if source.exists() else {}
            chosen = select(flat, manifest, en)
            if folder == SOURCE:
                chosen.update(own[locale])
            text = render(chosen)
            target = out_dir / f"{locale}.json"
            if check:
                if not target.exists() or target.read_text(encoding="utf-8") != text:
                    stale.append(str(target.relative_to(CRATE)))
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text, encoding="utf-8")
    if stale:
        raise SystemExit("sync-locales: stale copies, rerun the script: " + ", ".join(stale))
    if not check:
        own_keys = len({base(k) for k in own["en"]})
        print(f"sync-locales: {len(manifest)} manifest entries, {own_keys} own, {len(LOCALES)} languages")


if __name__ == "__main__":
    main()
