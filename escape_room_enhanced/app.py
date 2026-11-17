"""
MUSI3071 Escape Room Game — three-device Flask/Socket.IO server.

Run:
    pip install -r requirements.txt
    python app.py

Open the printed HTTPS address on the laptop, escapee phone and chaser phone
(on the same Wi-Fi). Accept the local certificate warning on each device.
"""
import math
import os
import random
import socket
import threading
import time

from flask import Flask, send_file
from flask_socketio import SocketIO, emit, join_room

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")
HERE = os.path.dirname(os.path.abspath(__file__))

ROOM_W, ROOM_H = 6.0, 6.0
HEAD_START_S = 60
KEY_RADIUS = 0.35
EXIT_RADIUS = 0.65
CATCH_RADIUS = 0.65
POSITION_STALE_S = 3.0
TICK_HZ = 10
MAX_KEYS = 12
CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

games = {}
members = {}
lock = threading.Lock()
ticker_started = False


def clamp(v, lo, hi):
    return min(max(v, lo), hi)


def make_code():
    while True:
        code = "".join(random.choice(CODE_CHARS) for _ in range(4))
        if code not in games:
            return code


def new_player(x, y):
    return {"sid": None, "x": x, "y": y, "heading": 0.0, "seen": 0.0}


def new_game():
    return {
        "room": {"w": ROOM_W, "h": ROOM_H},
        "running": False,
        "phase": "setup",  # setup, headstart, chase, escaped, caught, paused
        "phase_started": None,
        "countdown": HEAD_START_S,
        "escapee": new_player(ROOM_W / 2, ROOM_H / 2),
        "chaser": new_player(ROOM_W / 2, ROOM_H / 2),
        "keys": [],
        "exit": {"x": ROOM_W - 0.7, "y": ROOM_H - 0.7},
        "touched": time.monotonic(),
    }


def dist(a, b):
    return math.hypot(a["x"] - b["x"], a["y"] - b["y"])


def player_live(p, now):
    return bool(p["sid"] and now - p["seen"] < POSITION_STALE_S)


def snapshot(g, now):
    phase = g["phase"]
    remaining = g["countdown"]
    if phase == "headstart" and g["phase_started"] is not None:
        remaining = max(0, HEAD_START_S - (now - g["phase_started"]))
    e, c = g["escapee"], g["chaser"]
    keys_left = sum(not k["collected"] for k in g["keys"])
    return {
        "room": dict(g["room"]),
        "running": g["running"],
        "phase": phase,
        "countdown": int(math.ceil(remaining)),
        "escapee": { "x": round(e["x"], 3), "y": round(e["y"], 3), "heading": e["heading"], "live": player_live(e, now) },
        "chaser": { "x": round(c["x"], 3), "y": round(c["y"], 3), "heading": c["heading"], "live": player_live(c, now) },
        "keys": [{"x": k["x"], "y": k["y"], "collected": k["collected"]} for k in g["keys"]],
        "keysLeft": keys_left,
        "keyRadius": KEY_RADIUS,
        "exit": dict(g["exit"]),
        "escapeeDistance": round(dist(e, next((k for k in g["keys"] if not k["collected"]), g["exit"])), 2),
        "chaserDistance": round(dist(c, e), 2),
    }


def ticker():
    last = time.monotonic()
    while True:
        socketio.sleep(1 / TICK_HZ)
        now = time.monotonic()
        dt, last = now - last, now
        updates = []
        with lock:
            for code, g in list(games.items()):
                if any(c == code for c, _ in members.values()):
                    g["touched"] = now
                if g["phase"] == "headstart" and g["phase_started"] is not None:
                    if now - g["phase_started"] >= HEAD_START_S:
                        g["phase"] = "chase"
                        g["phase_started"] = now
                if g["phase"] == "chase":
                    e, c = g["escapee"], g["chaser"]
                    if player_live(e, now) and player_live(c, now) and dist(e, c) <= CATCH_RADIUS:
                        g["phase"] = "caught"
                        g["running"] = False
                    elif all(k["collected"] for k in g["keys"]) and dist(e, g["exit"]) <= EXIT_RADIUS:
                        g["phase"] = "escaped"
                        g["running"] = False
                elif g["phase"] == "headstart":
                    e = g["escapee"]
                    if all(k["collected"] for k in g["keys"]) and dist(e, g["exit"]) <= EXIT_RADIUS:
                        g["phase"] = "escaped"
                        g["running"] = False
                updates.append((code, snapshot(g, now)))
        for code, state in updates:
            socketio.emit("state", state, to=code)


def ensure_ticker():
    global ticker_started
    if ticker_started:
        return
    ticker_started = True
    socketio.start_background_task(ticker)


def leave_current(sid):
    old = members.pop(sid, None)
    if not old:
        return
    code, role = old
    g = games.get(code)
    if g and role in ("escapee", "chaser") and g[role]["sid"] == sid:
        g[role]["sid"] = None


@app.route("/")
def index():
    return serve("index.html")


@app.route("/<name>")
def static_file(name):
    if name not in ("style.css", "script.js"):
        return "Not found", 404
    return serve(name)


def serve(name):
    path = os.path.join(HERE, name)
    if not os.path.isfile(path):
        return f"{name} is missing. Put it next to app.py.", 404
    response = send_file(path, max_age=0)
    response.headers["Cache-Control"] = "no-store"
    return response


