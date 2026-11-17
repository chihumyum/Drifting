"""M40's secondary-display smoke with a synthetic library and a real editor.

From next/, build drifting with --features debug-bridge and build dr-cli.
Run python3 -I crates/dr-cli/script/markdown-folder.py --out <empty-dir>.
The macOS development profile is generated for this one run and cleaned up.
"""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid


def until(probe, label, timeout=30):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        result = probe()
        if result:
            return result
        time.sleep(0.15)
    raise AssertionError(f"Timed out waiting for {label}")


def smoke(args, profile, data):
    def cli(*argv):
        return subprocess.check_output([args.cli, *argv], text=True, timeout=90)

    def app(method, **params):
        result = cli("app", "raw", method, "--profile", profile,
                     "--params", json.dumps(params), "--timeout", "65000")
        return json.loads(result)

    def wait(**params):
        app("ui.wait", until="ready", timeout_ms=60000, **params)

    def command(name, **input):
        return app("command.call", name=name, input=input)["output"]

    def press(label):
        app("ui.press", role="Button", label=label)

    def settings(query):
        app("action.dispatch", name="app::OpenSettings")
        wait(state={"/layer": "settings"})
        app("ui.focus", field="settings.search", select_all=True)
        app("input.type", text=query)

    def show_book():
        app("book.open", name="慢钟")
        wait(state={"/book/name": "慢钟", "/shelf": False})

    def chapter(text=None):
        app("nav.open", target=target)
        expected = {} if text is None else {"page": {"/paragraphs/0/text": text}}
        wait(state={"/focus/editor": True, "/page": target}, **expected)

    def screenshot(name):
        cli("app", "screenshot", args.out / name, "--profile", profile)

    def read(path):
        try:
            return path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return ""

    def disk_has(text):
        until(lambda: text in read(document), f"Markdown containing {text!r}")

    def outside(before, after):
        text = read(document)
        header, body = text.split("\n---\n", 1)
        assert before in body
        swap = document.with_suffix(".new")
        swap.write_text(header + "\n---\n" + body.replace(before, after, 1), encoding="utf-8")
        swap.replace(document)

    def launch(number):
        with (args.out / f"app-{number}.log").open("w", encoding="utf-8") as log:
            process = subprocess.Popen(
                [args.app], stdout=log, stderr=subprocess.STDOUT,
                env={**os.environ, "DRIFTING_PROFILE": profile,
                     "DRIFTING_WINDOW_DISPLAY": "secondary", "DRIFTING_APPEARANCE": "light"},
            )
        processes.append(process)
        until(lambda: process.poll() is not None or (data / "debug-bridge.json").is_file(), "bridge")
        assert process.poll() is None
        wait()
        app("window.focus")
        windows = app("app.info")["windows"]
        workspace = next(w for w in windows if w["workspace"])
        (args.out / f"window-{number}.json").write_text(
            json.dumps(workspace, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
        )
        assert workspace["visible"] and workspace["primaryDisplay"] is False, workspace
        return process

    def quit(process):
        assert app("app.quit")["quitting"]
        assert process.wait(timeout=40) == 0

    cli("workspace", "scenario", "seed:showcase", "--library", data / "library", "--yes")
    (data / "settings.json").write_text(json.dumps({
        "account": {"language.ui_locale": "en"},
        "device": {"modules": {"first_run.done": True}},
    }), encoding="utf-8")
    export = args.out / "markdown"
    export.mkdir()
    backup = args.out / "library.drifting"
    processes = []
    try:
        process = launch(1)
        show_book()
        book = app("state.get")["book"]["id"]
        entries = command("entry.list", book=book, all=True)
        entry = next(row["id"] for row in entries if row["title"] == "第四章 第一张单子")
        target = f"entry:{entry}/mod-prose"
        original = command("prose.read", doc=f"body:{entry}/mod-prose")["paragraphs"][0]["text"]

        settings("markdown folder")
        app("panel.answer", path=str(export))
        press("Choose folder")
        document = until(lambda: next((path for path in export.rglob("*.md")
                                       if ".drifting" not in path.parts
                                       and f"drifting-id: {entry}/mod-prose\n" in read(path)), None),
                         "the chapter's Markdown file")
        app("input.key", keys="escape")
        chapter(original)

        assert app("input.mark", text="组字")["marked"]
        external = "外面改过。" + original
        outside(original, external)
        app("ui.wait", until="time", ms=2400)
        # The chapter and its durable document must both still show the old base.
        assert app("state.get")["ime"]["text"] == "组字"
        assert app("page.text")["paragraphs"][0]["text"] == original
        assert command("prose.read", doc=f"body:{entry}/mod-prose")["paragraphs"][0]["text"] == original
        assert not app("input.mark", text="")["marked"]
        wait(page={"/paragraphs/0/text": external})
        screenshot("01-external-edit.png")
        print("External edit deferred during composition, then appeared in the open editor.", flush=True)

        app("input.key", keys="secondary-up")
        app("input.type", text="在 App 写。")
        disk_has("在 App 写。")
        saved = app("page.text")["paragraphs"][0]["text"]
        assert saved.startswith("在 App 写。"), saved
        settings("backup")
        app("panel.answer", path=str(backup))
        press("Export backup…")
        wait(state={"/transfer/state": "done"})
        press("Close")

        settings("backup")
        app("panel.answer", path=str(backup))
        press("Choose backup…")
        wait(state={"/transfer/state": "confirm"})
        command("prose.replace", doc=f"body:{entry}/mod-prose", find=saved,
                replace="换库前新写。" + saved)
        assert "换库前新写。" not in read(document)
        press("Replace and restore")
        wait(state={"/dialog": False, "/library": True, "/shelf": True})
        until(lambda: any("换库前新写。" in read(p) for p in export.rglob("*.md")
                          if ".drifting" in p.parts), "the drained file in preserved")
        show_book()
        chapter(saved)
        disk_has(saved)
        assert "换库前新写。" not in read(document)
        screenshot("02-restored.png")
        print("Swap drained the old library and preserved its newer file without undoing the restore.", flush=True)

        app("input.key", keys="secondary-up")
        app("input.type", text="退出前。")
        quit(process)
        disk_has("退出前。" + saved)
        reconciled = "关闭时外面改。" + saved
        outside("退出前。" + saved, reconciled)
        process = launch(2)
        # Startup may restore this tab already selected. Reopen the book from
        # the shelf so entering the chapter also hands focus to its editor.
        app("shelf.show")
        wait(state={"/shelf": True})
        show_book()
        chapter(reconciled)
        disk_has(reconciled)
        screenshot("03-reopened.png")
        quit(process)
        print("Quit drained the last local edit, and reopening reconciled an offline file edit.", flush=True)
    finally:
        for process in processes:
            if process.poll() is None:
                try:
                    quit(process)
                except (AssertionError, subprocess.SubprocessError):
                    process.terminate()
                    process.wait(timeout=15)


def main():
    assert sys.platform == "darwin", "This smoke uses macOS file panels and the accessibility tree."
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=lambda s: Path(s).resolve())
    parser.add_argument("--app", default=Path("target/debug/drifting"), type=Path)
    parser.add_argument("--cli", default=Path("target/debug/dr-cli"), type=Path)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    assert not any(args.out.iterdir()), f"Output folder must be empty: {args.out}"
    profile = f"mf-accept-{uuid.uuid4().hex[:10]}"
    instance = f"cc.drifting.next.dev.{profile}"
    data = Path.home() / "Library" / "Application Support" / instance
    data.mkdir(parents=True, exist_ok=False)
    try:
        smoke(args, profile, data)
    finally:
        shutil.rmtree(data)
        shutil.rmtree(Path.home() / "Library" / "Logs" / instance, ignore_errors=True)


if __name__ == "__main__":
    main()
