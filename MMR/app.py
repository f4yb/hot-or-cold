"""
The Digital Score - server

Run:   python app.py
Open:  https://<your-computer-ip>:5000   (accept the self-signed certificate warning on each device)

The server is the single source of truth for positions. It also computes the
seeker's smoothed walking speed, which the seeker's browser maps to tempo.
All audio is synthesised in the browser (Web Audio API) from the state broadcast here.
"""
import math
import os
import random
import time

from flask import Flask, request, send_file
from flask_socketio import SocketIO, emit

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- Tunable game parameters -------------------------------------------------
ROOM = {"w": 10.0, "h": 8.0}   # metres; set to your real room size
FOUND_RADIUS = 0.6             # metres: seeker this close = hider found
MAX_HIDERS = 3                 # one timbre each: 0 piano, 1 violin, 2 bell
MAX_SPEED = 3.0                # m/s cap to ignore position glitches
SPEED_SMOOTHING = 0.6          # 0..1, higher = smoother but laggier tempo changes
OUT_OF_BOUNDS_MARGIN = 0.5     # how far past a wall a player may drift

state = {"seeker": None, "hiders": {}}   # hiders keyed by socket id


def snapshot():
    s = state["seeker"]
    return {
        "room": ROOM,
        "seeker": None if not s else {"x": s["x"], "y": s["y"], "speed": s["speed"]},
        "hiders": [
            {"id": h["id"], "x": h["x"], "y": h["y"], "timbre": h["timbre"], "found": h["found"]}
            for h in state["hiders"].values()
        ],
    }


def broadcast():
    socketio.emit("state", snapshot())


@app.route("/")
def index():
    return send_file(os.path.join(HERE, "index.html"))


@socketio.on("join")
def on_join(data):
    role = (data or {}).get("role")
    sid = request.sid

    if role == "seeker":
        if state["seeker"] and state["seeker"]["sid"] != sid:
            emit("join_error", {"message": "A seeker is already in the game."})
            return
        x, y = ROOM["w"] / 2, ROOM["h"] / 2
        state["seeker"] = {"sid": sid, "x": x, "y": y, "px": x, "py": y,
                           "t": time.monotonic(), "speed": 0.0}
        emit("joined", {"role": role, "x": x, "y": y, "room": ROOM})

    elif role == "hider":
        used = {h["id"] for h in state["hiders"].values()}
        free = [i for i in range(1, MAX_HIDERS + 1) if i not in used]
        if not free:
            emit("join_error", {"message": f"Maximum of {MAX_HIDERS} hiders reached."})
            return
        hid = free[0]
        x = random.uniform(1, ROOM["w"] - 1)
        y = random.uniform(1, ROOM["h"] - 1)
        state["hiders"][sid] = {"id": hid, "x": x, "y": y, "timbre": hid - 1, "found": False}
        emit("joined", {"role": role, "id": hid, "timbre": hid - 1, "x": x, "y": y, "room": ROOM})

    else:  # spectator: map only, useful for the demo video
        emit("joined", {"role": "spectator", "room": ROOM})

    broadcast()


@socketio.on("move")
def on_move(data):
    sid = request.sid
    try:
        x = float(data["x"])
        y = float(data["y"])
    except (KeyError, TypeError, ValueError):
        return
    m = OUT_OF_BOUNDS_MARGIN
    x = min(max(x, -m), ROOM["w"] + m)
    y = min(max(y, -m), ROOM["h"] + m)

    seeker = state["seeker"]
    if seeker and seeker["sid"] == sid:
        now = time.monotonic()
        dt = now - seeker["t"]
        if dt > 0.02:
            inst = min(math.hypot(x - seeker["px"], y - seeker["py"]) / dt, MAX_SPEED)
            seeker["speed"] = SPEED_SMOOTHING * seeker["speed"] + (1 - SPEED_SMOOTHING) * inst
            seeker["px"], seeker["py"], seeker["t"] = x, y, now
        seeker["x"], seeker["y"] = x, y

        for h in state["hiders"].values():
            if not h["found"] and math.hypot(h["x"] - x, h["y"] - y) < FOUND_RADIUS:
                h["found"] = True
                socketio.emit("found", {"id": h["id"]})

    elif sid in state["hiders"]:
        state["hiders"][sid]["x"] = x
        state["hiders"][sid]["y"] = y

    broadcast()


@socketio.on("reset")
def on_reset():
    for h in state["hiders"].values():
        h["found"] = False
    broadcast()


@socketio.on("disconnect")
def on_disconnect(*_):
    sid = request.sid
    if state["seeker"] and state["seeker"]["sid"] == sid:
        state["seeker"] = None
    state["hiders"].pop(sid, None)
    broadcast()


def lan_ip():
    """Best-guess LAN address of this machine (no traffic is actually sent)."""
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == '__main__':
    use_https = os.getenv('USE_HTTPS', '1') == '1'

    if use_https:
        print("\n[INFO] Starting secure HTTPS server with adhoc SSL...")
        socketio.run(app, host='0.0.0.0', port=5000, debug=True, ssl_context='adhoc')
    else:
        print("\n[INFO] Starting HTTP server for Cloudflare Tunnel on port 5000...")
        socketio.run(app, host='0.0.0.0', port=5000, debug=True)