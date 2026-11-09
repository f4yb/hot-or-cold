"""
Hot or Cold Engine - server (MUSI3071, The Digital Score)

Files (all in one folder): app.py, index.html, style.css, script.js, requirements.txt

Run:   pip install -r requirements.txt
       python app.py
Open:  the https://<this-computer's-ip>:<port> address printed below, on every device
       (same wifi, accept the self-signed certificate warning once per device).

Roles (all chosen on the home page, all share one room code):
  laptop (tracker)  creates the room, starts/pauses rounds, watches the live map,
                    drags dots to correct drift or to place the hider.
  seeker            headphones phone. Counts steps (accelerometer) and reads the
                    compass, so it works out its own position and streams it here.
                    All music is synthesised on this phone (Tone.js).
  hider             optional phone. Taps the map where they are hiding.

The server is the single source of truth: it holds the positions, works out the
distance, in/out of bounds and the auto "found", and broadcasts one state message
per room 10 times a second.
"""
import math
import os
import random
import threading
import time

from flask import Flask, request, send_file
from flask_socketio import SocketIO, emit, join_room, leave_room

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- Tunable game parameters -------------------------------------------------
ROOM_DEFAULT = {"w": 6.0, "h": 6.0}   # metres; the tracker can change it per room
FOUND_RADIUS = 0.5                    # metres: seeker this close...
FOUND_HOLD_S = 1.5                    # ...for this long = hider found
BOUNDS_MARGIN = 0.15                  # slack past a wall before "out of bounds"
CLAMP_MARGIN = 1.0                    # positions can't drift further than this past a wall
SEEKER_STALE_S = 2.5                  # no position from the seeker phone this long = lost
TICK_HZ = 10                          # state broadcasts per second
GAME_IDLE_S = 3 * 3600                # forget empty rooms after this long
FAR_D = 8.0                           # distance reported when it can't be measured yet

CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

games = {}     # code -> game dict
members = {}   # sid  -> (code, role)
lock = threading.Lock()
_ticker_started = False


def clamp(v, a, b):
    return min(max(v, a), b)


def make_code():
    while True:
        c = "".join(random.choice(CODE_CHARS) for _ in range(4))
        if c not in games:
            return c


def valid_code(c):
    return isinstance(c, str) and len(c) == 4 and all(ch in CODE_CHARS for ch in c)


def new_game():
    return {
        "room": dict(ROOM_DEFAULT),
        "running": False,
        "found": False,
        "held": 0.0,                           # seconds the seeker has been within FOUND_RADIUS
        "seeker": None,                        # {sid, x, y, heading, seen}
        "hider": {"sid": None, "x": None, "y": None},
        "touched": time.monotonic(),
    }


# ---- Measurement -------------------------------------------------------------
def measure(g, now):
    """Returns (distance, in_bounds, tracking_ok)."""
    s, h, r = g["seeker"], g["hider"], g["room"]
    s_live = bool(s and s["sid"] and now - s["seen"] < SEEKER_STALE_S)
    h_set = h["x"] is not None

    d = FAR_D
    if s and h_set:
        d = math.hypot(s["x"] - h["x"], s["y"] - h["y"])

    m = BOUNDS_MARGIN
    inside = bool(s) and (-m <= s["x"] <= r["w"] + m) and (-m <= s["y"] <= r["h"] + m)
    in_bounds = s_live and inside          # can't hear from the seeker = treat as out of bounds
    return d, in_bounds, (s_live and h_set)


def snapshot(g, now, d, in_bounds, trk):
    s, h = g["seeker"], g["hider"]
    return {
        "room": g["room"],
        "running": g["running"],
        "found": g["found"],
        "d": round(d, 2),
        "inBounds": in_bounds,
        "trk": trk,
        "seeker": None if not s else {
            "x": round(s["x"], 3), "y": round(s["y"], 3), "heading": round(s["heading"], 3),
            "live": bool(s["sid"] and now - s["seen"] < SEEKER_STALE_S),
        },
        "hider": None if h["x"] is None else {
            "x": round(h["x"], 3), "y": round(h["y"], 3),
        },
    }


