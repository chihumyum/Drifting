#!/usr/bin/env python3
"""Builds the fonts dr-ui loads (docs/rust-rewrite/foundations/f5-ui.md, 「字体」).

The fonts are a build product, never committed. This script downloads the
pinned upstream files listed in ../assets/fonts/provenance.json, checks their
SHA-256, cuts the static weights, merges Latin and Chinese into one face per
weight and writes them to next/.cache/fonts/ (ignored by git). The output is
deterministic: the same inputs and fontTools version give the same bytes,
and the result is checked against the hashes in provenance.json.

GPUI on macOS cannot fall back to a font it loaded itself (CoreText's cascade
list only sees registered fonts), and it picks weights among static faces
only: a variable font always draws its default instance. So every face
carries both its Latin and its Chinese glyphs and nothing relies on fallback.

    Drifting Sans   Source Sans 3 (Latin) + Noto Sans SC     400 500 600
    Drifting Serif  Newsreader 16pt (Latin) + Noto Serif SC   400 700
    Sarasa Mono SC  unchanged                                400

The merged families are Modified Versions under the SIL OFL 1.1: a new name
(no Reserved Font Name), every upstream copyright notice kept, still OFL.

    python3 -m pip install fonttools==4.60.1
    python3 crates/dr-ui/script/build-fonts.py            # in next/
    python3 crates/dr-ui/script/build-fonts.py --update   # after changing a pin

Downloads are cached in <out>/.sources and reused when their hash matches.
Sarasa ships as a 7z archive; it is opened with `tar` (bsdtar reads 7z) or,
failing that, `7z`.
"""

import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

import fontTools
from fontTools.merge import Merger
from fontTools.ttLib import TTFont
from fontTools.ttLib.scaleUpem import scale_upem
from fontTools.varLib import instancer

HERE = pathlib.Path(__file__).resolve().parent
ASSETS = HERE.parent / "assets" / "fonts"
PROVENANCE = ASSETS / "provenance.json"
DEFAULT_OUT = HERE.parent.parent.parent / ".cache" / "fonts"
FONTTOOLS = "4.60.1"
# Every built face carries this as its created and modified time (head
# table), so a rebuild gives the same bytes. 2026-11-07 00:00 UTC, as
# seconds since 1904-01-01.
EPOCH_1904 = 2082844800
STAMP = EPOCH_1904 + 1794009600

