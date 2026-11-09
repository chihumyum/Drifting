#!/usr/bin/env python3
"""Visible sidebar benchmark, synthetic heavy seeds, one disposable profile per case.

Open/dispatch measurements include CLI and IPC. Optional GPUI draw samples are
CPU draw/layout/prepaint/paint work, not GPU time or a presentation guarantee.
"""
import argparse
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import shutil
import statistics
import subprocess
import time


def stats(values):
    if not values:
        return {"samples": 0}
    ordered = sorted(values)
    return {"samples": len(values), "median_us": statistics.median(values),
            "p95_us": ordered[min(len(ordered)-1, math.ceil(len(ordered)*0.95)-1)],
            "max_us": max(values)}


def run_case(args, preset):
    out=args.out/preset;out.mkdir(parents=True,exist_ok=True)
    v3=preset.startswith("v3-")
    steps=[{"seed":preset},{"call":"book.list","input":{},"save":"books"},
           {"call":"entry.list" if v3 else "chapter.list", "input":{"book":"${books.0.id}",**({"all":True} if v3 else {})},"save":"entries"},
           {"launch":{"settings":{"device":{"modules":{"first_run.done":True,"guides.seen":["workspace-tour"]}},"account":{"language.ui_locale":"en"}}},"save":"launch"},
           {"app":"ui.wait","params":{"timeout_ms":30000}}, {"app":"app.quit"}]
    setup_file=out/"setup.json";setup_file.write_text(json.dumps({"steps":steps},ensure_ascii=False))
    with (out/"setup.log").open("w") as log:
        subprocess.run([str(args.cli),"workspace","scenario",str(setup_file),"--app",str(args.app),"--keep","--out",str(out)],stdout=log,stderr=subprocess.STDOUT,check=True)
    saved=json.loads((out/"result.json").read_text())["saved"]
    profile=saved["launch"]["profile"];instance=saved["launch"]["instance"]
    assert profile.startswith("accept-") and instance == "cc.drifting.next.dev."+profile
    entries=saved["entries"]
    first=next(e for e in entries if not v3 or e.get("template")=="tpl-chapter")
    frame_log=out/"frames.jsonl"
    if frame_log.exists():raise RuntimeError("frame output already exists; use a fresh output directory")

    def call(method,params=None):
        params=params or {};timeout=max(10000,params.get("timeout_ms",10000))+2000
        p=subprocess.run([str(args.cli),"app","raw",method,"--params",json.dumps(params),"--profile",profile,"--timeout",str(timeout)],capture_output=True,text=True)
        if p.returncode:
            (out/"failure.log").write_text(p.stdout+p.stderr)
            raise RuntimeError(p.stderr.strip() or p.stdout.strip())
        return json.loads(p.stdout)

    env=dict(os.environ,DRIFTING_PROFILE=profile)
    for key in ("DRIFTING_LIBRARY", "DRIFTING_BOOK"):env.pop(key,None)
    if args.frames:env["DRIFTING_G2_FRAME_LOG"]=str(frame_log)
    result={"preset":preset,"version":3 if v3 else 2,"build":args.build_label,"scroll_steps_each_direction":60,"scroll_step_px":56}
    with (out/"app.log").open("w") as log:
        child=subprocess.Popen([str(args.app)],env=env,stdout=log,stderr=log)
        try:
            deadline=time.monotonic()+45
            while True:
                try:call("app.info");break
                except RuntimeError:
                    if child.poll() is not None or time.monotonic()>deadline:raise
                    time.sleep(0.05)
            call("ui.wait",{"timeout_ms":30000});call("window.focus");time.sleep(0.25)
            begin=time.perf_counter();call("book.open",{"book":saved["books"][0]["id"]})
            call("action.dispatch",{"name":"workspace::ToggleLeftSidebar"})
            call("ui.wait",{"state":{"/book/loaded":True,"/book/version":3 if v3 else 2},"timeout_ms":args.timeout_ms})
            nodes=call("ui.find",{"label":first["title"],"timeout_ms":args.timeout_ms})["nodes"]
            sidebar_nodes=[node for node in nodes if 0 <= node["center"][0] < 351 and 70 < node["center"][1] < 600]
            if len(sidebar_nodes)!=1:raise RuntimeError("first entry is outside the visible sidebar or duplicated there")
            result["open_to_sidebar_entry_visible_ms"]=(time.perf_counter()-begin)*1000
            info=call("app.info");bounds=info["windows"][0]["bounds"]
            result["window_logical_px"]={"width":bounds["width"],"height":bounds["height"]}
            state=call("state.get")
            if (state.get("bottom") or {}).get("pane")=="timeline":
                call("action.dispatch",{"name":"workspace::ToggleBottomTimeline"});call("ui.wait",{"until":"time","ms":600})
            result["bottom_closed_for_scroll"]=(call("state.get").get("bottom") or {}).get("pane") is None
            if not result["bottom_closed_for_scroll"]:raise RuntimeError("bottom panel still open")
            time.sleep(1.2)
            result["load_before_scroll"]=os.getloadavg() if hasattr(os,"getloadavg") else None
            raw=[];phases=[]
            for direction in (1,-1):
                call("window.focus");time.sleep(0.25)
                visible=call("app.info")["windows"][0]
                if not (visible["active"] and visible["visible"]):raise RuntimeError("window is not active and visible; no valid frame benchmark")
                start=time.time_ns()//1000
                for _ in range(60):
                    t=time.perf_counter();call("input.scroll",{"x":120,"y":250,"dy":direction*56});raw.append((time.perf_counter()-t)*1_000_000)
                    time.sleep(0.02)
                end=time.time_ns()//1000
                visible=call("app.info")["windows"][0]
                if not (visible["active"] and visible["visible"]):raise RuntimeError("window lost visibility during scrolling; discard this run")
                phases.append({"direction":direction,"start_us":start,"end_us":end})
                call("ui.find",{"label":first["title"],"absent":direction==1,"timeout_ms":3000})
                result["scrolled_away_and_returned"]=direction==-1
                time.sleep(0.2)
                shot=call("ui.screenshot");(out/("forward.png" if direction==1 else "returned.png")).write_bytes(base64.b64decode(shot["png"]))
            result["scroll_dispatch"]=stats(raw)
            result["scroll_dispatch_raw_us"]=raw
            if args.frames:
                time.sleep(0.2)
                frames=[json.loads(line) for line in frame_log.read_text().splitlines() if line.strip()]
                chosen=[f for f in frames if any(p["start_us"]<=f["at_us"]<=p["end_us"]+16667 for p in phases)]
                if len(chosen)<10:raise RuntimeError("too few native draw samples")
                result["native_cpu"]={key:stats([f[key] for f in chosen]) for key in ("draw_us","layout_us","prepaint_us","paint_us")}
                result["native_cpu_raw"]=chosen
                result["measurement_intervals"]=phases
            result["complete"]=True
        except Exception as e:
            result.update(complete=False,error=str(e))
            # A small app.info response avoids asking the already-busy loader
            # to serialize the entire heavy snapshot while diagnosing a timeout.
            try:
                state=call("app.info");(out/"failure-app-info.json").write_text(json.dumps(state,indent=2))
            except RuntimeError:pass
            try:(out/"failure-state.json").write_text(json.dumps(call("state.get"),indent=2))
            except RuntimeError:pass
        finally:
            try:call("app.quit");child.wait(timeout=15)
            except (RuntimeError,subprocess.TimeoutExpired):
                if child.poll() is None:child.terminate();child.wait(timeout=15)
            # These are exactly the two locations of this script's new profile.
            if profile.startswith("accept-") and platform.system()=="Darwin":
                for parent in ("Application Support","Logs"):
                    shutil.rmtree(Path.home()/"Library"/parent/instance,ignore_errors=True)
    (out/"measurement.json").write_text(json.dumps(result,indent=2)+"\n")
    print(preset,"complete" if result["complete"] else "failed",flush=True)
    return result


