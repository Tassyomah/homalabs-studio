"""Crash test for recorder/narrate_win.py: start a recording, kill the recorder process outright, check that its
ffmpeg children die with it (job object), then run `finalize` and check the recovered events.json.

    python recorder/tests/crash_win.py

Records the primary display for ~3 s into %TEMP%/narrate-crash (removed on success). Exit code 0 = all checks passed.
"""
import json, os, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
REC = os.path.join(HERE, "..", "narrate_win.py")
OUT = os.path.join(tempfile.gettempdir(), "narrate-crash")
if os.path.exists(OUT): shutil.rmtree(OUT)

def ffmpegs():
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq ffmpeg.exe", "/NH"], capture_output=True, text=True).stdout
    return [l for l in out.splitlines() if "ffmpeg.exe" in l]

p = subprocess.Popen([sys.executable, REC, "record", "--out", OUT, "--fps", "60"],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
ev = json.loads(p.stdout.readline()); assert ev["event"] == "started", ev
time.sleep(1.0); p.stdin.write('{"cmd":"pause"}\n'); p.stdin.flush(); p.stdout.readline()
time.sleep(0.8); p.stdin.write('{"cmd":"resume"}\n'); p.stdin.flush(); p.stdout.readline()
time.sleep(1.2)
running = len(ffmpegs()); print("ffmpeg processes while recording:", running)
assert running >= 1
p.kill(); p.wait(); time.sleep(2)
left = ffmpegs(); print("ffmpeg processes 2 s after killing the recorder:", len(left))
assert not left, "orphan ffmpeg survived the recorder"

print("files after crash:", sorted(os.listdir(OUT)))
assert os.path.exists(os.path.join(OUT, "recording.json")) and not os.path.exists(os.path.join(OUT, "events.json"))
r = subprocess.run([sys.executable, REC, "finalize", "--out", OUT], capture_output=True, text=True)
print(r.stdout.strip())
assert '"ready"' in r.stdout, r.stderr[-500:]
e = json.load(open(os.path.join(OUT, "events.json")))
print("recovered:", e["recovered"], "dur", e["videoDuration"], "frames", e["videoFrames"], "moves", len(e["moves"]),
      "pauses", len(e["pauses"]), "mic", e["files"]["mic"], "micOffset", e["micOffset"])
assert e["recovered"] and e["videoDuration"] > 2 and len(e["pauses"]) == 1 and e["cursors"]
assert all(e["t0Video"] - 0.5 <= m[0] <= e["t0Video"] + e["videoDuration"] + 0.5 for m in e["moves"]), "clock mismatch"
print("files after recovery:", sorted(os.listdir(OUT)))
shutil.rmtree(OUT)
print("OK")
