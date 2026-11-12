#!/usr/bin/env python3
"""Measure the heavy seed through the real debug-bridge window.

Run from next/, after building drifting with debug-bridge and dr-cli.
Reports CLI/bridge round trips, never presents them as GPU frame timings.
Only dr-testkit's built-in synthetic seeds are used. Profiles are disposable.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import platform
import shutil
import statistics
import subprocess
import time


def run_case(cli, app, out, preset, version):
    out.mkdir(parents=True, exist_ok=True)
    scenario = {
        "steps": [
            {"seed": preset},
            {"call": "book.list", "save": "books"},
            {"launch": {"settings": {
                "device": {"modules": {"first_run.done": True, "guides.seen": ["workspace-tour"]}},
                "account": {"language.ui_locale": "en"},
            }}, "save": "launch"},
            {"app": "ui.wait", "params": {"timeout_ms": 30000}},
            {"app": "app.quit"},
        ]
    }
    source = out / "setup.json"
    source.write_text(json.dumps(scenario))
    setup = subprocess.run([str(cli), "workspace", "scenario", str(source), "--app", str(app), "--keep", "--out", str(out)], capture_output=True, text=True, check=True)
    (out / "setup.log").write_text(setup.stdout + setup.stderr)
    saved = json.loads((out / "result.json").read_text())["saved"]
    profile = saved["launch"]["profile"]
    instance = saved["launch"]["instance"]

    def call(method, params=None):
        response = subprocess.run([str(cli), "app", "raw", method, "--params", json.dumps(params or {}), "--profile", profile, "--timeout", str(max(10000, (params or {}).get("timeout_ms", 10000)))], capture_output=True, text=True)
        if response.returncode:
            (out / "failure.log").write_text(response.stdout + response.stderr)
            raise subprocess.CalledProcessError(response.returncode, response.args, output=response.stdout, stderr=response.stderr)
        return json.loads(response.stdout)

    env = dict(os.environ, DRIFTING_PROFILE=profile)
    with (out / "measured-app.log").open("w") as log:
        child = subprocess.Popen([str(app)], env=env, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 45
            while True:
                try:
                    call("app.info")
                    (out / "failure.log").unlink(missing_ok=True)
                    break
                except subprocess.CalledProcessError:
                    if child.poll() is not None or time.monotonic() > deadline:
                        raise
                    time.sleep(0.05)
            call("ui.wait", {"timeout_ms": 30000})
            call("window.focus")
            started = time.perf_counter()
            call("book.open", {"book": saved["books"][0]["id"]})
            call("ui.wait", {"timeout_ms": 180000, "state": {"/book/version": version, "/book/loaded": True, "/bottom/pane": "timeline"}})
            opened = (time.perf_counter() - started) * 1000
            info = call("app.info")
            window = info["windows"][0]["bounds"]
            # Scroll horizontally through all 100 chapters, then back. The
            # panel's fixed labels stay still; the track takes the wheel.
            timings = []
            load = os.getloadavg() if hasattr(os, "getloadavg") else None
            for direction in (1, -1):
                for _ in range(24):
                    started = time.perf_counter()
                    call("input.scroll", {"x": window["width"] * 0.7, "y": window["height"] - 60, "dx": direction * 1000, "dy": 0})
                    timings.append((time.perf_counter() - started) * 1000)
                shot = call("ui.screenshot")
                (out / ("forward.png" if direction == 1 else "returned.png")).write_bytes(base64.b64decode(shot["png"]))
            call("ui.wait", {"timeout_ms": 30000})
            result = {"preset": preset, "version": version, "load_before_scroll": load, "open_to_ready_ms": opened, "scroll_dispatch_ms": timings, "scroll_dispatch_median_ms": statistics.median(timings), "scroll_dispatch_max_ms": max(timings)}
            (out / "measurement.json").write_text(json.dumps(result, indent=2) + "\n")
            return result
        except Exception:
            try:
                (out / "failure-state.json").write_text(json.dumps(call("state.get"), indent=2))
                shot = call("ui.screenshot")
                (out / "failure.png").write_bytes(base64.b64decode(shot["png"]))
            except subprocess.CalledProcessError:
                pass
            raise
        finally:
            try:
                call("app.quit")
                child.wait(timeout=15)
            finally:
                if child.poll() is None:
                    child.terminate()
                    child.wait(timeout=10)
                # The only kept profiles here were just made by this script.
                if profile.startswith("accept-") and platform.system() == "Darwin":
                    for parent in ("Application Support", "Logs"):
                        shutil.rmtree(Path.home() / "Library" / parent / instance, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cli", type=Path, default=Path("target/debug/dr-cli"))
    parser.add_argument("--app", type=Path, default=Path("target/debug/drifting"))
    parser.add_argument("--out", type=Path, default=Path("target/acceptance/k4-g3-heavy"))
    args = parser.parse_args()
    report = {"method": "Visible real window, debug build. Open = book.open + ui.wait; scrolling = 48 input.scroll CLI/bridge round trips, forward and back. Includes process/IPC overhead; not layout/paint or presented frame time.", "system": platform.system(), "architecture": platform.machine(), "cases": []}
    for seed, version in (("heavy", 4),):
        report["cases"].append(run_case(args.cli.resolve(), args.app.resolve(), args.out.resolve() / seed, seed, version))
    (args.out / "measurement.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
