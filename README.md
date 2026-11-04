Steps to run it
  
 - Install Python 3 and cloudflared, and put app.py, index.html and requirements.txt in one folder.
  
 - Install the requirements: pip install -r requirements.txt.
  
  - Start the server in plain HTTP mode (terminal 1):
  
  - Windows Command Prompt: set "USE_HTTPS=0" && python app.py
 
  - Windows PowerShell: $env:USE_HTTPS="0"; python app.py
  
  - Mac or Linux: USE_HTTPS=0 python app.py
 
  - Start the tunnel (terminal 2): cloudflared tunnel --url http://localhost:5000.
 
  - Copy the trycloudflare.com link it prints and open it on every device. It changes each time you restart the tunnel.
  
Steps to test it

Laptop test (no phones needed)

- Open three separate browser windows on the link: Spectator, Hider, and Seeker. Wear headphones for the Seeker window.
- Keep the Seeker window visible, because background tabs slow down and cause audio gaps.
- In the Hider window, tap the map to place the hider in a far corner.
- Distance test: walk the seeker towards the hider with the arrow keys. You should hear the drone alone, then C3, then C3 and E3, then an arpeggio, then a richer chord, getting louder as you go.
- Tempo test: tick Run and hold a direction. The beat should speed towards 120 BPM. Let go and it should ease back towards 60.
- Panning test: with the hider to the east, face north. The sound should come from the right. Put the hider to the west and it should come from the left.
- Boundary test: walk into a wall. You should hear a harsh pulsing sound from that side, then a sub-bass drop at the very edge.
- Found test: get within 0.6 m. A bell arpeggio should play, the hider should go silent, and its dot should fade on the Spectator map.
- Reset test: click Reset round on the Spectator window. The hider should become active again.
- Counterpoint test: open a second Hider window. The new hider should sound as a violin, and the two instruments should interlock.

Phone test

- The hiders open the link and tap the map where they are hiding.
- The seeker opens the link, taps Seeker, taps Enable walking sensors, allows motion access, stands in the room centre facing the top wall, and taps Set start.
- Step check: walk 10 real steps and compare with the step count on screen. If it’s off, change STEP_THRESH in index.html.
- Distance check: walk 5 m and compare with the on-screen position. If it’s off, change STEP_LEN.
- Compass check: turn 90 degrees and confirm the sound moves from one ear to the other.
- Drift check: walk a loop back to the start and see how far the position has strayed.
