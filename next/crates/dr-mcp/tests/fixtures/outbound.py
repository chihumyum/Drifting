"""Synthetic newline JSON-RPC peer; never reads user configuration."""
import json
import os
import pathlib
import sys
import subprocess
import time

def publish_pid(path, pid):
    pending = path.with_name(path.name + ".tmp")
    pending.write_text(str(pid))
    pending.replace(path)


marker = pathlib.Path(sys.argv[1])
publish_pid(marker.with_suffix(".pid"), os.getpid())
if len(sys.argv) > 2 and sys.argv[2] == "hang":
    time.sleep(120)
if len(sys.argv) > 2 and sys.argv[2] in ("stderr", "hang-tree"):
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    publish_pid(marker.with_suffix(".child.pid"), child.pid)
    if sys.argv[2] == "hang-tree":
        time.sleep(120)
    sys.stderr.write("x" * (2 * 1024 * 1024))
    sys.stderr.flush()
for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    if "id" not in request:
        continue
    if method == "initialize":
        result = {"protocolVersion": request["params"]["protocolVersion"],
                  "capabilities": {"tools": {}},
                  "serverInfo": {"name": "synthetic-stdio", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{"name": "echo", "description": "Synthetic protocol fixture",
                             "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}},
                             "annotations": {"readOnlyHint": True}}]}
    elif method == "tools/call":
        marker.write_text(str(int(marker.read_text()) + 1) if marker.exists() else "1")
        result = {"content": [{"type": "text", "text": json.dumps(request["params"].get("arguments", {}))}]}
    else:
        result = {}
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
