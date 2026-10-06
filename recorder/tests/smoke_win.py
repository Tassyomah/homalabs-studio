"""Smoke test for recorder/narrate_win.py: drive it through the stdin/stdout protocol for ~5 s,
move the mouse a little (position is restored), pause/resume once, stop, then validate the output.

    python recorder/tests/smoke_win.py [OUT_DIR]

It records the primary display, so run it only on a machine where that is fine.
Exit code 0 means every check passed. Nothing is written outside OUT_DIR (default: %TEMP%/narrate-smoke).
"""
import ctypes, ctypes.wintypes as wt, json, os, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
REC = os.path.join(HERE, "..", "narrate_win.py")
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "narrate-smoke")
if os.path.exists(OUT): shutil.rmtree(OUT)

p = subprocess.Popen([sys.executable, REC, "record", "--out", OUT, "--fps", "60"],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
events = []
def read_until(kind, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        line = p.stdout.readline()
        if not line: break
        ev = json.loads(line); events.append(ev); print("<-", json.dumps(ev)[:160], flush=True)
        if ev["event"] in (kind, "error"): return ev
    return None
def send(cmd): p.stdin.write(json.dumps({"cmd": cmd}) + "\n"); p.stdin.flush()

ev = read_until("started"); assert ev and ev["event"] == "started", ev
u = ctypes.windll.user32; pt = wt.POINT(); u.GetCursorPos(ctypes.byref(pt)); x0, y0 = pt.x, pt.y
for i in range(60):
    u.SetCursorPos(x0 + (i % 20) * 3, y0 + (i % 10) * 2); time.sleep(0.03)
u.SetCursorPos(x0, y0)
time.sleep(1.0); send("pause"); assert read_until("paused")["event"] == "paused"
time.sleep(1.0); send("resume"); assert read_until("resumed")["event"] == "resumed"
time.sleep(1.5); send("stop")
ev = read_until("ready", timeout=90)
err = p.stderr.read(); p.wait()
print("--- recorder stderr ---"); print(err.strip()[-2000:])
assert ev and ev["event"] == "ready", ev

e = json.load(open(os.path.join(OUT, "events.json")))
print("--- events.json ---")
print(json.dumps({k: e[k] for k in ("display", "fps", "t0Video", "t0Mic", "videoDuration", "videoFrames", "micOffset", "pauses", "encoder", "files")}, indent=1))
print("moves:", len(e["moves"]), "clicks:", len(e["clicks"]), "cursorChanges:", e["cursorChanges"][:3])
print("cursors:", json.dumps(e["cursors"]))
print("files:", {f: os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT) if os.path.isfile(os.path.join(OUT, f))})

t0, dur = e["t0Video"], e["videoDuration"]
assert dur > 3.5, f"video too short: {dur}"
assert e["videoFrames"] > 150, f"too few frames: {e['videoFrames']}"
assert len(e["moves"]) > 20, "cursor log is empty"
assert e["cursors"], "no cursor shape captured"
inside = [m for m in e["moves"] if t0 - 0.2 <= m[0] <= t0 + dur + 0.2]
print(f"moves inside video range: {len(inside)}/{len(e['moves'])}; first move at +{e['moves'][0][0] - t0:.3f}s; "
      f"video started {t0 - e['tLaunch']:.3f}s after ffmpeg launch")
assert len(inside) == len(e["moves"]), "cursor samples fall outside the video's time range (clock mismatch)"
assert len(e["pauses"]) == 1 and 0.8 < e["pauses"][0][1] - e["pauses"][0][0] < 1.6, e["pauses"]
if e["files"]["mic"]:
    assert os.path.getsize(os.path.join(OUT, "mic.wav")) > 100_000, "mic.wav is empty"
    assert abs(e["micOffset"]) < 1.0, f"mic offset implausible: {e['micOffset']}"
for c in e["cursors"].values(): assert os.path.exists(os.path.join(OUT, c["file"]))
print("OK")
