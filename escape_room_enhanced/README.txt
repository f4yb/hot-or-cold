MUSI3071 Escape Room — enhanced audio/tracking build

Files to put together in one folder:
  app.py
  index.html
  style.css
  script.js
  requirements.txt

Install/start on the laptop:
  pip install -r requirements.txt
  $env:USE_HTTPS="0"
  python app.py

In a second PowerShell window, start the Cloudflare Quick Tunnel:
  cloudflared tunnel --url http://localhost:1032

Keep both windows open during play. Open the trycloudflare.com URL on all devices.

Changes:
- Key collection radius reduced from 0.55 m to 0.35 m.
- Phone step distance can be adjusted on each phone (0.35–0.95 m per detected step).
- Compass readings are smoothed to reduce directional jitter.
- Original generated ominous minor-key background music and low drone during active play.
- Escapee hears directional piano notes that become higher and more frequent near the next key/exit.
- During the chase, both players hear directional footsteps that accelerate as the gap closes.

Tracking is still an estimate based on phone step detection and compass sensors. It can drift, especially indoors; the laptop map can be used to correct player positions.
