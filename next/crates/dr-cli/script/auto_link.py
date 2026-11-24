"""AL's native-window smoke: each entry's own 「自动链接」 (kernel-v5 §16).

From next/, build drifting with --features debug-bridge and dr-cli, then run
python3 -I crates/dr-cli/script/auto_link.py --out <empty-dir>.
The disposable development profile is removed even when an assertion fails.
Pointer and keyboard input drive the switches (the name card's row, the
entry page's rows, the @ picker); F3 queries independently check the saved
switches and the text, and the painted frame says what is drawn as a link.

1. On a chapter of the showcase sample, the name card's 「自动链接」 turns a
   character off: its names on the page stop being links at once and the
   text is untouched; the row on its own page turns it back on and they
   come back.
2. A new character in a level the author made starts off: typing its name
   links nothing; turned on from its page, what was typed is linked (AB)
   and typing it links.
3. The level's switch turns what lives below it on, and off again.
4. @ lists a character whose switch is off; the picked link counts and is
   drawn as a link while it stays off.
"""

import argparse
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid


def until(probe, label, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = probe()
        if result:
            return result
        time.sleep(0.15)
    raise AssertionError(f"Timed out waiting for {label}")


def smoke(args, profile, data):
    def cli(*argv):
        return subprocess.check_output([args.cli, *argv], text=True, timeout=90)

    def app(method, **params):
        result = json.loads(cli("app", "raw", method, "--profile", profile,
                                "--params", json.dumps(params), "--timeout", "65000"))
        if method != "ui.screenshot":
            with (args.out / "calls.jsonl").open("a", encoding="utf-8") as log:
                log.write(json.dumps({"method": method, "params": params, "result": result},
                                     ensure_ascii=False) + "\n")
        return result

    def command(name, **values):
        return app("command.call", name=name, input=values)["output"]

    def press(label, role="Button", **extra):
        return app("ui.press", label=label, role=role, **extra)

    def screenshot(name, settle=500):
        shot = app("ui.screenshot", settle_ms=settle)
        (args.out / name).write_bytes(base64.b64decode(shot["png"]))

    def center(box):
        return {"x": box["x"] + box["width"] / 2,
                "y": box["y"] + box["height"] / 2}

    def painted():
        return [d for d in app("page.relations")["links"]
                if d["id"].startswith("l") and d["boxes"]]

    cli("workspace", "scenario", "seed:showcase", "--library", data / "library", "--yes")
    (data / "settings.json").write_text(json.dumps({
        "account": {"language.ui_locale": "en"},
        "device": {"modules": {"first_run.done": True, "guides.seen": ["workspace-tour"]}},
    }), encoding="utf-8")
    with (args.out / "app.log").open("w", encoding="utf-8") as log:
        process = subprocess.Popen([args.app], stdout=log, stderr=subprocess.STDOUT,
                                   env={**os.environ, "DRIFTING_PROFILE": profile,
                                        "DRIFTING_WINDOW_DISPLAY": "secondary",
                                        "DRIFTING_APPEARANCE": "light"})
    try:
        until(lambda: process.poll() is not None or (data / "debug-bridge.json").is_file(), "bridge")
        assert process.poll() is None
        app("ui.wait", until="ready", timeout_ms=60000)
        app("window.focus")
        window = next(w for w in app("app.info")["windows"] if w["workspace"])
        assert window["visible"] and window["primaryDisplay"] is False, window
        (args.out / "window.json").write_text(json.dumps(window, indent=2) + "\n")
        app("book.open", name="阿Q正传（示例）")
        app("ui.wait", until="ready", state={"/shelf": False}, timeout_ms=60000)
        book = app("state.get")["book"]["id"]
        # The bottom timeline covers the window's lower part.
        app("action.dispatch", name="workspace::ToggleBottomTimeline")
        chapter = next(e for e in command("entry.list", book=book, all=True)
                       if e["title"] == "第三章 续优胜记略")
        doc = f"body:{chapter['id']}/mod-prose"

        def switches():
            return {e["id"]: e["auto_link"] for e in command("entry.list", book=book, all=True)}

        def text():
            return command("prose.read", doc=doc)

        def open_page(target):
            # An entry made a moment ago reaches the window's book shortly.
            def opened():
                try:
                    app("nav.open", target=target)
                    return True
                except subprocess.CalledProcessError:
                    return False
            until(opened, f"{target} in the window's book", timeout=15)
            app("ui.wait", until="ready", timeout_ms=60000)
            time.sleep(0.8)

        def to_page_end():
            # The entry's own switches are at the page's end.
            app("input.scroll", x=720, y=420, dy=6000)
            time.sleep(0.5)

        def open_chapter():
            app("nav.open", target=f"entry:{chapter['id']}/mod-prose")
            app("ui.wait", until="ready", page={"/ready": True}, timeout_ms=60000)

        def type_at_end(words):
            app("ui.press", role="TextArea", dy=40)
            app("input.key", keys="secondary-down")
            app("input.type", text=words)

        open_chapter()
        before_text = text()
        links = until(painted, "painted entry names")
        screenshot("01-chapter.png")

        # 1. The name card's row turns the character under the pointer off.
        was = switches()
        app("input.move", **center(links[0]["boxes"][0]))
        app("ui.find", role="MenuItem", label="Automatic links")
        screenshot("02-card.png")
        press("Automatic links", role="MenuItem")
        until(lambda: switches() != was, "a switch turned off")
        now = switches()
        changed = [i for i in was if was[i] != now.get(i)]
        assert len(changed) == 1 and not now[changed[0]], changed
        target = changed[0]
        off = until(lambda: (p if len(p := painted()) < len(links) else None), "fewer links drawn")
        assert text() == before_text, "turning it off rewrites nothing"
        assert command("entry.mentions", book=book, entry=target)["total"] == 0
        screenshot("03-off.png")

        # ... the row on its own page turns it back on.
        open_page(f"entry:{target}")
        to_page_end()
        app("ui.find", role="CheckBox", label="Automatic links")
        screenshot("04-own-row.png")
        press("Automatic links", role="CheckBox")
        until(lambda: switches()[target], "the switch on")
        open_chapter()
        until(lambda: len(painted()) == len(links), "the links back")
        assert text() == before_text
        screenshot("05-back.png")

        # 2. A character in a level the author made starts off.
        group = command("entry.create", book=book, parent=None, template="tpl-group",
                        title="验收分组", level=True)["id"]
        fu = command("entry.create", book=book, parent=group, template="tpl-character",
                     title="阿福")["id"]
        gui = command("entry.create", book=book, parent=group, template="tpl-character",
                      title="阿贵")["id"]
        assert not switches()[fu] and not switches()[gui]
        open_chapter()
        type_at_end("阿福推门进来。")
        time.sleep(1.2)
        assert command("entry.mentions", book=book, entry=fu)["links"] == 0, "off: not linked"
        screenshot("06-typed-off.png")
        open_page(f"entry:{fu}")
        to_page_end()
        press("Automatic links", role="CheckBox")
        until(lambda: switches()[fu], "阿福 on")
        # Turned on, the name written while it was off is linked (AB).
        until(lambda: command("entry.mentions", book=book, entry=fu)["links"] == 1,
              "阿福 written while off, linked")
        open_chapter()
        type_at_end("阿福又来了。")
        until(lambda: command("entry.mentions", book=book, entry=fu)["links"] == 2, "阿福 linked")
        screenshot("07-typed-on.png")

        # 3. The level's switch (the first 「自动链接」 on a level's page).
        open_page(f"entry:{group}")
        press("Automatic links", role="CheckBox")
        until(lambda: switches()[gui], "阿贵 carried on")
        level = command("entry.get", book=book, id=group)
        assert level["overrides"]["auto_link"] is True, level["overrides"]
        screenshot("08-level-on.png")
        press("Automatic links", role="CheckBox")
        until(lambda: not switches()[gui] and not switches()[fu], "both carried off")
        screenshot("09-level-off.png")

        # 4. @ lists 阿贵 though it is off; the picked link counts.
        open_chapter()
        drawn = len(painted())
        type_at_end("@阿贵")
        app("ui.find", role="MenuItem", label="阿贵")
        screenshot("10-at.png")
        press("阿贵", role="MenuItem")
        until(lambda: command("entry.mentions", book=book, entry=gui)["total"] == 1,
              "the picked link counts while off")
        until(lambda: len(painted()) == drawn + 1, "the picked link drawn")
        assert not switches()[gui]
        screenshot("11-picked.png")
        result = {"book": book, "chapter": chapter["id"], "window": window,
                  "switched": target, "links": len(links), "off": len(off)}
        (args.out / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        print("Name card off → text, own row on → back, new entry off/on, level switch, @ while off passed.",
              flush=True)
    except BaseException:
        if process.poll() is None:
            try:
                screenshot("failure.png")
            except (AssertionError, subprocess.SubprocessError):
                pass
        raise
    finally:
        if process.poll() is None:
            try:
                app("app.quit")
                assert process.wait(timeout=40) == 0
            except (AssertionError, subprocess.SubprocessError):
                process.terminate()
                process.wait(timeout=15)


def main():
    assert sys.platform == "darwin", "This native smoke uses macOS accessibility."
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=lambda p: Path(p).resolve())
    parser.add_argument("--app", default=Path("target/debug/drifting"), type=Path)
    parser.add_argument("--cli", default=Path("target/debug/dr-cli"), type=Path)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    assert not any(args.out.iterdir()), f"Output folder must be empty: {args.out}"
    profile = f"al-accept-{uuid.uuid4().hex[:10]}"
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