def main():
    p=argparse.ArgumentParser();p.add_argument("--cli",type=Path,default=Path("target/debug/dr-cli"));p.add_argument("--app",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True);p.add_argument("--build-label",required=True);p.add_argument("--timeout-ms",type=int,default=240000)
    p.add_argument("--frames",action="store_true");p.add_argument("--preset",choices=("heavy","v3-heavy","both"),default="both")
    args=p.parse_args();args.cli=args.cli.resolve();args.app=args.app.resolve();args.out=args.out.resolve();args.out.mkdir(parents=True,exist_ok=True)
    report={"method":"Visible native window. Open and input dispatch include CLI/IPC. Native CPU draw work excludes GPU and presentation; one first book-open sample per case in a new app process; OS caches are not cleared. The bottom panel is closed for scrolling.",
            "system":platform.system(),"architecture":platform.machine(),"binary_sha256":hashlib.sha256(args.app.read_bytes()).hexdigest(),"cases":[]}
    presets=("heavy","v3-heavy") if args.preset=="both" else (args.preset,)
    for preset in presets:report["cases"].append(run_case(args,preset))
    (args.out/"measurement.json").write_text(json.dumps(report,indent=2)+"\n")
    raise SystemExit(any(not case["complete"] for case in report["cases"]))


if __name__=="__main__":main()
