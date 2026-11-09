#!/usr/bin/env python3
"""Validate the freshly generated real-window level-page report."""
import json
import sys
from pathlib import Path


def check(path):
    report = json.loads(Path(path).read_text(encoding="utf-8"))
    assert report["pending"] == 0
    assert "app app.quit: ok" in report["steps"][-1]
    saved = report["saved"]
    def node(key):
        answer = saved[key]
        assert answer["count"] == 1, key
        return answer["nodes"][0]
    before = node("boardViewportBefore")["bounds"]
    after = node("boardViewportAfter")["bounds"]
    assert before == after, (before, after)
    for key in ("boardMembersHeading", "memberShown"):
        x, y = node(key)["center"]
        assert after["x"] <= x <= after["x"] + after["width"], (key, x)
        assert after["y"] <= y <= after["y"] + after["height"], (key, y)
    print("Level settings and board membership visible; enclosing page stationary; passed")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: check-v3-levels.py <result.json>")
    check(sys.argv[1])
