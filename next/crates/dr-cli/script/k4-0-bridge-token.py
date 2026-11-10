"""macOS native acceptance companion; never print or persist the bridge token.

Run alongside k4-0-bridge.json with the isolated app's PID, profile and a
receipt directory. The scenario overlay waits for token-<pid>.json.
"""

import json
import socket
import sys
import time
from pathlib import Path


def main():
    pid, profile, receipt_dir = int(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
    instance = "cc.drifting.next.dev." + profile
    connection = Path.home() / "Library/Application Support" / instance / "debug-bridge.json"
    deadline = time.monotonic() + 30
    while not connection.is_file():
        assert time.monotonic() < deadline, "bridge connection file did not appear"
        time.sleep(0.05)
    config = json.loads(connection.read_text())
    assert config["pid"] == pid and config["instance"] == instance, "wrong acceptance app"

    def connect(token):
        stream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        stream.settimeout(10)
        stream.connect(config["address"])
        wire = stream.makefile("rwb")
        wire.write((json.dumps({"hello": config["protocol"], "token": token}) + "\n").encode())
        wire.flush()
        return stream, wire, json.loads(wire.readline())

    stream, wire, refused = connect("deliberately-invalid-acceptance-token")
    assert refused["error"]["code"] == "unauthorized", "forged token was not refused"
    wire.close()
    stream.close()

    stream, wire, hello = connect(config["token"])
    assert hello["pid"] == pid and hello["instance"] == instance, "wrong authenticated app"
    request_id = 0
    while True:
        request_id += 1
        wire.write((json.dumps({"id": request_id, "method": "state.get", "params": {}}) + "\n").encode())
        wire.flush()
        reply = json.loads(wire.readline())
        assert reply["id"] == request_id, "wrong state.get response"
        if "error" in reply:
            assert reply["error"]["code"] in ("no_window", "no_library"), "state.get failed"
            assert time.monotonic() < deadline, "acceptance window did not become ready"
            time.sleep(0.05)
            continue
        state = reply["result"]
        if state["book"]["loaded"] and state["book"]["version"] == 3:
            break
        assert time.monotonic() < deadline, "v3 state did not load"
        time.sleep(0.05)
    assert state["panel"] == {"armed": None, "last": None, "shown": False}, "unexpected initial panel"
    wire.close()
    stream.close()
    receipt = {"pid": pid, "instance": instance, "rejectedCode": "unauthorized",
               "authenticated": True, "bookVersion": 3, "panel": state["panel"]}
    receipt_dir.mkdir(parents=True, exist_ok=True)
    target = receipt_dir / f"token-{pid}.json"
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(receipt, indent=2) + "\n")
    temporary.replace(target)


if __name__ == "__main__":
    main()