def room_has_members(code):
    return any(c == code for c, _ in members.values())


def ticker():
    last = time.monotonic()
    while True:
        socketio.sleep(1.0 / TICK_HZ)
        now = time.monotonic()
        dt, last = now - last, now
        out = []
        with lock:
            for code, g in list(games.items()):
                if room_has_members(code):
                    g["touched"] = now
                elif now - g["touched"] > GAME_IDLE_S:
                    del games[code]
                    continue
                d, inb, trk = measure(g, now)
                if g["running"] and not g["found"] and trk and inb and d < FOUND_RADIUS:
                    g["held"] += dt
                    if g["held"] >= FOUND_HOLD_S:
                        g["found"] = True
                else:
                    g["held"] = 0.0
                out.append((code, snapshot(g, now, d, inb, trk)))
        for code, snap in out:
            socketio.emit("state", snap, to=code)


def ensure_ticker():
    global _ticker_started
    with lock:
        if _ticker_started:
            return
        _ticker_started = True
    socketio.start_background_task(ticker)


# ---- HTTP ---------------------------------------------------------------------
# The page is split into three files that must sit next to this one:
#   index.html (layout), style.css (look), script.js (everything that happens)
STATIC_FILES = ("style.css", "script.js")


def _find(name):
    """Finds a file next to app.py, ignoring upper/lower case (so Index.html works too)."""
    for f in os.listdir(HERE):
        if f.lower() == name.lower():
            return os.path.join(HERE, f)
    return None


def _serve(name):
    path = _find(name)
    if not path:
        return f"{name} is missing. Put it in the same folder as app.py.", 404
    resp = send_file(path, max_age=0)
    resp.headers["Cache-Control"] = "no-store"     # always send the latest version while we're editing
    return resp


@app.route("/")
def index():
    return _serve("index.html")


@app.route("/<name>")
def static_file(name):
    if name.lower() not in STATIC_FILES:           # only these files, never app.py etc.
        return "Not found", 404
    return _serve(name)


# ---- Socket events ------------------------------------------------------------
def _leave_current(sid):
    old = members.pop(sid, None)
    if not old:
        return
    code, role = old
    leave_room(code)
    g = games.get(code)
    if not g:
        return
    if role == "seeker" and g["seeker"] and g["seeker"]["sid"] == sid:
        g["seeker"]["sid"] = None          # keep the last position so a refresh resumes
    if role == "hider" and g["hider"]["sid"] == sid:
        g["hider"]["sid"] = None           # hider stays where they were


@socketio.on("connect")
def on_connect(*_):
    ensure_ticker()


@socketio.on("tracker_open")
def on_tracker_open(data):
    data = data or {}
    sid = request.sid
    code = str(data.get("code") or "").upper()
    with lock:
        _leave_current(sid)
        if data.get("fresh") or not valid_code(code):
            code = make_code()
        if code not in games:
            games[code] = new_game()
        members[sid] = (code, "tracker")
    join_room(code)
    emit("opened", {"code": code})


@socketio.on("join")
def on_join(data):
    data = data or {}
    sid = request.sid
    code = str(data.get("code") or "").upper()
    role = data.get("role")
    if role not in ("seeker", "hider"):
        return
    now = time.monotonic()
    with lock:
        g = games.get(code)
        if not g:
            emit("join_error", {"message": f"No game with code {code}. Check the laptop's screen."})
            return
        _leave_current(sid)
        r = g["room"]
        if role == "seeker":
            s = g["seeker"]
            if s and s["sid"] and s["sid"] != sid and now - s["seen"] < SEEKER_STALE_S:
                emit("join_error", {"message": "A seeker is already connected to this game."})
                return
            if s:                                       # reconnect: carry on from the last position
                s.update(sid=sid, seen=now)
            else:
                g["seeker"] = s = {"sid": sid, "x": r["w"] / 2, "y": r["h"] / 2, "heading": 0.0, "seen": now}
            x, y = s["x"], s["y"]
        else:
            g["hider"]["sid"] = sid                     # last hider phone to join takes over
            x, y = g["hider"]["x"], g["hider"]["y"]
        members[sid] = (code, role)
    join_room(code)
    emit("joined", {"x": x, "y": y})


