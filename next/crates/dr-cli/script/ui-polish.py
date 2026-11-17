"""UP third-round native visual acceptance on a disposable seeded library.

Build drifting with debug-bridge and dr-cli in next/, then run:
python3 -I crates/dr-cli/script/ui-polish.py --seed showcase --appearance light --out <empty-dir>
Repeat with showcase/lite and light/dark. Assertions cover actual UI actions
and saved data; the resulting screenshots still need visual review. This is
not a pixel test and does not claim Windows, 1x or physical input acceptance.
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


def until(probe, what, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = probe()
        if result:
            return result
        time.sleep(0.15)
    raise AssertionError(f"Timed out waiting for {what}")


class Window:
    def __init__(self, args, profile):
        self.args, self.profile = args, profile

    def cli(self, *argv):
        return subprocess.check_output([self.args.cli, *argv], text=True, timeout=90)

    def app(self, method, **params):
        result = json.loads(self.cli("app", "raw", method, "--profile", self.profile,
                                     "--params", json.dumps(params), "--timeout", "65000"))
        if method != "ui.screenshot":
            with (self.args.out / "calls.jsonl").open("a", encoding="utf-8") as log:
                log.write(json.dumps({"method": method, "params": params, "result": result},
                                     ensure_ascii=False) + "\n")
        return result

    def query(self, name, **values):
        assert name.endswith((".get", ".list", ".read")), name
        return self.app("command.call", name=name, input=values)["output"]

    def state(self):
        return self.app("state.get")

    def press(self, label, role="Button", **extra):
        return self.app("ui.press", label=label, role=role, **extra)

    def shot(self, name):
        png = self.app("ui.screenshot")["png"]
        (self.args.out / name).write_bytes(base64.b64decode(png))

    def ready(self, **state):
        self.app("ui.wait", until="ready", state=state, timeout_ms=60000)

    def side(self, side, opened):
        if self.state()[side]["open"] != opened:
            self.press(f'{"Open" if opened else "Close"} {side} sidebar')
        self.ready(**{f"/{side}/open": opened})

    def open_module(self, entry, module):
        target = f"entry:{entry}/{module}"
        assert self.app("nav.open", target=target)["opened"] == target
        self.ready()
        state = self.state()
        assert entry in state["page"]
        assert any(section["id"] == module for section in state["v3Page"]["sections"])
        # v3Page.module is the target at construction; reusing an entry page
        # reveals another section without replacing that original target.

    def reveal(self, label, role="Button", nth=0):
        # AX includes offscreen nodes. Scroll the paper until this actual
        # control is inside the viewport; finding its label alone is not enough.
        for _ in range(6):
            node = self.app("ui.find", label=label, role=role)["nodes"][nth]
            box = node["bounds"]
            if 80 <= box["y"] and box["y"] + box["height"] <= 850:
                return node
            self.app("input.scroll", x=800, y=480, dy=node["center"][1] - 450)
            self.app("ui.wait", until="time", ms=500)
        raise AssertionError(f"Could not scroll {label} into the viewport")


def inspect(w):
    info = w.app("app.info")
    window = next(item for item in info["windows"] if item["workspace"])
    assert window["visible"] and window["primaryDisplay"] is False, window
    assert window["bounds"]["width"] == 1440 and window["bounds"]["height"] == 900, window
    (w.args.out / "window.json").write_text(json.dumps(window, indent=2) + "\n")
    w.app("shelf.show")
    w.ready(**{"/shelf": True})
    w.app("ui.find", label="Writing heatmap")
    w.shot("01-shelf.png")

    books = w.query("book.list")
    book = next(b for b in books if b["name"] == ("阿Q正传（示例）" if w.args.seed == "showcase" else books[0]["name"]))
    w.app("book.open", book=book["id"])
    w.ready(**{"/book/id": book["id"], "/shelf": False})
    w.press("Project Home")
    w.side("left", False)
    w.side("right", False)
    if w.state()["bottom"]["pane"] is not None:
        w.app("action.dispatch", name="workspace::ToggleBottomTimeline")
    w.shot("02-home.png")
    w.reveal("Structure")
    w.shot("03-structure-thumbnail.png")
    w.reveal("Save as project template")
    w.press("Save as project template")
    w.ready(**{"/dialog": True})
    w.shot("04-save-template.png")
    w.app("input.key", keys="escape")
    w.ready(**{"/dialog": False})

    # The sample's existing modules, never hard-coded built-in template ids.
    entries = w.query("entry.list", book=book["id"], all=True)
    templates = {t["id"]: t for t in w.query("entry_template.list", book=book["id"])}
    manuscript = w.state()["v3"]["manuscript"]
    assert manuscript
    chapter = manuscript[0]
    w.open_module(chapter["entry"], chapter["module"])
    w.shot("05-chapter-prose.png")
    w.side("left", True)
    w.side("right", True)
    w.shot("06-paper-corners.png")

    def module_of(entry, kind):
        return next((m for m in templates.get(entry.get("template"), {}).get("modules", [])
                     if m["kind"] == kind), None)

    character = next(e for e in entries if module_of(e, "kv") and module_of(e, "patches"))
    kv = module_of(character, "kv")
    w.side("right", False)
    w.open_module(character["id"], kv["id"])
    w.reveal("Add field")
    w.shot("07-fields-header.png")
    old_fields = w.query("module.read", book=book["id"], entry=character["id"], module=kv["id"])["kv"]
    w.press("Add field")
    w.app("input.type", text="Synthetic UP field")
    w.reveal("Content", role="Group", nth=len(old_fields))
    w.press("Content", role="Group", nth=len(old_fields))
    w.app("input.type", text="Synthetic UP value")
    # Leave the new row, rather than moving back to its own key. Queued
    # row saves settle after neither editor in that row owns the focus.
    assert old_fields, "the two acceptance seeds have an existing field"
    w.reveal("Field", role="Group", nth=0)
    w.press("Field", role="Group", nth=0)
    w.app("app.info")
    def saved_field():
        data = w.query("module.read", book=book["id"], entry=character["id"], module=kv["id"])
        return data if any(row["key"] == "Synthetic UP field" and row["value"] == "Synthetic UP value"
                           for row in data["kv"]) else None
    until(saved_field, "field added from its module header")
    w.shot("08-fields-added.png")

    patches = module_of(character, "patches")
    w.open_module(character["id"], patches["id"])
    before = w.query("module.read", book=book["id"], entry=character["id"], module=patches["id"])["patches"]
    w.reveal("New patch")
    w.press("New patch")
    def added_patch():
        rows = w.query("module.read", book=book["id"], entry=character["id"], module=patches["id"])["patches"]
        return rows if len(rows) == len(before) + 1 else None
    new = until(added_patch, "patch added")
    w.reveal("Delete", nth=len(before))
    w.shot("09-patch-delete.png")
    # The newly appended patch's small Delete word, after any existing rows.
    w.app("ui.hover", label="Delete", role="Button", nth=len(before))
    w.shot("10-patch-delete-hover.png")
    w.press("Delete", nth=len(before))
    until(lambda: len(w.query("module.read", book=book["id"], entry=character["id"], module=patches["id"])["patches"]) == len(before), "patch deleted")

    # Categories and equal cells under the same compact presentation. Sidebar
    # widths and screenshots are retained; cell geometry needs visual review.
    compact = next(t for t in w.state()["v3Sidebar"]["tabs"]
                   if t["mount"]["kind"] == "entry"
                   and w.state()["v3"]["levels"][t["mount"]["entry"]]["settings"]["display"] in ("grid", "island"))
    w.press(compact["name"], role="RadioButton")
    w.shot("11-compact-normal.png")
    left = w.state()["left"]["width"]
    w.app("input.drag", **{"from": [left - 1, 450], "to": [550, 450], "steps": 18})
    until(lambda: w.state()["left"]["width"] > left + 50, "wider left column")
    w.shot("12-compact-wide.png")
    w.app("input.drag", **{"from": [w.state()["left"]["width"] - 1, 450], "to": [300, 450], "steps": 18})
    # The shell clamps to the current Tab row's minimum (350 px here).
    until(lambda: w.state()["left"]["width"] <= left + 1, "narrower left column")
    w.shot("13-compact-narrow.png")

    saved_display = w.state()["v3Sidebar"]["display"]
    for label, slug in [("List", "list"), ("Grid", "grid"), ("Board", "board"), ("Islands", "island"), ("Relations", "relation")]:
        w.press("Fill left sidebar")
        w.ready(**{"/fill": "left"})
        w.press(label, role="RadioButton")
        w.ready(**{"/v3Sidebar/fillLayout": slug})
        if slug == "relation":
            w.shot("14a-filled-relations.png")
        w.press("Exit fill")
        w.ready(**{"/fill": None})
        assert w.state()["v3Sidebar"]["display"] == saved_display
        w.press("Fill left sidebar")
        w.ready(**{"/fill": "left", "/v3Sidebar/fillLayout": slug})
        w.press("Exit fill")
        w.ready(**{"/fill": None})
    w.shot("14-after-fill-roundtrips.png")
    inspect_copy(w)
    (w.args.out / "result.json").write_text(json.dumps({
        "window": window, "book": book["id"], "character": character["id"],
        "new_patch_id": next(p["id"] for p in new if p["id"] not in {p["id"] for p in before}),
        "saved_display": saved_display, "fill_roundtrips": 5,
    }, ensure_ascii=False, indent=2) + "\n")
    print("UP native actions passed; screenshots await visual review.", flush=True)


def inspect_copy(w):
    zh = w.args.copy_check
    labels = ["跟随系统", "浅色", "深色"] if zh else ["Follow system", "Light", "Dark"]
    w.press("本地书库菜单" if zh else "Local library menu")
    def ordered_modes():
        nodes = [w.app("ui.find", label=label, role="RadioButton", count=1)["nodes"][0] for label in labels]
        assert nodes[0]["center"][0] < nodes[1]["center"][0] < nodes[2]["center"][0], nodes
        return nodes
    ordered_modes()
    w.shot("15-account-appearance.png")
    w.press("设置" if zh else "Settings")
    w.ready(**{"/layer": "settings"})
    w.app("ui.focus", field="settings.search")
    w.app("input.type", text="theme")
    ordered_modes()
    w.shot("16-settings-appearance.png")
    w.app("input.key", keys="escape")


def main():
    assert sys.platform == "darwin"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=lambda p: Path(p).resolve())
    parser.add_argument("--seed", choices=["showcase", "lite"], required=True)
    parser.add_argument("--appearance", choices=["light", "dark"], required=True)
    parser.add_argument("--copy-check", action="store_true", help="only compare Simplified Chinese account/settings copy")
    parser.add_argument("--app", default=Path("target/debug/drifting"), type=Path)
    parser.add_argument("--cli", default=Path("target/debug/dr-cli"), type=Path)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    assert not any(args.out.iterdir())
    profile = f"up-accept-{uuid.uuid4().hex[:10]}"
    instance = f"cc.drifting.next.dev.{profile}"
    data = Path.home() / "Library" / "Application Support" / instance
    data.mkdir(parents=True, exist_ok=False)
    w = Window(args, profile)
    process = None
    try:
        w.cli("workspace", "scenario", f"seed:{args.seed}", "--library", data / "library", "--yes")
        (data / "settings.json").write_text(json.dumps({
            "account": {"language.ui_locale": "zh-CN" if args.copy_check else "en"},
            "device": {"modules": {"first_run.done": True, "guides.seen": ["workspace-tour"]}},
        }))
        with (args.out / "app.log").open("w", encoding="utf-8") as log:
            process = subprocess.Popen([args.app], stdout=log, stderr=subprocess.STDOUT,
                                       env={**os.environ, "DRIFTING_PROFILE": profile,
                                            "DRIFTING_WINDOW_DISPLAY": "secondary",
                                            "DRIFTING_APPEARANCE": args.appearance})
        until(lambda: process.poll() is not None or (data / "debug-bridge.json").is_file(), "bridge")
        assert process.poll() is None
        w.ready()
        w.app("window.focus")
        if args.copy_check:
            w.app("shelf.show")
            w.ready(**{"/shelf": True})
            w.shot("00-shelf-zh.png")
            book = w.query("book.list")[0]
            w.app("book.open", book=book["id"])
            w.ready(**{"/shelf": False})
            info = w.app("app.info")
            window = next(item for item in info["windows"] if item["workspace"])
            assert window["visible"] and window["primaryDisplay"] is False, window
            assert window["bounds"]["width"] == 1440 and window["bounds"]["height"] == 900, window
            (args.out / "window.json").write_text(json.dumps(window, indent=2) + "\n")
            inspect_copy(w)
            print("UP Chinese account/settings copy check passed; screenshots await review.", flush=True)
        else:
            inspect(w)
    except BaseException:
        if process is not None and process.poll() is None:
            try:
                w.shot("failure.png")
            except (AssertionError, subprocess.SubprocessError):
                pass
        raise
    finally:
        if process is not None and process.poll() is None:
            try:
                w.app("app.quit")
                assert process.wait(timeout=40) == 0
            except (AssertionError, subprocess.SubprocessError):
                process.terminate()
                process.wait(timeout=15)
        shutil.rmtree(data)
        shutil.rmtree(Path.home() / "Library" / "Logs" / instance, ignore_errors=True)


if __name__ == "__main__":
    main()
