#!/usr/bin/env python3
"""Compare real-window template open/scroll round trips on one v3-heavy library.

Run from next/, after building dr-cli and drifting with debug-bridge:
  python3 crates/dr-view-templates/script/window-bench.py leaf
  python3 crates/dr-view-templates/script/window-bench.py full

Uses a synthetic, isolated profile, reused for the comparison; never daily data.
Results/screenshots stay under target/acceptance/k5-heavy/. Timings include
bridge traffic and PNG readback, not just rendering. No bridge token is saved.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import socket
import shutil
import statistics
import subprocess
import sys
import time


ROOT = Path.cwd()
OUT = ROOT / "target/acceptance/k5-heavy"
CLI = ROOT / "target/debug/dr-cli"
APP = Path(os.environ.get("DRIFTING_BENCH_APP", str(ROOT / "target/debug/drifting"))).resolve()


def cli(*args):
    result = subprocess.run([str(CLI), *args], check=True, capture_output=True, text=True)
    return result.stdout


def measure(phase):
    OUT.mkdir(parents=True, exist_ok=True)
    # cargo test may replace target/debug/drifting with a build without the
    # bridge. Keep the chosen executable stable for the whole measurement.
    binary = OUT / f"{phase}-drifting-{os.getpid()}"
    shutil.copy2(APP, binary)
    manifest = OUT / "profile.json"
    if manifest.exists():
        config = json.loads(manifest.read_text())
    else:
        profile = f"k5-bench-{os.getpid()}"
        data = Path.home() / "Library/Application Support" / f"cc.drifting.next.dev.{profile}"
        if data.exists():
            raise RuntimeError("benchmark profile already exists")
        seed_file = OUT / "seed.json"
        seed_file.write_text(json.dumps({"steps": [{"seed": "v3-heavy"}, {"call": "book.list", "save": "books"}]}))
        # The live scenario's seed also rebuilds indexes, as required for
        # comparisons against an already-opened library.
        seed = cli("workspace", "scenario", str(seed_file), "--app", str(APP), "--profile", profile,
                   "--out", str(OUT / "seed"), "--yes")
        (OUT / "seed.txt").write_text(seed)
        books = json.loads((OUT / "seed/result.json").read_text())["saved"]["books"]
        config = {"profile": profile, "book": books[0]["id"]}
        manifest.write_text(json.dumps(config))
        (data / "settings.json").write_text(json.dumps({
            "device": {"modules": {"first_run.done": True, "guides.seen": ["workspace-tour"]}},
            "account": {"language.ui_locale": "en"},
        }))
    data = Path.home() / "Library/Application Support" / f"cc.drifting.next.dev.{config['profile']}"
    connection = data / "debug-bridge.json"
    if connection.exists():
        old = json.loads(connection.read_text())
        try:
            os.kill(old["pid"], 0)
        except ProcessLookupError:
            connection.unlink()
        else:
            raise RuntimeError("benchmark app is already running")
    env = dict(os.environ, DRIFTING_PROFILE=config["profile"], DRIFTING_BOOK=config["book"], DRIFTING_APPEARANCE="light")
    with (OUT / f"{phase}-app.log").open("w") as log:
        process = subprocess.Popen([str(binary)], env=env, stdout=log, stderr=log)
    stream = None
    try:
        deadline = time.monotonic() + 90
        while not connection.exists():
            if process.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError("benchmark app did not start; see its log")
            time.sleep(0.05)
        auth = json.loads(connection.read_text())
        stream = socket.socket(socket.AF_UNIX)
        stream.settimeout(360)
        stream.connect(auth["address"])
        reader = stream.makefile("rb")

        def send(value):
            stream.sendall(json.dumps(value).encode() + b"\n")
            return json.loads(reader.readline())

        send({"hello": auth["protocol"], "token": auth["token"]})
        serial = 0

        def call(method, params=None):
            nonlocal serial
            serial += 1
            result = send({"id": serial, "method": method, "params": params or {}})
            if "error" in result:
                raise RuntimeError(str(result["error"]))
            return result["result"]

        def screenshot(name=None, settle_ms=0):
            result = call("ui.screenshot", {"settle_ms": settle_ms})
            png = base64.b64decode(result["png"])
            if name:
                (OUT / f"{phase}-{name}.png").write_bytes(png)
            return png

        call("ui.wait", {"timeout_ms": 240000})
        call("window.focus")
        call("book.open", {"book": config["book"]})
        call("ui.wait", {"state": {"/book/version": 3}})
        templates = call("command.call", {"name": "entry_template.list", "input": {"book": config["book"]}})["output"]
        template = next(t for t in templates if t["id"] == "tpl-chapter")
        if phase == "leaf":
            template["modules"] = [module for module in template["modules"] if not module["id"].startswith("k5-bench-")]
            # Repeat the seed's own module definitions, with unique ids, so the
            # template editor has a genuine scroll range. No prose corpus added.
            originals = list(template["modules"])
            for index in range(24):
                module = json.loads(json.dumps(originals[index % len(originals)]))
                module["id"] = f"k5-bench-{index:02}"
                module["pos"] = None
                template["modules"].append(module)
            call("command.call", {"name": "entry_template.put", "input": {"book": config["book"], "template": template}})
            index = next(index for index, value in enumerate(templates) if value["id"] == "tpl-chapter")
            call("ui.wait", {"timeout_ms": 240000, "state": {f"/v3/templates/{index}/modules/{len(template['modules'])-1}/id": "k5-bench-23"}})
        opened, scrolls = [], []
        for index in range(7):
            call("nav.open", {"target": "template:tpl-character"})
            call("ui.find", {"label": "Template name", "count": 1})
            start = time.perf_counter()
            call("nav.open", {"target": "template:tpl-chapter"})
            call("ui.find", {"label": "Template name", "count": 1})
            top = screenshot("top" if index == 0 else None, settle_ms=200)
            opened.append((time.perf_counter() - start) * 1000)
            # Outside the open timing: finish the shell's navigation motion
            # before taking the pointer's hit-test position. Name fields in
            # the moving header can have stale accessibility bounds.
            call("ui.wait", {"until": "time", "ms": 350})
            bounds = call("ui.find", {"role": "Group", "label": template["modules"][0]["name"]})["nodes"][0]["bounds"]
            # The module's left edge is inside the scroll container and
            # outside inputs (which may consume wheel events).
            x, y = bounds["x"] + 4, bounds["y"] + 10
            start = time.perf_counter()
            call("input.scroll", {"x": x, "y": y, "dy": 4000})
            # Let the scroll event reach layout before reading the frame;
            # without this, an immediate PNG can still be the previous frame.
            bottom = screenshot("bottom" if index == 0 else None, settle_ms=50)
            if top == bottom:
                (OUT / f"{phase}-failed-scroll.json").write_text(json.dumps({
                    "pointer": [x, y], "module_bounds": bounds,
                    "app": call("app.info"), "sample": index,
                }, indent=2))
                raise RuntimeError("scroll did not change the rendered window")
            scrolls.append((time.perf_counter() - start) * 1000)
            call("input.scroll", {"x": x, "y": y, "dy": -10000})
            call("ui.wait", {"until": "time", "ms": 100})
        summary = lambda values: {"samples_ms": values, "median_ms": statistics.median(values), "max_ms": max(values)}
        result = {"phase": phase, "seed": "v3-heavy", "build": os.environ.get("DRIFTING_BENCH_BUILD", "debug-bridge"), "samples": 7,
                  "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                  "machine": {"architecture": os.uname().machine, "cpus": os.cpu_count(), "load_average": os.getloadavg()},
                  "includes": "bridge and PNG readback; open waits 200 ms for navigation animation; scroll waits 50 ms for layout", "open": summary(opened), "scroll": summary(scrolls)}
        (OUT / f"{phase}.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result))
        call("app.quit")
        process.wait(timeout=30)
    finally:
        if stream is not None:
            stream.close()
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=20)


if __name__ == "__main__":
    if sys.platform != "darwin" or len(sys.argv) != 2 or sys.argv[1] not in ("leaf", "full"):
        raise SystemExit("run on macOS from next/: window-bench.py leaf|full")
    measure(sys.argv[1])
