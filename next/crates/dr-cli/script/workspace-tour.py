"""UP six-step native tour acceptance on a disposable showcase library.

From next/, build drifting with debug-bridge and dr-cli, then run:
python3 -I crates/dr-cli/script/workspace-tour.py --out <empty-dir>

Uses the existing bridge's actual AX buttons and platform key events. The
tour has no dedicated bridge read API; its Dialog titles identify the six
steps. Ring positions, fallback sentences and printed 1/6 .. 6/6 counts must
be reviewed in the saved screenshots. This script does not assert pixels,
pretend page.text reads UI text, or change product APIs for acceptance.
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
import traceback
import uuid


TITLES = ("Left sidebar", "Open and fill", "New", "Timeline", "Agent", "Project Home")


def until(probe, what, timeout=40):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        result = probe()
        if result:
            return result
        time.sleep(0.15)
    raise AssertionError(f"Timed out waiting for {what}")


class Window:
    def __init__(self, args, profile, data):
        self.args, self.profile, self.data = args, profile, data
        self.processes = []

    def record(self, entry):
        with (self.args.out / "calls.jsonl").open("a", encoding="utf-8") as log:
            log.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def cli(self, *argv):
        command = [str(self.args.cli), *map(str, argv)]
        result = subprocess.run(command, text=True, capture_output=True, timeout=90)
        if result.returncode:
            self.record({"argv": command[1:], "exit": result.returncode,
                         "stdout": result.stdout, "stderr": result.stderr})
            raise subprocess.CalledProcessError(result.returncode, command,
                                                result.stdout, result.stderr)
        return result.stdout

    def app(self, method, **params):
        self.record({"request": method, "params": params})
        result = json.loads(self.cli("app", "raw", method, "--profile", self.profile,
                                     "--params", json.dumps(params), "--timeout", "65000"))
        if method != "ui.screenshot":
            self.record({"method": method, "result": result})
        return result

    def query(self, name, **values):
        assert name.endswith((".list", ".get", ".read")), name
        return self.app("command.call", name=name, input=values)["output"]

    def state(self):
        return self.app("state.get")

    def ready(self, **state):
        self.app("ui.wait", until="ready", state=state, timeout_ms=60000)

    def press(self, label, role="Button", **extra):
        return self.app("ui.press", label=label, role=role, **extra)

    def key(self, keys):
        self.app("input.key", keys=keys)

    def side(self, side, opened):
        if self.state()[side]["open"] != opened:
            self.press(f'{"Open" if opened else "Close"} {side} sidebar')
        self.ready(**{f"/{side}/open": opened})

    def shot(self, name):
        png = self.app("ui.screenshot")["png"]
        (self.args.out / f"{name}.png").write_bytes(base64.b64decode(png))
        # The complete AX snapshot is evidence of what the bridge can read.
        # Normal/custom-painted UI text may have no AX node.
        nodes = self.app("ui.find")
        (self.args.out / f"{name}.ax.json").write_text(
            json.dumps(nodes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def step(self, number):
        title = TITLES[number - 1]
        card = self.app("ui.find", label=title, role="Dialog", count=1, timeout_ms=12000)
        self.app("ui.find", label="Skip tour", role="Button", count=1,
                 within={"label": title, "role": "Dialog"})
        return card["nodes"][0]

    def next(self, number):
        self.step(number)
        self.press("Done" if number == 6 else "Next",
                   within={"label": TITLES[number - 1], "role": "Dialog"})
        if number < 6:
            self.step(number + 1)

    def no_tour(self, delay=True):
        if delay:
            # Observe past the real 700ms first-show delay, not merely an
            # instant with no card before the timer has had a chance to run.
            self.app("ui.wait", until="time", ms=1600)
        for title in TITLES:
            self.app("ui.find", label=title, role="Dialog", absent=True, timeout_ms=2000)

    def seen(self):
        saved = json.loads((self.data / "settings.json").read_text(encoding="utf-8"))
        return "workspace-tour" in saved.get("device", {}).get("modules", {}).get("guides.seen", [])

    def save_seen(self, name):
        saved = json.loads((self.data / "settings.json").read_text(encoding="utf-8"))
        evidence = {"profile": self.profile,
                    "guides.seen": saved.get("device", {}).get("modules", {}).get("guides.seen", [])}
        (self.args.out / f"{name}.json").write_text(
            json.dumps(evidence, indent=2) + "\n", encoding="utf-8")

    def open_book(self, book):
        # Existing shelf navigation is the same action as All projects. The
        # book itself opens through the real visible shelf card's click.
        self.app("shelf.show")
        self.ready(**{"/shelf": True})
        label = f'Open “{book["name"]}”'
        for _ in range(8):
            node = self.app("ui.find", label=label, role="Button", count=1)["nodes"][0]
            box = node["bounds"]
            if 45 <= box["y"] and box["y"] + box["height"] <= 880:
                break
            self.app("input.scroll", x=800, y=450, dy=node["center"][1] - 450)
            self.app("ui.wait", until="time", ms=400)
        else:
            raise AssertionError(f"Shelf card did not become visible: {label}")
        self.press(label)
        self.ready(**{"/book/id": book["id"], "/shelf": False})

    def launch(self, number):
        with (self.args.out / f"app-{number}.log").open("w", encoding="utf-8") as log:
            process = subprocess.Popen([self.args.app], stdout=log, stderr=subprocess.STDOUT,
                                       env={**os.environ, "DRIFTING_PROFILE": self.profile,
                                            "DRIFTING_WINDOW_DISPLAY": "secondary",
                                            "DRIFTING_APPEARANCE": self.args.appearance})
        self.processes.append(process)

        def bridge_ready():
            assert process.poll() is None, f"App exited during launch: {process.returncode}"
            try:
                connection = json.loads((self.data / "debug-bridge.json").read_text(encoding="utf-8"))
            except FileNotFoundError:
                return False
            if connection["pid"] != process.pid:
                return False  # a stale rendezvous file from the previous process
            # The connection file is atomic. Once it names this process,
            # protocol/CLI errors must fail acceptance rather than be hidden.
            return self.app("app.info")["pid"] == process.pid

        until(bridge_ready, "this process's bridge")
        self.ready()
        self.app("window.focus")
        window = next(w for w in self.app("app.info")["windows"] if w["workspace"])
        assert window["visible"] and window["primaryDisplay"] is False, window
        assert window["bounds"]["width"] == 1440 and window["bounds"]["height"] == 900, window
        (self.args.out / f"window-{number}.json").write_text(json.dumps(window, indent=2) + "\n")
        (self.args.out / f"launch-{number}.json").write_text(
            json.dumps({"profile": self.profile, "pid": process.pid}, indent=2) + "\n")
        return process

    def quit(self, process):
        assert self.app("app.quit")["quitting"]
        assert process.wait(timeout=40) == 0


def inspect(w):
    process = w.launch(1)
    books = w.query("book.list")
    first = next(b for b in books if b["name"] == "阿Q正传（示例）")
    second = next(b for b in books if b["id"] != first["id"])
    assert not w.seen(), "fresh device must not be pre-marked seen"
    w.open_book(first)
    w.step(1)

    w.side("left", False)
    w.step(1)
    w.shot("01-tabs-closed-fallback")
    w.side("left", True)
    w.step(1)
    w.shot("02-tabs-open")
    w.key("secondary-shift-l")
    until(lambda: w.state()["v3Sidebar"]["keyboard"]["in"] in ("tabs", "tree", "column"),
          "KB focus in the real left column")
    w.key("escape")
    w.ready(**{"/v3Sidebar/keyboard/in": None})
    w.step(1)
    assert not w.seen(), "Esc from the left column must not skip the guide"
    w.shot("03-tabs-after-keyboard-escape")

    w.next(1)
    w.shot("04-open-and-fill")
    w.press("Fill left sidebar")
    w.ready(**{"/fill": "left"})
    w.no_tour(delay=False)
    w.shot("05-filled-guide-hidden")
    w.press("Exit fill")
    w.ready(**{"/fill": None})
    w.step(1)
    w.shot("06-unfilled-guide-restarted")
    w.next(1)
    w.next(2)
    w.shot("07-create")
    w.next(3)
    w.shot("08-timeline")
    w.next(4)

    w.side("right", False)
    w.step(5)
    w.shot("09-agent-closed-fallback")
    w.side("right", True)
    w.step(5)
    agent = w.app("ui.find", label="Agent", role="RadioButton", count=1)["nodes"][0]
    assert agent["bounds"]["width"] > 0
    w.press("Agent", role="RadioButton")
    until(lambda: any(p["tab"] == "companion" for p in w.state()["right"]["panes"]["panes"]),
          "Agent segment still switches the right panel")
    w.step(5)
    w.shot("10-agent-own-segment")
    w.next(5)
    w.shot("11-home-three-buttons")
    w.next(6)
    w.no_tour()
    until(w.seen, "completed tour written to device settings")
    w.shot("12-completed")

    # Settings Replay is a real button; the store is read, never edited,
    # while the app runs. Closing Settings must not immediately replay.
    w.key("secondary-,")
    w.ready(**{"/layer": "settings"})
    w.app("ui.focus", field="settings.search", select_all=True)
    w.app("input.type", text="Tour when a book first opens")
    w.press("Show again")
    until(lambda: not w.seen(), "Settings reset saved")
    w.shot("13-settings-replay")
    for _ in range(2):
        w.key("escape")  # first clears the search, second closes Settings
        if w.state()["layer"] != "settings":
            break
    w.ready(**{"/layer": None})
    w.no_tour()
    w.open_book(first)
    w.step(1)
    w.shot("14-reset-same-book-replayed")
    w.press("Skip tour", within={"label": TITLES[0], "role": "Dialog"})
    w.no_tour()
    until(w.seen, "skipped replay written to device settings")

    w.open_book(second)
    w.no_tour()
    w.shot("15-other-book-not-replayed")
    w.quit(process)
    assert w.seen()
    w.save_seen("seen-after-first-process-exit")
    process = w.launch(2)
    w.no_tour()
    w.open_book(first)
    w.no_tour()
    w.shot("16-restarted-device-not-replayed")
    assert w.seen()
    w.save_seen("seen-after-restart")
    w.quit(process)
    return {"first_book": first["id"], "second_book": second["id"],
            "dialog_titles_in_order": list(TITLES), "seen_after_restart": True,
            "screenshots_require_review": ["printed step counts", "fallback sentences",
                                            "rings on the correct controls", "Agent single segment"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=lambda p: Path(p).resolve())
    parser.add_argument("--appearance", choices=["light", "dark"], default="light")
    parser.add_argument("--app", type=lambda p: Path(p).resolve(), default=Path("target/debug/drifting").resolve())
    parser.add_argument("--cli", type=lambda p: Path(p).resolve(), default=Path("target/debug/dr-cli").resolve())
    args = parser.parse_args()
    assert sys.platform == "darwin", "AX acceptance currently uses macOS"
    args.out.mkdir(parents=True, exist_ok=True)
    assert not any(args.out.iterdir()), "use an empty output directory; prior failures are retained"
    assert args.app.is_file() and args.cli.is_file(), "build the debug-bridge App and CLI first"
    profile = f"up-tour-{uuid.uuid4().hex[:10]}"
    instance = f"cc.drifting.next.dev.{profile}"
    data = Path.home() / "Library" / "Application Support" / instance
    data.mkdir(parents=True, exist_ok=False)
    w = Window(args, profile, data)
    try:
        seed_log = w.cli("workspace", "scenario", "seed:showcase", "--library", data / "library", "--yes")
        (args.out / "seed.log").write_text(seed_log, encoding="utf-8")
        (data / "settings.json").write_text(json.dumps({
            "account": {"language.ui_locale": "en"},
            "device": {"modules": {"first_run.done": True}},
        }), encoding="utf-8")
        result = inspect(w)
        (args.out / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n",
                                                encoding="utf-8")
        print("Tour UI actions passed; saved screenshots still require visual review.", flush=True)
    except BaseException:
        (args.out / "failure.txt").write_text(traceback.format_exc(), encoding="utf-8")
        if any(p.poll() is None for p in w.processes):
            try:
                w.shot("failure")
                (args.out / "failure-state.json").write_text(json.dumps(w.state(), ensure_ascii=False, indent=2))
            except (AssertionError, subprocess.SubprocessError, ValueError, OSError):
                (args.out / "failure-capture.txt").write_text(traceback.format_exc(), encoding="utf-8")
        raise
    finally:
        for process in w.processes:
            if process.poll() is None:
                try:
                    w.app("app.quit")
                    process.wait(timeout=20)
                except (subprocess.SubprocessError, ValueError, OSError):
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=10)
        shutil.rmtree(data)
        shutil.rmtree(Path.home() / "Library" / "Logs" / instance, ignore_errors=True)


if __name__ == "__main__":
    main()