@socketio.on("move")
def on_move(data):
    sid = request.sid
    try:
        x = float(data["x"])
        y = float(data["y"])
    except (KeyError, TypeError, ValueError):
        return
    if not (math.isfinite(x) and math.isfinite(y)):
        return
    with lock:
        mem = members.get(sid)
        if not mem:
            return
        code, role = mem
        g = games.get(code)
        if not g:
            return
        r = g["room"]
        if role == "seeker":
            s = g["seeker"]
            if not s or s["sid"] != sid:
                return
            m = CLAMP_MARGIN
            s["x"], s["y"] = clamp(x, -m, r["w"] + m), clamp(y, -m, r["h"] + m)
            s["seen"] = time.monotonic()
            try:
                s["heading"] = float(data.get("heading", s["heading"]))
            except (TypeError, ValueError):
                pass
        elif role == "hider":
            g["hider"]["x"] = clamp(x, 0, r["w"])
            g["hider"]["y"] = clamp(y, 0, r["h"])


@socketio.on("control")
def on_control(data):
    """Laptop-only commands: start, pause, found, room, place."""
    data = data or {}
    sid = request.sid
    tell = None   # (sid, x, y): a phone whose position the tracker just corrected
    with lock:
        mem = members.get(sid)
        if not mem or mem[1] != "tracker":
            return
        g = games.get(mem[0])
        if not g:
            return
        a = data.get("action")
        r = g["room"]
        try:
            if a == "start":
                g.update(running=True, found=False, held=0.0)
            elif a == "pause":
                g["running"] = False
            elif a == "found":
                g["found"] = True
            elif a == "room":
                r["w"] = clamp(float(data["w"]), 2.0, 30.0)
                r["h"] = clamp(float(data["h"]), 2.0, 30.0)
                h = g["hider"]
                if h["x"] is not None:
                    h["x"], h["y"] = clamp(h["x"], 0, r["w"]), clamp(h["y"], 0, r["h"])
            elif a == "place":
                who, x, y = data.get("who"), float(data["x"]), float(data["y"])
                if who == "hider":
                    h = g["hider"]
                    h["x"], h["y"] = clamp(x, 0, r["w"]), clamp(y, 0, r["h"])
                    if h["sid"]:
                        tell = (h["sid"], h["x"], h["y"])
                elif who == "seeker" and g["seeker"]:
                    s, m = g["seeker"], CLAMP_MARGIN
                    s["x"], s["y"] = clamp(x, -m, r["w"] + m), clamp(y, -m, r["h"] + m)
                    if s["sid"]:
                        tell = (s["sid"], s["x"], s["y"])
        except (KeyError, TypeError, ValueError):
            return
    if tell:
        socketio.emit("set_pos", {"x": tell[1], "y": tell[2]}, to=tell[0])


@socketio.on("disconnect")
def on_disconnect(*_):
    with lock:
        _leave_current(request.sid)


# ---- Startup -------------------------------------------------------------------
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


def print_banner(url):
    print("\n" + "=" * 60)
    print("  Hot or Cold Engine (MUSI3071)")
    print("  Open on every device (same wifi):  " + url)
    print("=" * 60)
    try:
        import qrcode
        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.print_ascii(invert=True)
    except Exception:
        pass


if __name__ == "__main__":
    port = int(os.getenv("PORT", "1031"))
    use_https = os.getenv("USE_HTTPS", "1") == "1"
    if use_https:
        # Phones only allow motion/compass sensors on https pages, so this is the default.
        print_banner(f"https://{lan_ip()}:{port}")
        socketio.run(app, host="0.0.0.0", port=port, debug=True, use_reloader=False, allow_unsafe_werkzeug=True,
                     ssl_context="adhoc")
    else:
        # e.g. behind a Cloudflare Tunnel, which provides the https itself
        print(f"\n[INFO] Starting plain HTTP server on port {port} (put an https tunnel in front)")
        socketio.run(app, host="0.0.0.0", port=port, debug=True, use_reloader=False, allow_unsafe_werkzeug=True)