WEIGHT_NAMES = {400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold"}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def fetch(name, source, cache):
    """The pinned source `name`, downloaded once and checked."""
    url = source["url"]
    target = cache / source["file"]
    if target.exists() and sha256(target) == source["sha256"]:
        return target
    print(f"downloading {name}: {url}", flush=True)
    tmp = target.with_suffix(target.suffix + ".part")
    # curl first (it carries the system's certificates everywhere); Python's
    # own TLS as the fallback. The hash below is what is trusted.
    try:
        subprocess.run(["curl", "-sSfL", "--retry", "3", "-o", str(tmp), url], check=True)
    except (OSError, subprocess.CalledProcessError):
        with urllib.request.urlopen(url, timeout=120) as response, open(tmp, "wb") as out:
            shutil.copyfileobj(response, out)
    got = sha256(tmp)
    if got != source["sha256"]:
        tmp.unlink()
        sys.exit(f"{name}: SHA-256 {got} does not match the pinned {source['sha256']} ({url})")
    tmp.replace(target)
    return target


def extract(archive, member, expected, cache):
    """`member` out of a 7z archive, checked."""
    target = cache / member
    if target.exists() and sha256(target) == expected:
        return target
    with tempfile.TemporaryDirectory(dir=cache) as tmp:
        attempts = [
            ["tar", "-xf", str(archive), "-C", tmp, member],
            ["7z", "e", f"-o{tmp}", str(archive), member, "-y"],
        ]
        for cmd in attempts:
            try:
                subprocess.run(cmd, check=True, capture_output=True)
                break
            except (OSError, subprocess.CalledProcessError):
                continue
        else:
            sys.exit(f"could not open {archive.name}: neither `tar` nor `7z` reads it here")
        got = sha256(pathlib.Path(tmp) / member)
        if got != expected:
            sys.exit(f"{member}: SHA-256 {got} does not match the pinned {expected}")
        shutil.move(str(pathlib.Path(tmp) / member), target)
    return target


def static(path, location, scratch):
    """The face of a variable font at `location`, as a static TrueType font."""
    font = TTFont(path)
    axes = {a.axisTag: a for a in font["fvar"].axes}
    full = {tag: location.get(tag, axis.defaultValue) for tag, axis in axes.items()}
    font = instancer.instantiateVariableFont(font, full, updateFontNames=False)
    # fontTools.merge cannot merge these; a static face does not need STAT,
    # GPUI never lays text out vertically, and BASE goes back on afterwards.
    for tag in ("STAT", "BASE", "vhea", "vmtx", "VORG"):
        if tag in font:
            del font[tag]
    # Newsreader is drawn on 2000 units per em, the Noto faces on 1000.
    if font["head"].unitsPerEm != 1000:
        scale_upem(font, 1000)
    name = "-".join(f"{k}{int(v)}" for k, v in sorted(full.items()))
    out = scratch / f"{pathlib.Path(path).stem}-{name}.ttf"
    font.save(out)
    return out


def set_names(font, family, weight, notices):
    style = WEIGHT_NAMES[weight]
    ribbi = style in ("Regular", "Bold")
    legacy_family = family if ribbi else f"{family} {style}"
    legacy_style = style if ribbi else "Regular"
    ps = f"{family.replace(' ', '')}-{style}"
    name = font["name"]
    keep = {0, 7, 8, 9, 11, 12, 13, 14}
    name.names = [n for n in name.names if n.nameID in keep]
    for platform in ((3, 1, 0x409), (1, 0, 0)):
        def put(name_id, value):
            name.setName(value, name_id, *platform)

        put(0, " | ".join(notices))
        put(1, legacy_family)
        put(2, legacy_style)
        put(3, f"{ps};dr-ui")
        put(4, f"{family} {style}")
        put(5, "Version 1.001; built by dr-ui build-fonts.py from the upstream fonts in provenance.json")
        put(6, ps)
        put(16, family)
        put(17, style)
    os2 = font["OS/2"]
    os2.usWeightClass = weight
    # fsSelection: REGULAR (bit 6), BOLD (bit 5); USE_TYPO_METRICS (bit 7) kept.
    sel = os2.fsSelection & ~0b1100001
    if weight == 700:
        sel |= 1 << 5
    elif weight == 400:
        sel |= 1 << 6
    os2.fsSelection = sel
    font["head"].macStyle = 1 if weight == 700 else 0


def notice(path):
    return TTFont(path, lazy=True)["name"].getDebugName(0)


def merged(spec, sources, out_dir, scratch):
    weight = spec["weight"]
    latin = sources[spec["latin"]]
    cjk = sources[spec["cjk"]]
    location = {"wght": weight, **spec.get("latin_location", {})}
    parts = [static(latin, location, scratch), static(cjk, {"wght": weight}, scratch)]
    font = Merger().merge([str(p) for p in parts])
    # The Chinese face's baselines (BASE) align its ideographs with the
    # Latin; same units per em, so they carry over as they are.
    cjk_face = TTFont(cjk)
    if "BASE" in cjk_face:
        base = cjk_face["BASE"]
        base.table.Version = 0x00010000
        if hasattr(base.table, "VarStore"):
            del base.table.VarStore
        font["BASE"] = base
    notices = []
    for path in (latin, cjk):
        text = notice(path)
        if text and text not in notices:
            notices.append(text)
    set_names(font, spec["family"], weight, notices)
    font.recalcTimestamp = False
    font["head"].created = STAMP
    font["head"].modified = STAMP
    target = out_dir / spec["file"]
    font.save(target)
    return target


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=pathlib.Path, default=DEFAULT_OUT)
    ap.add_argument("--update", action="store_true", help="record the built hashes in provenance.json")
    args = ap.parse_args()
    if fontTools.version != FONTTOOLS:
        sys.exit(f"fontTools {FONTTOOLS} is pinned (found {fontTools.version}): python3 -m pip install fonttools=={FONTTOOLS}")

    provenance = json.loads(PROVENANCE.read_text())
    out = args.out.resolve()
    cache = out / ".sources"
    cache.mkdir(parents=True, exist_ok=True)

    sources = {}
    for name, source in provenance["sources"].items():
        path = fetch(name, source, cache)
        if "member" in source:
            path = extract(path, source["member"], source["member_sha256"], cache)
        sources[name] = path

    mismatched = []
    with tempfile.TemporaryDirectory(dir=cache) as tmp:
        scratch = pathlib.Path(tmp)
        for spec in provenance["outputs"]:
            started = time.time()
            if "copy" in spec:
                target = out / spec["file"]
                shutil.copyfile(sources[spec["copy"]], target)
            else:
                target = merged(spec, sources, out, scratch)
            got = sha256(target)
            print(f"{spec['file']}  {time.time() - started:.1f}s  {got[:12]}", flush=True)
            if args.update:
                spec["sha256"] = got
            elif spec.get("sha256") != got:
                mismatched.append((spec["file"], spec.get("sha256"), got))
    shutil.copyfile(ASSETS / "OFL-1.1.txt", out / "OFL-1.1.txt")

    if args.update:
        PROVENANCE.write_text(json.dumps(provenance, indent=2, ensure_ascii=False) + "\n")
        print(f"recorded the hashes in {PROVENANCE}")
    elif mismatched:
        for file, want, got in mismatched:
            print(f"{file}: built {got}, provenance.json pins {want}", file=sys.stderr)
        sys.exit("the build is not the pinned one; check the sources and fontTools, or rerun with --update")
    # What the loader and CI read to know the cache is this build.
    (out / "stamp.json").write_text(
        json.dumps({"provenance_sha256": sha256(PROVENANCE)}, indent=2) + "\n"
    )
    print(f"fonts in {out}")


if __name__ == "__main__":
    main()
