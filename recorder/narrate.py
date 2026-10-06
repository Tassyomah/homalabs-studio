#!/usr/bin/env python3
"""narrate recorder sidecar — screen + mic + cursor capture.

    narrate.py --list                 devices (JSON)
    narrate.py --check [--request]    permission state (JSON); --request triggers the macOS prompts
    narrate.py record --out DIR [--fps 60] [--screen N] [--mic N | --no-mic]

Protocol (one JSON object per line):
  stdout → {"event":"started"|"paused"|"resumed"|"stopped"|"finalizing"|"ready"|"error", ...}
  stdin  ← {"cmd":"pause"|"resume"|"stop"}      (a bare newline or Ctrl-C also stops)

Output folder: screen.mp4 (cursor hidden), mic.wav, events.json, cursors/*.png.
All times are host-clock seconds (CLOCK_UPTIME_RAW == CACurrentMediaTime == avfoundation pts).
Pauses are not cut from the media; they are recorded as `pauses` and the editor skips them.
"""
import argparse, hashlib, json, os, re, signal, subprocess, sys, threading, time
from datetime import datetime
import Quartz
from AppKit import NSScreen, NSCursor, NSEvent, NSBitmapImageRep, NSPNGFileType
try:
    import AVFoundation
except ImportError:   # optional: only used for the microphone permission state
    AVFoundation = None

FFMPEG = os.path.expanduser("~/bin/ffmpeg")
FFPROBE = os.path.expanduser("~/bin/ffprobe")
now = lambda: time.clock_gettime(time.CLOCK_UPTIME_RAW)
def emit(**kw): print(json.dumps(kw), flush=True)
def log(msg): print(msg, file=sys.stderr, flush=True)

# ---------------------------------------------------------------- devices / permissions
def list_devices():
    out = subprocess.run([FFMPEG, "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
                         capture_output=True, text=True).stderr
    vids, auds, section = {}, {}, None
    for line in out.splitlines():
        if "video devices" in line: section = vids; continue
        if "audio devices" in line: section = auds; continue
        m = re.search(r"\[(\d+)\] (.+)$", line)
        if m and section is not None: section[int(m.group(1))] = m.group(2).strip()
    return vids, auds

def devices_json():
    v, a = list_devices()
    screens = [{"index": i, "name": n} for i, n in sorted(v.items()) if n.startswith("Capture screen")]
    mics = [{"index": i, "name": n} for i, n in sorted(a.items())]
    displays = [{"ordinal": k, "id": int(sc.deviceDescription()["NSScreenNumber"]),
                 "width": int(sc.frame().size.width * sc.backingScaleFactor()),
                 "height": int(sc.frame().size.height * sc.backingScaleFactor()), "name": str(sc.localizedName())}
                for k, sc in enumerate(NSScreen.screens())]
    return {"screens": screens, "mics": mics, "displays": displays}

MIC_STATUS = {0: "notDetermined", 1: "restricted", 2: "denied", 3: "authorized"}
def check_permissions(request=False):
    screen = bool(Quartz.CGPreflightScreenCaptureAccess())
    if not screen and request:
        screen = bool(Quartz.CGRequestScreenCaptureAccess())
    if AVFoundation is None: return {"screen": screen, "mic": "unknown"}
    mic = MIC_STATUS.get(int(AVFoundation.AVCaptureDevice.authorizationStatusForMediaType_("soun")), "unknown")
    if mic == "notDetermined" and request:
        done = threading.Event(); result = {}
        AVFoundation.AVCaptureDevice.requestAccessForMediaType_completionHandler_("soun", lambda ok: (result.__setitem__("ok", ok), done.set()))
        done.wait(30)
        mic = "authorized" if result.get("ok") else MIC_STATUS.get(int(AVFoundation.AVCaptureDevice.authorizationStatusForMediaType_("soun")), "denied")
    return {"screen": screen, "mic": mic}

# ---------------------------------------------------------------- cursor log
class CursorLog:
    """Cursor position/buttons/shape by polling. No Accessibility permission needed."""
    def __init__(self, screen, scale, outdir, hz=120):
        self.f = screen.frame(); self.scale = scale; self.hz = hz
        self.moves, self.clicks, self.cursorChanges = [], [], []
        self.cursors = {}
        self.outdir = outdir; os.makedirs(os.path.join(outdir, "cursors"), exist_ok=True)
        self.last = None; self.buttons = [False, False]; self.cur_id = None
        self.stop = threading.Event()

    def to_px(self, p):
        return (round((p.x - self.f.origin.x) * self.scale, 2),
                round((self.f.origin.y + self.f.size.height - p.y) * self.scale, 2))

    def cursor_id(self):
        c = NSCursor.currentSystemCursor()
        if c is None: return self.cur_id
        img = c.image(); tiff = img.TIFFRepresentation()
        if tiff is None: return self.cur_id
        h = hashlib.sha1(bytes(tiff)).hexdigest()[:12]
        if h not in self.cursors:
            rep = NSBitmapImageRep.imageRepWithData_(tiff)
            png = rep.representationUsingType_properties_(NSPNGFileType, None)
            fn = f"cursors/{h}.png"; png.writeToFile_atomically_(os.path.join(self.outdir, fn), True)
            hs = c.hotSpot(); sz = img.size()
            self.cursors[h] = {"file": fn, "hotspot": [hs.x, hs.y], "size": [sz.width, sz.height]}
        return h

    def run(self):
        period = 1.0 / self.hz; n = 0
        while not self.stop.is_set():
            t = now(); x, y = self.to_px(NSEvent.mouseLocation())
            if self.last != (x, y):
                self.last = (x, y); self.moves.append([round(t, 4), x, y])
            for i, btn in enumerate((Quartz.kCGMouseButtonLeft, Quartz.kCGMouseButtonRight)):
                down = bool(Quartz.CGEventSourceButtonState(Quartz.kCGEventSourceStateCombinedSessionState, btn))
                if down != self.buttons[i]:
                    self.buttons[i] = down
                    self.clicks.append({"t": round(t, 4), "type": "down" if down else "up",
                                        "button": "left" if i == 0 else "right", "x": x, "y": y})
            if n % 6 == 0:
                cid = self.cursor_id()
                if cid != self.cur_id:
                    self.cur_id = cid; self.cursorChanges.append([round(t, 4), cid])
            n += 1
            time.sleep(max(0, period - (now() - t)))

# ---------------------------------------------------------------- helpers
def probe(path):
    out = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "stream=start_time,duration,nb_frames,codec_type",
                          "-of", "json", path], capture_output=True, text=True).stdout
    try: return json.loads(out)["streams"][0]
    except Exception: return {}