@socketio.on("connect")
def on_connect():
    ensure_ticker()


@socketio.on("tracker_open")
def tracker_open(data):
    sid = __import__("flask").request.sid
    data = data or {}
    code = str(data.get("code") or "").upper()
    with lock:
        leave_current(sid)
        if not (len(code) == 4 and all(ch in CODE_CHARS for ch in code)):
            code = make_code()
        if code not in games:
            games[code] = new_game()
        members[sid] = (code, "tracker")
    join_room(code)
    emit("opened", {"code": code})


@socketio.on("join")
def join_game(data):
    from flask import request
    sid = request.sid
    data = data or {}
    code = str(data.get("code") or "").upper()
    role = data.get("role")
    if role not in ("escapee", "chaser"):
        return
    with lock:
        g = games.get(code)
        if not g:
            emit("join_error", {"message": "No game found with that code."})
            return
        player = g[role]
        if player["sid"] and player["sid"] != sid and player_live(player, time.monotonic()):
            emit("join_error", {"message": f"A {role} phone is already connected."})
            return
        leave_current(sid)
        player["sid"] = sid
        player["seen"] = time.monotonic()
        members[sid] = (code, role)
        x, y = player["x"], player["y"]
    join_room(code)
    emit("joined", {"x": x, "y": y, "role": role})


@socketio.on("move")
def move_player(data):
    from flask import request
    sid = request.sid
    try:
        x, y = float(data["x"]), float(data["y"])
        heading = float(data.get("heading", 0))
        if not all(math.isfinite(v) for v in (x, y, heading)):
            return
    except (KeyError, TypeError, ValueError):
        return
    with lock:
        mem = members.get(sid)
        if not mem or mem[1] not in ("escapee", "chaser"):
            return
        code, role = mem
        g = games.get(code)
        if not g:
            return
        # The chaser is deliberately immobilised during the 60-second head start.
        if role == "chaser" and g["phase"] == "headstart":
            return
        p, r = g[role], g["room"]
        if p["sid"] != sid:
            return
        p["x"] = clamp(x, -0.5, r["w"] + 0.5)
        p["y"] = clamp(y, -0.5, r["h"] + 0.5)
        p["heading"] = heading
        p["seen"] = time.monotonic()
        if role == "escapee":
            for key in g["keys"]:
                if not key["collected"] and dist(p, key) <= KEY_RADIUS:
                    key["collected"] = True


@socketio.on("control")
def control(data):
    from flask import request
    sid = request.sid
    data = data or {}
    with lock:
        mem = members.get(sid)
        if not mem or mem[1] != "tracker":
            return
        g = games.get(mem[0])
        if not g:
            return
        action = data.get("action")
        r = g["room"]
        try:
            if action == "start":
                g["phase"] = "headstart"
                g["running"] = True
                g["phase_started"] = time.monotonic()
                g["countdown"] = HEAD_START_S
                for key in g["keys"]:
                    key["collected"] = False
            elif action == "pause":
                g["phase"] = "paused"
                g["running"] = False
                g["phase_started"] = None
            elif action == "reset":
                g["phase"] = "setup"
                g["running"] = False
                g["phase_started"] = None
                for key in g["keys"]:
                    key["collected"] = False
            elif action == "room":
                r["w"] = clamp(float(data["w"]), 2, 30)
                r["h"] = clamp(float(data["h"]), 2, 30)
            elif action == "add_key" and len(g["keys"]) < MAX_KEYS:
                x, y = float(data["x"]), float(data["y"])
                if math.isfinite(x) and math.isfinite(y):
                    g["keys"].append({"x": clamp(x, 0, r["w"]), "y": clamp(y, 0, r["h"]), "collected": False})
            elif action == "remove_key":
                i = int(data.get("i", len(g["keys"]) - 1))
                if 0 <= i < len(g["keys"]):
                    g["keys"].pop(i)
            elif action == "clear_keys":
                g["keys"] = []
            elif action == "place_exit":
                x, y = float(data["x"]), float(data["y"])
                if math.isfinite(x) and math.isfinite(y):
                    g["exit"] = {"x": clamp(x, 0, r["w"]), "y": clamp(y, 0, r["h"])}
            elif action == "place_player":
                role = data.get("role")
                if role in ("escapee", "chaser"):
                    x, y = float(data["x"]), float(data["y"])
                    if math.isfinite(x) and math.isfinite(y):
                        g[role]["x"] = clamp(x, 0, r["w"])
                        g[role]["y"] = clamp(y, 0, r["h"])
                        target_sid = g[role]["sid"]
                        if target_sid:
                            socketio.emit("set_pos", {"x": g[role]["x"], "y": g[role]["y"]}, to=target_sid)
        except (KeyError, TypeError, ValueError):
            return


@socketio.on("disconnect")
def disconnect():
    from flask import request
    with lock:
        leave_current(request.sid)


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    port = int(os.getenv("PORT", "1032"))
    https = os.getenv("USE_HTTPS", "1") == "1"
    url = f"{'https' if https else 'http'}://{lan_ip()}:{port}"
    print(f"\nEscape Room Game — open on all three devices: {url}\nRoom code appears on the laptop.")
    socketio.run(app, host="0.0.0.0", port=port, debug=True, use_reloader=False,
                 allow_unsafe_werkzeug=True, ssl_context="adhoc" if https else None)
