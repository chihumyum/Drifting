"""RL's combined native-window smoke, with the documented showcase sample.

From next/, build drifting with --features debug-bridge and dr-cli, then run
python3 -I crates/dr-cli/script/relations.py --out <empty-dir>.
The disposable development profile is removed even when an assertion fails.
Only frame inspection and ordinary pointer/keyboard input drive the new UI;
F3 queries independently check the resulting saved relation and entry link.
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
        entries = command("entry.list", book=book, all=True)
        by_id = {e["id"]: e for e in entries}
        chapter = next(e for e in entries if e["title"] == "第三章 续优胜记略")
        app("nav.open", target=f"entry:{chapter['id']}/mod-prose")
        app("ui.wait", until="ready", page={"/ready": True}, timeout_ms=60000)
        screenshot("01-chapter.png")

        links = until(lambda: [d for d in app("page.relations")["links"]
                               if d["id"].startswith("l") and d["boxes"]], "painted entry names")
        app("input.move", **center(links[0]["boxes"][0]))
        app("ui.find", role="Button", label="Relate")
        screenshot("02-hover.png")
        press("Relate")
        frame = until(lambda: (f if (f := app("page.relations"))["compose"] else None), "composer")
        source = frame["compose"]["src"]
        assert by_id[source]["title"] == "阿Q", by_id[source]
        picks = [p for p in frame["drawn"]["picks"] if by_id[p["entry"]]["title"] == "赵太爷"]
        assert picks, "The sample chapter must show 赵太爷 beside 阿Q."
        target = picks[0]["entry"]
        app("input.click", **center(picks[0]["box"]))
        name = "验收关系"
        press("Relation", role="Group")
        app("input.type", text=name)
        frame = app("page.relations")
        assert frame["compose"]["dst"] == target and frame["compose"]["ready"], frame
        screenshot("03-compose.png")
        press("Create", settle_ms=0)
        app("ui.find", label=name, role="Button")
        screenshot("04-revealed-row.png", settle=0)
        drawn = app("page.relations")["drawn"]
        assert drawn and any(
            {line["from"], line["to"]} == {source, target}
            and any(label["name"] == name for label in line["labels"])
            for line in drawn["lines"]
        ), "The created relation must actually be drawn beside the two sample names."
        relation = next(r for r in command("relation_type.list", book=book) if r["name"] == name)
        assert relation["pair_count"] == 1 and len(relation["rows"]) == 1, relation
        row = relation["rows"][0]
        assert row["left"] == [source] and row["right"] == [target], row
        state = app("state.get")
        assert state["right"]["open"], state["right"]

        # The existing description editor takes focus after its pencil is clicked.
        app("ui.hover", label=name, role="Button")
        press("Description")
        linked = by_id[target]
        app("input.type", text="@" + linked["title"])
        press(linked["title"], role="MenuItem")
        app("input.key", keys="enter")
        def linked_description():
            current = next(r for r in command("relation_type.list", book=book) if r["id"] == relation["id"])
            return current if any(link["entry"] == target for link in current["description"]["links"]) else None
        relation = until(linked_description, "saved description entry link")
        screenshot("05-linked-description.png")

        # A filled left Tab exposes its existing Relations arrangement.
        state = app("state.get")
        if not state["left"]["open"]:
            press("Open left sidebar")
        tabs = app("state.get")["v3Sidebar"]["tabs"]
        graph_tab = next((tab for tab in tabs if tab["name"] == "人物"),
                         next(tab for tab in tabs if tab["root"]))
        press(graph_tab["name"], role="RadioButton")
        press("Fill left sidebar")
        app("ui.wait", until="ready", state={"/fill": "left"}, timeout_ms=30000)
        press("Relations", role="RadioButton")
        app("ui.wait", until="ready", state={"/v3Sidebar/fillLayout": "relation"}, timeout_ms=30000)
        app("ui.find", label=f'Hide "{name}"', role="Button")
        screenshot("06-graph.png")
        result = {"book": book, "chapter": chapter["id"], "source": source, "target": target,
                  "relation": relation, "window": window}
        (args.out / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        print("Native hover → inline creation → revealed row → @ description → relation graph passed.", flush=True)
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
    profile = f"rl-accept-{uuid.uuid4().hex[:10]}"
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
