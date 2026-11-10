#!/usr/bin/env python3
"""Check the real-window coordinates saved by k4-g2-displays.json.

The scenario language's $sum accepts integers only; AX coordinates are floats.
No result JSON is committed: this checks the freshly generated bridge report.
"""
import json
import math
import sys
from pathlib import Path


def check(path):
    report = json.loads(Path(path).read_text(encoding="utf-8"))
    assert report["pending"] == 0, report["pending"]
    assert "app app.quit: ok" in report["steps"][-1], "scenario did not finish"
    nodes = []
    for key in ("boardANode", "boardBNode"):
        answer = report["saved"][key]
        assert answer["count"] == 1, (key, answer["count"])
        nodes.append(answer["nodes"][0]["center"])
    delta = [nodes[1][axis] - nodes[0][axis] for axis in (0, 1)]
    assert all(math.isclose(a, b, abs_tol=0.1) for a, b in zip(delta, (40, 80))), delta
    print(f"v3 board window coordinates: dx={delta[0]:.1f}, dy={delta[1]:.1f}; passed")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: check-v3-displays.py <scenario-result.json>")
    check(sys.argv[1])
