"""
Hot or Cold Engine V5 - server (MUSI3071, The Digital Score)

Files (all in one folder): app.py, index.html, style.css, script.js, requirements.txt

Run:   pip install -r requirements.txt
       python app.py
Open:  the https://<this-computer's-ip>:<port> address printed below, on every device
       (same wifi, accept the self-signed certificate warning once per device).

Two game modes, chosen on the laptop:
  hotcold   one hider (placed by the hider phone or the laptop). Found = game over.
  hunt      scavenger hunt: the laptop places up to 12 targets on the map (no hider
            phones needed). The music always points at one target at a time; walk onto
            it, it's collected, and the music moves on to the next. All collected = found.

Roles (all chosen on the home page, all share one room code):
  laptop (tracker)  creates the room, picks the mode, starts/pauses rounds, watches the
                    live map, drags dots to correct drift, places the hider / targets.
  seeker            headphones phone. Counts steps (accelerometer) and reads the
                    compass, so it works out its own position and streams it here.
                    All music is synthesised on this phone (Tone.js).
  hider             optional phone, hot or cold mode only. Taps the map where they hide.

The server is the single source of truth: it holds the positions, works out the
distance, in/out of bounds and "found", and broadcasts one state message per room
10 times a second.
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
FOUND_HOLD_S = 1.5                    # ...for this long = hider / target found
BOUNDS_MARGIN = 0.15                  # slack past a wall before "out of bounds"
CLAMP_MARGIN = 1.0                    # positions can't drift further than this past a wall
SEEKER_STALE_S = 2.5                  # no position from the seeker phone this long = lost
TICK_HZ = 10                          # state broadcasts per second
GAME_IDLE_S = 3 * 3600                # forget empty rooms after this long
FAR_D = 8.0                           # distance reported when it can't be measured yet

# Scavenger hunt
MAX_TARGETS = 12
SWITCH_HYST = 0.5                     # "nearest first": another target must be this much closer to take over
SCATTER_GAP = 1.2                     # scattered targets are at least this far apart...
SCATTER_START_GAP = 1.5               # ...and this far from the start spot (room centre)
SCATTER_WALL = 0.5                    # ...and this far in from the walls

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
        "mode": "hotcold",                     # "hotcold" | "hunt"
        "order": "nearest",                    # hunt: "nearest" (any order) | "numbered" (1, 2, 3...)
        "running": False,
        "found": False,                        # hot or cold: hider found. hunt: every target collected
        "held": 0.0,                           # seconds the seeker has been within FOUND_RADIUS
        "seeker": None,                        # {sid, x, y, heading, seen}
        "hider": {"sid": None, "x": None, "y": None},
        "targets": [],                         # hunt: [{x, y, found}]
        "active": None,                        # hunt: index of the target the music points at
        "touched": time.monotonic(),
    }


# ---- Measurement -------------------------------------------------------------
def _dist(s, t):
    return math.hypot(s["x"] - t["x"], s["y"] - t["y"])


def pick_target(g):
    """Which target the music points at. Returns (index, {x, y}) or (None, None).
    Hot or cold: the hider. Hunt: the next uncollected target (nearest, or lowest number)."""
    if g["mode"] == "hotcold":
        h = g["hider"]
        return (0, h) if h["x"] is not None else (None, None)
    left = [i for i, t in enumerate(g["targets"]) if not t["found"]]
    if not left:
        g["active"] = None
        return None, None
    s = g["seeker"]
    if g["order"] == "numbered" or not s:
        best = left[0]
    else:
        best = min(left, key=lambda i: _dist(s, g["targets"][i]))
        prev = g["active"]
        # stick with the current target unless another is clearly closer, so the beacon doesn't flip-flop
        if prev in left and _dist(s, g["targets"][prev]) < _dist(s, g["targets"][best]) + SWITCH_HYST:
            best = prev
    g["active"] = best
    return best, g["targets"][best]


def measure(g, now):
    """Returns (distance, in_bounds, tracking_ok, target_index, target)."""
    s, r = g["seeker"], g["room"]
    s_live = bool(s and s["sid"] and now - s["seen"] < SEEKER_STALE_S)
    ti, tgt = pick_target(g)
    all_done = g["mode"] == "hunt" and g["found"]

    d = FAR_D
    if s and tgt is not None:
        d = _dist(s, tgt)
    elif all_done:
        d = 0.0

    m = BOUNDS_MARGIN
    inside = bool(s) and (-m <= s["x"] <= r["w"] + m) and (-m <= s["y"] <= r["h"] + m)
    in_bounds = s_live and inside          # can't hear from the seeker = treat as out of bounds
    trk = s_live and (tgt is not None or all_done)
    return d, in_bounds, trk, ti, tgt


def collect(g, ti):
    """The seeker reached target ti (hot or cold: the hider)."""
    g["held"] = 0.0
    if g["mode"] == "hotcold":
        g["found"] = True
        return
    if ti is None or ti >= len(g["targets"]):
        return
    g["targets"][ti]["found"] = True
    g["active"] = None
    if all(t["found"] for t in g["targets"]):
        g["found"] = True


def snapshot(g, now, d, in_bounds, trk, ti, tgt):
    s, h = g["seeker"], g["hider"]
    return {
        "mode": g["mode"],
        "order": g["order"],
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
        "hider": None if h["x"] is None else {"x": round(h["x"], 3), "y": round(h["y"], 3)},
        # where the music is pointing right now (the hider, or the active hunt target)
        "active": ti,
        "target": None if tgt is None else {"x": round(tgt["x"], 3), "y": round(tgt["y"], 3)},
        "targets": [{"x": round(t["x"], 3), "y": round(t["y"], 3), "found": t["found"]} for t in g["targets"]],
        "foundCount": sum(1 for t in g["targets"] if t["found"]),
        "total": len(g["targets"]),
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
                d, inb, trk, ti, tgt = measure(g, now)
                if g["running"] and not g["found"] and trk and inb and tgt is not None and d < FOUND_RADIUS:
                    g["held"] += dt
                    if g["held"] >= FOUND_HOLD_S:
                        collect(g, ti)
                        d, inb, trk, ti, tgt = measure(g, now)   # music moves straight on to the next target
                else:
                    g["held"] = 0.0
                out.append((code, snapshot(g, now, d, inb, trk, ti, tgt)))
        for code, snap in out:
            socketio.emit("state", snap, to=code)


def ensure_ticker():
    global _ticker_started
    with lock:
        if _ticker_started:
            return
        _ticker_started = True
    socketio.start_background_task(ticker)


def scatter(g, n):
    """Places n targets at random, spread out and away from the start spot."""
    r, w = g["room"], SCATTER_WALL
    cx, cy = r["w"] / 2, r["h"] / 2
    pts = []
    for _ in range(4000):
        if len(pts) >= n:
            break
        x, y = random.uniform(w, r["w"] - w), random.uniform(w, r["h"] - w)
        if math.hypot(x - cx, y - cy) < SCATTER_START_GAP:
            continue
        if any(math.hypot(x - p["x"], y - p["y"]) < SCATTER_GAP for p in pts):
            continue
        pts.append({"x": x, "y": y, "found": False})
    g["targets"] = pts                     # a small room may fit fewer than asked for


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
        elif role == "hider" and g["mode"] == "hotcold":
            g["hider"]["x"] = clamp(x, 0, r["w"])
            g["hider"]["y"] = clamp(y, 0, r["h"])


def _xy(data, r):
    x, y = float(data["x"]), float(data["y"])
    if not (math.isfinite(x) and math.isfinite(y)):
        raise ValueError
    return clamp(x, 0, r["w"]), clamp(y, 0, r["h"])


@socketio.on("control")
def on_control(data):
    """Laptop-only commands. Both modes: start, pause, found, room, place, mode.
    Hunt: order, add_target, move_target, remove_target, clear_targets, scatter."""
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
        T = g["targets"]
        try:
            if a == "start":
                g.update(running=True, found=False, held=0.0, active=None)
                for t in T:
                    t["found"] = False
            elif a == "pause":
                g["running"] = False
            elif a == "found":
                if g["mode"] == "hotcold":
                    g["found"] = True
                else:                                   # hunt: collect the target the music is pointing at
                    ti, _ = pick_target(g)
                    collect(g, ti)
            elif a == "mode":
                m = data.get("mode")
                if m in ("hotcold", "hunt") and m != g["mode"]:
                    g.update(mode=m, running=False, found=False, held=0.0, active=None)
                    for t in T:
                        t["found"] = False
            elif a == "order":
                if data.get("order") in ("nearest", "numbered"):
                    g.update(order=data["order"], active=None)
            elif a == "room":
                r["w"] = clamp(float(data["w"]), 2.0, 30.0)
                r["h"] = clamp(float(data["h"]), 2.0, 30.0)
                h = g["hider"]
                if h["x"] is not None:
                    h["x"], h["y"] = clamp(h["x"], 0, r["w"]), clamp(h["y"], 0, r["h"])
                for t in T:
                    t["x"], t["y"] = clamp(t["x"], 0, r["w"]), clamp(t["y"], 0, r["h"])
            elif a == "add_target":
                if len(T) < MAX_TARGETS:
                    x, y = _xy(data, r)
                    T.append({"x": x, "y": y, "found": False})
                    g["found"] = False                  # a new target means the hunt isn't over
            elif a == "move_target":
                i = int(data["i"])
                if 0 <= i < len(T):
                    T[i]["x"], T[i]["y"] = _xy(data, r)
            elif a == "remove_target":
                i = data.get("i")
                i = len(T) - 1 if i in (None, "last") else int(i)
                if 0 <= i < len(T):
                    T.pop(i)
                    g["active"] = None
                    if g["mode"] == "hunt" and g["running"] and T and all(t["found"] for t in T):
                        g["found"] = True
            elif a == "clear_targets":
                g.update(targets=[], active=None, found=False if g["mode"] == "hunt" else g["found"])
            elif a == "scatter":
                scatter(g, int(clamp(int(data.get("n", 5)), 1, MAX_TARGETS)))
                g["active"] = None
                if g["mode"] == "hunt":
                    g["found"] = False
            elif a == "place":
                who = data.get("who")
                if who == "hider":
                    h = g["hider"]
                    h["x"], h["y"] = _xy(data, r)
                    if h["sid"]:
                        tell = (h["sid"], h["x"], h["y"])
                elif who == "seeker" and g["seeker"]:
                    x, y = float(data["x"]), float(data["y"])
                    if not (math.isfinite(x) and math.isfinite(y)):
                        raise ValueError
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
    print("  Hot or Cold Engine V5 (MUSI3071)")
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
    port = int(os.getenv("PORT", "1032"))
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
