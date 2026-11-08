#!/usr/bin/env python3
"""Check G3 against the pinned GPUI source, without modifying that checkout."""
import pathlib
import subprocess
import sys
import tempfile

BASE = "c84af5b"
FILES = (
    "crates/gpui/src/platform.rs",
    "crates/gpui/src/window.rs",
    "crates/gpui_macos/src/window.rs",
    "crates/gpui_windows/src/window.rs",
)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: check-g3.py <Zed v1.27.0 checkout>")
    checkout = pathlib.Path(sys.argv[1]).resolve()
    patch = pathlib.Path(__file__).with_name("0005-window-discard-marked-text.patch").resolve()
    with tempfile.TemporaryDirectory(prefix="gpui-g3-check-") as temporary:
        root = pathlib.Path(temporary)
        for name in FILES:
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(subprocess.check_output(
                ["git", "-C", str(checkout), "show", f"{BASE}:{name}"]
            ))
        for args in (["--check"], []):
            subprocess.run(["git", "apply", *args, str(patch)], cwd=root, check=True)
        subprocess.run(
            ["rustfmt", "--edition", "2024", "--config", "skip_children=true", "--check", *map(lambda p: str(root / p), FILES)],
            check=True,
        )
    print("G3: pinned source, clean application and Rust format passed")


if __name__ == "__main__":
    main()
