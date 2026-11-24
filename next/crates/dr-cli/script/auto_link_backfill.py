"""AB's native-window smoke: turning automatic linking on links what is
already written (kernel-v5 §16 「打开时把全书补一遍」).

From next/, build drifting with --features debug-bridge and dr-cli, then run
python3 -I crates/dr-cli/script/auto_link_backfill.py --out <empty-dir>.
The disposable development profile is removed even when an assertion fails.
Pointer and keyboard input drive the settings switch and the entry pages'
switches; F3 queries independently check the switches and the links
(`entry.mentions`), and the painted frame says what is drawn as a link.

1. The author's setting off, a character's name is typed in a chapter of the
   showcase sample; turned on in Settings, the name becomes a link there.
2. A new character in a level the author made (off): its name is typed in
   the chapter; turned on from its own page, the chapter shows it linked.
3. A level's switch: two names typed while off are linked once it is on.
4. An entry whose name another linked entry has cannot be turned on: the
   window says which name and whose; the switch stays off.
5. While the input method composes in the open chapter, a switch turned on
   writes nothing there; once the composition ends, the name is linked.
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

    def painted():
        return [d for d in app("page.relations")["links"]
                if d["id"].startswith("l") and d["boxes"]]

    cli("workspace", "scenario", "seed:showcase", "--library", data / "library", "--yes")
    (data / "settings.json").write_text(json.dumps({
        "account": {"language.ui_locale": "en", "editor.auto_entity_links": False},
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
        entries = command("entry.list", book=book, all=True)
        chapter = next(e for e in entries if e["title"] == "第三章 续优胜记略")
        doc = f"body:{chapter['id']}/mod-prose"
        people = next(e for e in entries
                      if e["template"] == "tpl-category" and e["title"] == "人物")

        def switch(entry):
            return command("entry.get", book=book, id=entry)["auto_link"]

        def linked(entry):
            return command("entry.mentions", book=book, entry=entry)["links"]

        def open_page(target):
            app("nav.open", target=target)
            app("ui.wait", until="ready", timeout_ms=60000)
            time.sleep(0.8)

        def open_chapter():
            app("nav.open", target=f"entry:{chapter['id']}/mod-prose")
            app("ui.wait", until="ready", page={"/ready": True}, timeout_ms=60000)

        def type_at_end(words):
            app("ui.press", role="TextArea", dy=40)
            app("input.key", keys="secondary-down")
            app("input.type", text=words)

        def own_switch_on(entry):
            # A character's page (no level) has one 「自动链接」: its own.
            open_page(f"entry:{entry}")
            app("input.key", keys="secondary-down")
            press("Automatic links", role="CheckBox")

        result = {"book": book, "chapter": chapter["id"], "window": window}

        # 1. The author's setting off: a new character's name typed links nothing.
        assert app("settings.get", keys=["editor.auto_entity_links"])["values"][
            "editor.auto_entity_links"] is False
        gui = command("entry.create", book=book, parent=people["id"], template="tpl-character",
                      title="阿桂")["id"]
        assert switch(gui), "a character made in 人物 starts on"
        open_chapter()
        type_at_end("阿桂来了。")
        time.sleep(1.5)
        screenshot("01-setting-off.png")
        # Settings: the switch on.
        app("action.dispatch", name="app::OpenSettings")
        app("ui.wait", until="ready", state={"/layer": "settings"}, timeout_ms=30000)
        app("ui.focus", field="settings.search")
        app("input.type", text="link")
        press("Auto element links", role="CheckBox")
        until(lambda: app("settings.get", keys=["editor.auto_entity_links"])["values"][
            "editor.auto_entity_links"] is True, "the setting on")
        screenshot("02-setting-on.png")
        app("input.key", keys="escape")
        app("ui.wait", until="ready", state={"/layer": None}, timeout_ms=30000)
        open_chapter()
        until(lambda: linked(gui) == 1, "阿桂 written while the setting was off, linked")
        until(lambda: painted(), "links drawn")
        screenshot("03-linked-after-setting.png")

        # 2. A character in a level the author made starts off.
        group = command("entry.create", book=book, parent=None, template="tpl-group",
                        title="验收分组", level=True)["id"]
        fu = command("entry.create", book=book, parent=group, template="tpl-character",
                     title="阿福")["id"]
        assert not switch(fu)
        open_chapter()
        type_at_end("阿福推门进来。")
        time.sleep(1.5)
        assert linked(fu) == 0, "off: not linked"
        own_switch_on(fu)
        until(lambda: switch(fu), "阿福 on")
        open_chapter()
        until(lambda: linked(fu) == 1, "阿福 written while off, linked")
        screenshot("04-own-switch.png")

        # 3. The level's switch.
        group2 = command("entry.create", book=book, parent=None, template="tpl-group",
                         title="验收分组二", level=True)["id"]
        a = command("entry.create", book=book, parent=group2, template="tpl-character",
                    title="阿贵")["id"]
        b = command("entry.create", book=book, parent=group2, template="tpl-character",
                    title="小桂")["id"]
        open_chapter()
        type_at_end("阿贵和小桂。")
        time.sleep(1.5)
        assert linked(a) == 0 and linked(b) == 0
        open_page(f"entry:{group2}")
        press("Automatic links", role="CheckBox", nth=0)
        until(lambda: switch(a) and switch(b), "both carried on")
        until(lambda: linked(a) == 1 and linked(b) == 1, "both linked")
        open_chapter()
        screenshot("05-level-switch.png")

        # 4. A name another linked entry has.
        group3 = command("entry.create", book=book, parent=None, template="tpl-group",
                         title="验收分组三", level=True)["id"]
        twin = command("entry.create", book=book, parent=group3, template="tpl-character",
                       title="阿Q")["id"]
        own_switch_on(twin)
        expected = "Not turned on: “阿Q” is already the name or an alias of “阿Q”."
        try:
            app("ui.find", label=expected)
            result["refusal_found_by_label"] = True
        except subprocess.CalledProcessError:
            result["refusal_found_by_label"] = False
        screenshot("06-refusal.png", settle=200)
        time.sleep(1.0)
        assert not switch(twin), "refused: the switch stays off"

        # 5. Composing in the open chapter.
        xiao = command("entry.create", book=book, parent=group3, template="tpl-character",
                       title="小D子")["id"]
        open_chapter()
        type_at_end("小D子笑了。")
        time.sleep(1.5)
        app("input.mark", text="xi")
        command("entry.set_auto_link", book=book, id=xiao, auto_link=True)
        time.sleep(1.5)
        assert linked(xiao) == 0, "nothing written while composing"
        screenshot("07-composing.png")
        app("input.type", text="嘻")
        until(lambda: linked(xiao) == 1, "linked once the composition ended")
        screenshot("08-composed.png")

        (args.out / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        print("Setting on, own switch, level switch, refusal and composing passed.", flush=True)
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
    profile = f"ab-accept-{uuid.uuid4().hex[:10]}"
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