def drain(pipe, sink):
    """Read a pipe to the end on a thread so the child can never block on a full buffer."""
    def run():
        for line in pipe:
            sink(line.rstrip("\n"))
    th = threading.Thread(target=run, daemon=True); th.start(); return th

def kill(proc):
    if proc.poll() is None:
        proc.terminate()
        try: proc.wait(2)
        except subprocess.TimeoutExpired: proc.kill(); proc.wait()

# ---------------------------------------------------------------- record
def record(args):
    outdir = os.path.expanduser(args.out or f"~/Movies/Narrate/{datetime.now():%Y-%m-%d-%H-%M-%S}")
    os.makedirs(outdir, exist_ok=True)
    perms = check_permissions()
    if not perms["screen"]:
        emit(event="error", code="screen_permission", message="Screen Recording permission is not granted to this app."); sys.exit(3)
    if not args.no_mic and perms["mic"] not in ("authorized", "notDetermined", "unknown"):
        emit(event="error", code="mic_permission", message="Microphone permission is denied for this app."); sys.exit(3)

    dev = devices_json()
    screens = [s["index"] for s in dev["screens"]]
    if not screens: emit(event="error", code="no_screen", message="No capturable display found."); sys.exit(3)
    screen_idx = screens[args.screen] if args.screen < len(screens) else screens[0]
    mic_idx = None
    if not args.no_mic:
        mic_idx = args.mic if args.mic is not None else next((m["index"] for m in dev["mics"] if "Microphone" in m["name"] and "iPhone" not in m["name"]), dev["mics"][0]["index"] if dev["mics"] else None)
    scr = NSScreen.screens(); nsscreen = scr[args.screen] if args.screen < len(scr) else scr[0]
    f = nsscreen.frame(); scale = float(nsscreen.backingScaleFactor())
    disp = {"id": int(nsscreen.deviceDescription()["NSScreenNumber"]), "scale": scale, "pointWidth": f.size.width, "pointHeight": f.size.height,
            "width": int(round(f.size.width * scale)), "height": int(round(f.size.height * scale))}

    screen_path = os.path.join(outdir, "screen.mp4"); mic_path = os.path.join(outdir, "mic.mov")
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin" if False else "-y",
           "-f", "avfoundation", "-framerate", str(args.fps), "-pixel_format", "nv12", "-capture_cursor", "0", "-i", f"{screen_idx}:none"]
    if mic_idx is not None: cmd += ["-f", "avfoundation", "-i", f"none:{mic_idx}"]
    cmd += ["-copyts", "-map", "0:v", "-c:v", "h264_videotoolbox", "-b:v", f"{max(30, disp['width'] * disp['height'] * 8 // 1_000_000)}M",
            "-realtime", "1", screen_path]
    if mic_idx is not None: cmd += ["-map", "1:a", "-c:a", "pcm_s24le", "-ar", "48000", mic_path]

    ff = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    ff_err = []; drain(ff.stderr, lambda l: (ff_err.append(l), log("[ffmpeg] " + l)))
    t_launch = now()

    # Prove frames are flowing before we tell the app we're recording (a blocked device = permission problem).
    deadline = time.time() + 6
    while time.time() < deadline:
        if ff.poll() is not None: break
        if os.path.exists(screen_path) and os.path.getsize(screen_path) > 4096: break
        time.sleep(0.1)
    else:
        kill(ff); emit(event="error", code="no_frames", message="The screen capture produced no frames. Check Screen Recording permission for this app.\n" + "\n".join(ff_err[-5:])); sys.exit(4)
    if ff.poll() is not None:
        emit(event="error", code="ffmpeg_exit", message="Capture failed to start.\n" + "\n".join(ff_err[-8:])); sys.exit(4)

    cl = CursorLog(nsscreen, scale, outdir); th = threading.Thread(target=cl.run, daemon=True); th.start()
    pauses = []   # [[t_pause, t_resume|None]]
    emit(event="started", out=outdir, display=disp, tLaunch=t_launch)

    stopped = threading.Event()
    def do_stop(*_): stopped.set()
    def handle(cmd):
        if cmd == "pause" and not (pauses and pauses[-1][1] is None):
            pauses.append([round(now(), 4), None]); emit(event="paused", t=pauses[-1][0])
        elif cmd == "resume" and pauses and pauses[-1][1] is None:
            pauses[-1][1] = round(now(), 4); emit(event="resumed", t=pauses[-1][1])
        elif cmd == "stop": do_stop()
    def stdin_loop():
        for line in sys.stdin:
            line = line.strip()
            if not line: handle("stop"); continue
            try: handle(json.loads(line).get("cmd"))
            except Exception: handle("stop")
        do_stop()   # stdin closed → the app died → stop cleanly
    threading.Thread(target=stdin_loop, daemon=True).start()
    signal.signal(signal.SIGINT, do_stop); signal.signal(signal.SIGTERM, do_stop)

    while not stopped.is_set():
        if ff.poll() is not None:
            emit(event="error", code="ffmpeg_died", message="Capture stopped unexpectedly.\n" + "\n".join(ff_err[-8:])); stopped.set()
        stopped.wait(0.05)
    t_end = now()
    if pauses and pauses[-1][1] is None: pauses[-1][1] = round(t_end, 4)
    cl.stop.set(); th.join(timeout=1)
    try: ff.stdin.write("q"); ff.stdin.flush()
    except Exception: pass
    try: ff.wait(timeout=10)
    except subprocess.TimeoutExpired: kill(ff)
    emit(event="stopped", out=outdir, duration=round(t_end - t_launch, 2))

    # ---- finalize (the app shows progress; media become zero-based so Chromium can play them)
    emit(event="finalizing", step="video")
    vid = probe(screen_path)
    tmp = screen_path + ".tmp.mp4"
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", screen_path, "-c", "copy", "-movflags", "+faststart", tmp])
    if os.path.exists(tmp) and os.path.getsize(tmp) > 0: os.replace(tmp, screen_path)
    mic = {}
    if mic_idx is not None and os.path.exists(mic_path):
        emit(event="finalizing", step="audio")
        mic = probe(mic_path)
        subprocess.run([FFMPEG, "-v", "error", "-y", "-i", mic_path, "-c:a", "pcm_s16le", "-ar", "48000", os.path.join(outdir, "mic.wav")])
        os.remove(mic_path)
    t0v = float(vid.get("start_time", 0) or 0)
    events = {"version": 2, "display": disp, "fps": args.fps, "tLaunch": t_launch, "tEnd": t_end,
              "t0Video": t0v, "t0Mic": float(mic["start_time"]) if mic else None,
              "videoDuration": float(vid.get("duration", 0) or 0), "videoFrames": int(vid.get("nb_frames", 0) or 0),
              "micOffset": (float(mic["start_time"]) - t0v) if mic else None,
              "pauses": pauses,
              "cursors": cl.cursors, "cursorChanges": cl.cursorChanges, "moves": cl.moves, "clicks": cl.clicks, "scrolls": [],
              "files": {"screen": "screen.mp4", "mic": "mic.wav" if mic else None}}
    with open(os.path.join(outdir, "events.json"), "w") as fh: json.dump(events, fh)
    emit(event="ready", out=outdir, frames=events["videoFrames"], duration=events["videoDuration"], clicks=len(cl.clicks) // 2)

def main():
    ap = argparse.ArgumentParser(prog="narrate")
    ap.add_argument("cmd", nargs="?", default="record")
    ap.add_argument("--out"); ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--screen", type=int, default=0); ap.add_argument("--mic", type=int); ap.add_argument("--no-mic", action="store_true")
    ap.add_argument("--list", action="store_true"); ap.add_argument("--check", action="store_true"); ap.add_argument("--request", action="store_true")
    args = ap.parse_args()
    if args.list: print(json.dumps(devices_json())); return
    if args.check: print(json.dumps(check_permissions(args.request))); return
    record(args)

if __name__ == "__main__": main()
