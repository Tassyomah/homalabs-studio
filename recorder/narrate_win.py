#!/usr/bin/env python3
"""narrate recorder sidecar for Windows — screen + mic + cursor capture.

Same command line and line protocol as recorder/narrate.py (macOS), so the app drives both identically:

    narrate_win.py --list                 devices (JSON)
    narrate_win.py --check [--request]    permission state (JSON); --request opens Windows' microphone privacy page
    narrate_win.py record --out DIR [--fps 60] [--screen N] [--mic N | --no-mic] [--camera N] [--system-audio]
    narrate_win.py finalize --out DIR     finish a recording whose process died (crash recovery, spec §62)
    narrate_win.py meter [--mic N]        microphone level, one {"level": 0..1} line every 100 ms until stdin closes
    narrate_win.py analyze --out DIR      Smart Director signals + proposals → analysis.json (add-on spec §7–9)
    narrate_win.py enhance --out DIR      cleaned voice track mic.clean.wav (noise reduction + loudness, spec §16); raw mic.wav untouched
    narrate_win.py transcribe --out DIR [--model base.en]   local Whisper → transcript.json (spec §43; first run installs
                                          faster-whisper into LOCALAPPDATA/Narrate/speech and downloads the model)

While recording, `recording.json` (setup) and `events.partial.jsonl` (cursor log, pauses) are appended to on disk,
so `finalize` can rebuild `events.json` from what reached the disk if the recorder is killed.

Protocol (one JSON object per line):
  stdout → {"event":"started"|"paused"|"resumed"|"stopped"|"finalizing"|"ready"|"error", ...}
  stdin  ← {"cmd":"pause"|"resume"|"stop"}      (a bare newline, a closed stdin or Ctrl-C also stops)

Output folder: screen.mp4 (cursor hidden), mic.wav, camera.mp4 (when a camera was chosen), system.wav (with
--system-audio, via WASAPI loopback in win_loopback.py), events.json, cursors/*.png.
The camera is a separate file on the shared clock (`t0Camera`, `cameraOffset`), never baked into the screen (spec §10).

Time base: Windows system time as Unix seconds (time.time()). Video and audio are captured by two
independent ffmpeg processes, each with `-use_wallclock_as_timestamps 1 -copyts`, so every packet is
stamped with that same clock (measured: ddagrab is 0-based, dshow is machine uptime and gdigrab is
already wall clock without it — mixing them in one process starves one stream). Cursor events, video
and audio therefore share one timebase with no offset measurement.
Pauses are not cut from the media; they are recorded as `pauses` and the editor skips them.

Capture: Desktop Duplication (`ddagrab`, GPU, ~60 fps) with automatic fallback to GDI (`gdigrab`,
~25 fps at 1080p) when Desktop Duplication is unavailable (RDP, some drivers). Both streams are
written to Matroska while recording (crash-tolerant, and it keeps the wall-clock start time, which
fragmented MP4 does not) and remuxed to screen.mp4 / mic.wav on finalisation.

Requirements: Python 3.10+ (standard library only) and ffmpeg + ffprobe on PATH
(`winget install Gyan.FFmpeg`). Override with NARRATE_FFMPEG / NARRATE_FFPROBE.

Known limits (same as the interim macOS recorder): the floating control bar is part of the capture,
no window/region capture yet, no system audio yet. ddagrab's output index follows DXGI order of the
first GPU, which is assumed to match the DISPLAY1, DISPLAY2 ... device order.
"""
import argparse, ctypes, glob, hashlib, json, math, os, re, shutil, signal, struct, subprocess, sys, threading, time, zlib
from ctypes import wintypes
from datetime import datetime

now = time.time
CREATE_NO_WINDOW = 0x08000000            # never flash a console when launched from the app
def emit(**kw): print(json.dumps(kw), flush=True)
def log(msg): print(msg, file=sys.stderr, flush=True)

# ---------------------------------------------------------------- tools
def find_tool(name):
    env = os.environ.get(f"NARRATE_{name.upper()}")
    if env and os.path.exists(env): return env
    p = shutil.which(name)
    if p: return p
    local = os.environ.get("LOCALAPPDATA", "")
    candidates = [os.path.join(local, "Microsoft", "WinGet", "Links", f"{name}.exe"),
                  os.path.expanduser(rf"~\bin\{name}.exe"), rf"C:\ffmpeg\bin\{name}.exe"]
    candidates += glob.glob(os.path.join(local, "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg*", "*", "bin", f"{name}.exe"))
    return next((c for c in candidates if os.path.exists(c)), None)

FFMPEG = find_tool("ffmpeg"); FFPROBE = find_tool("ffprobe")

def run(cmd, timeout=30):
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                          timeout=timeout, creationflags=CREATE_NO_WINDOW)

def need_ffmpeg():
    if FFMPEG and FFPROBE: return
    emit(event="error", code="no_ffmpeg", message="ffmpeg is not installed. Install it with `winget install Gyan.FFmpeg`, then reopen Narrate.")
    sys.exit(2)

# ---------------------------------------------------------------- win32
user32 = ctypes.windll.user32; gdi32 = ctypes.windll.gdi32; shell32 = ctypes.windll.shell32
try: shcore = ctypes.windll.shcore
except OSError: shcore = None

def set_dpi_aware():
    """Physical pixels everywhere: cursor position, monitor rects, cursor bitmaps."""
    try:
        user32.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        if user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)): return   # PER_MONITOR_AWARE_V2
    except Exception: pass
    try:
        if shcore: shcore.SetProcessDpiAwareness(2); return
    except Exception: pass
    user32.SetProcessDPIAware()

class RECT(ctypes.Structure): _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long), ("right", ctypes.c_long), ("bottom", ctypes.c_long)]
class MONITORINFOEXW(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", RECT), ("rcWork", RECT), ("dwFlags", wintypes.DWORD), ("szDevice", wintypes.WCHAR * 32)]
class DISPLAY_DEVICEW(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("DeviceName", wintypes.WCHAR * 32), ("DeviceString", wintypes.WCHAR * 128),
                ("StateFlags", wintypes.DWORD), ("DeviceID", wintypes.WCHAR * 128), ("DeviceKey", wintypes.WCHAR * 128)]
class CURSORINFO(ctypes.Structure): _fields_ = [("cbSize", wintypes.DWORD), ("flags", wintypes.DWORD), ("hCursor", ctypes.c_void_p), ("ptScreenPos", wintypes.POINT)]
class ICONINFO(ctypes.Structure): _fields_ = [("fIcon", wintypes.BOOL), ("xHotspot", wintypes.DWORD), ("yHotspot", wintypes.DWORD), ("hbmMask", ctypes.c_void_p), ("hbmColor", ctypes.c_void_p)]
class BITMAP(ctypes.Structure):
    _fields_ = [("bmType", ctypes.c_long), ("bmWidth", ctypes.c_long), ("bmHeight", ctypes.c_long), ("bmWidthBytes", ctypes.c_long),
                ("bmPlanes", wintypes.WORD), ("bmBitsPixel", wintypes.WORD), ("bmBits", ctypes.c_void_p)]
class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", ctypes.c_long), ("biHeight", ctypes.c_long), ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD),
                ("biCompression", wintypes.DWORD), ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", ctypes.c_long), ("biYPelsPerMeter", ctypes.c_long),
                ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD)]
class BITMAPINFO(ctypes.Structure): _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]
MonitorEnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(RECT), ctypes.c_void_p)
for fn, argtypes in ((user32.GetMonitorInfoW, [ctypes.c_void_p, ctypes.c_void_p]), (user32.GetCursorInfo, [ctypes.c_void_p]),
                     (user32.GetIconInfo, [ctypes.c_void_p, ctypes.c_void_p]), (user32.DrawIconEx, [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_int, ctypes.c_int, wintypes.UINT, ctypes.c_void_p, wintypes.UINT]),
                     (gdi32.GetObjectW, [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]), (gdi32.CreateCompatibleDC, [ctypes.c_void_p]),
                     (gdi32.CreateDIBSection, [ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p, wintypes.DWORD]),
                     (gdi32.SelectObject, [ctypes.c_void_p, ctypes.c_void_p]), (gdi32.DeleteObject, [ctypes.c_void_p]), (gdi32.DeleteDC, [ctypes.c_void_p])):
    fn.argtypes = argtypes
gdi32.CreateCompatibleDC.restype = ctypes.c_void_p; gdi32.CreateDIBSection.restype = ctypes.c_void_p; gdi32.SelectObject.restype = ctypes.c_void_p

def displays():
    """Monitors in physical pixels (virtual-screen coordinates), primary first."""
    out = []
    def cb(hmon, _hdc, _rect, _lp):
        mi = MONITORINFOEXW(); mi.cbSize = ctypes.sizeof(mi)
        if not user32.GetMonitorInfoW(hmon, ctypes.byref(mi)): return True
        dpi = wintypes.UINT(96)
        if shcore:
            try: shcore.GetDpiForMonitor(ctypes.c_void_p(hmon), 0, ctypes.byref(dpi), ctypes.byref(wintypes.UINT()))
            except Exception: pass
        dd = DISPLAY_DEVICEW(); dd.cb = ctypes.sizeof(dd); model = ""
        if user32.EnumDisplayDevicesW(mi.szDevice, 0, ctypes.byref(dd), 0): model = dd.DeviceString.strip()
        r = mi.rcMonitor
        out.append({"id": int(hmon), "x": r.left, "y": r.top, "width": r.right - r.left, "height": r.bottom - r.top,
                    "scale": dpi.value / 96.0, "primary": bool(mi.dwFlags & 1), "model": model, "device": mi.szDevice})
        return True
    user32.EnumDisplayMonitors(None, None, MonitorEnumProc(cb), None)
    # \\.\DISPLAY1, \\.\DISPLAY2 … — the order DXGI (and therefore ddagrab's output_idx) is expected to follow.
    out.sort(key=lambda d: int(re.sub(r"\D", "", d["device"]) or 0))
    for k, d in enumerate(out):
        model = d["model"] if d["model"] and "Generic" not in d["model"] else ""
        d["name"] = f"Display {k + 1}" + (f" · {model}" if model else "") + (" · main" if d["primary"] else "")
    return out

# ---------------------------------------------------------------- devices / permissions
_dshow_cache = None
def dshow_devices():
    """{"audio": [(name, alt)], "video": [(name, alt)]} — the alternative name is unique even with two identical devices."""
    global _dshow_cache
    if _dshow_cache is not None: return _dshow_cache
    out = {"audio": [], "video": []}
    try: err = run([FFMPEG, "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]).stderr
    except Exception: return out
    cur = None
    for line in err.splitlines():
        m = re.search(r'"(.+)" \(([^)]*)\)\s*$', line)
        if m:
            kinds = [k for k in ("audio", "video") if k in m.group(2)]
            cur = {"name": m.group(1), "alt": None, "kinds": kinds} if kinds else None
            continue
        m = re.search(r'Alternative name "(.+)"', line)
        if m and cur:
            for k in cur["kinds"]: out[k].append((cur["name"], m.group(1)))
            cur = None
    _dshow_cache = out
    return out

def dshow_audio_devices(): return dshow_devices()["audio"]
def dshow_video_devices(): return dshow_devices()["video"]

def camera_format(alt, want_fps=30):
    """Best format the camera offers: largest frame at >= 24 fps, capped at 1080p, MJPEG preferred at equal size.
    → (width, height, fps, codec_or_pixel_format) or None to let dshow choose."""
    try: err = run([FFMPEG, "-hide_banner", "-list_options", "true", "-f", "dshow", "-i", f"video={alt}"], timeout=20).stderr
    except Exception: return None
    best = None
    for m in re.finditer(r'(pixel_format|vcodec)=(\S+)\s+min s=\d+x\d+ fps=[\d.]+\s+max s=(\d+)x(\d+) fps=([\d.]+)', err):
        kind, fmt, w, h, fps = m.group(1), m.group(2), int(m.group(3)), int(m.group(4)), float(m.group(5))
        if fps < 24 or w > 1920: continue
        key = (w * h, fmt == "mjpeg", fps)
        if best is None or key > best[0]: best = (key, (w, h, min(int(fps), want_fps), kind, fmt))
    return best[1] if best else None

def devices_json():
    disp = displays(); dev = dshow_devices() if FFMPEG else {"audio": [], "video": []}
    return {"screens": [{"index": k, "name": d["name"]} for k, d in enumerate(disp)],
            "mics": [{"index": i, "name": n} for i, (n, _) in enumerate(dev["audio"])],
            "cameras": [{"index": i, "name": n} for i, (n, _) in enumerate(dev["video"])],
            "displays": [{"ordinal": k, "id": d["id"], "width": d["width"], "height": d["height"], "name": d["name"]} for k, d in enumerate(disp)]}

def mic_permission():
    """Windows privacy setting for desktop apps (Settings → Privacy → Microphone)."""
    try:
        import winreg
        base = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone"
        vals = []
        for sub in ("", r"\NonPackaged"):
            try:
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, base + sub) as k: vals.append(winreg.QueryValueEx(k, "Value")[0])
            except OSError: pass
        if any(v == "Deny" for v in vals): return "denied"
        if vals: return "authorized"
    except Exception: pass
    return "unknown"

def check_permissions(request=False):
    mic = mic_permission()
    if request and mic == "denied":
        try: os.startfile("ms-settings:privacy-microphone")
        except OSError: pass
    return {"screen": True, "mic": mic}   # Windows has no screen-recording permission

# ---------------------------------------------------------------- encoder
ENCODERS = [
    ("h264_nvenc", ["-preset", "p4", "-tune", "hq", "-rc", "vbr"]),
    ("h264_qsv", ["-preset", "veryfast"]),
    ("h264_amf", ["-quality", "speed", "-rc", "vbr_peak"]),
    ("libx264", ["-preset", "veryfast", "-tune", "zerolatency"]),
]
def encoder_cache_path():
    return os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "Narrate", "encoder.json")

def pick_encoder():
    """First hardware encoder that actually encodes on this machine; libx264 otherwise.
    The probe takes a few seconds, so the result is cached per ffmpeg binary (recording starts faster)."""
    key = f"{FFMPEG}:{os.path.getmtime(FFMPEG) if FFMPEG else 0}"
    cache = encoder_cache_path()
    try:
        with open(cache) as fh: c = json.load(fh)
        if c.get("key") == key and any(c.get("encoder") == n for n, _ in ENCODERS):
            return next((n, x) for n, x in ENCODERS if n == c["encoder"])
    except Exception: pass
    try: available = run([FFMPEG, "-hide_banner", "-encoders"]).stdout
    except Exception: available = ""
    choice = ENCODERS[-1]
    for name, extra in ENCODERS:
        if name not in available: continue
        try:
            t = run([FFMPEG, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=30:d=0.2",
                     "-c:v", name, *extra, "-pix_fmt", pix_fmt(name), "-f", "null", "-"], timeout=20)
            if t.returncode == 0: choice = (name, extra); break
            log(f"[encoder] {name} unavailable: {t.stderr.strip().splitlines()[-1] if t.stderr.strip() else t.returncode}")
        except Exception as e: log(f"[encoder] {name} test failed: {e}")
    try:
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        with open(cache, "w") as fh: json.dump({"key": key, "encoder": choice[0]}, fh)
    except OSError: pass
    return choice

def pix_fmt(enc): return "yuv420p" if enc == "libx264" else "nv12"

# ---------------------------------------------------------------- cursor log
def write_png(w, h, rgba):
    raw = b"".join(b"\x00" + rgba[y * w * 4:(y + 1) * w * 4] for y in range(h))
    def chunk(tag, data):
        body = tag + data; return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")

def draw_cursor(hcur, w, h, fill):
    """Draw the cursor over a solid fill into a 32-bit top-down DIB; returns BGRA bytes."""
    hdc = gdi32.CreateCompatibleDC(None)
    bmi = BITMAPINFO(); bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bmi.bmiHeader.biWidth, bmi.bmiHeader.biHeight, bmi.bmiHeader.biPlanes, bmi.bmiHeader.biBitCount = w, -h, 1, 32
    bits = ctypes.c_void_p()
    hbm = gdi32.CreateDIBSection(hdc, ctypes.byref(bmi), 0, ctypes.byref(bits), None, 0)
    if not hbm or not bits.value: gdi32.DeleteDC(hdc); return None
    old = gdi32.SelectObject(hdc, hbm)
    ctypes.memset(bits, fill, w * h * 4)
    user32.DrawIconEx(hdc, 0, 0, hcur, w, h, 0, None, 0x0003)   # DI_NORMAL
    gdi32.GdiFlush()
    data = ctypes.string_at(bits, w * h * 4)
    gdi32.SelectObject(hdc, old); gdi32.DeleteObject(hbm); gdi32.DeleteDC(hdc)
    return data

INK = (0x0F, 0x14, 0x14)   # BGR of #14140F, used for XOR-inverted cursor pixels (I-beam etc.)
def render_cursor(hcur):
    """→ (rgba bytes, w, h, hotspot) in physical pixels, or None."""
    ii = ICONINFO()
    if not user32.GetIconInfo(hcur, ctypes.byref(ii)): return None
    try:
        bm = BITMAP()
        src = ii.hbmColor or ii.hbmMask
        if not gdi32.GetObjectW(src, ctypes.sizeof(bm), ctypes.byref(bm)): return None
        w, h = bm.bmWidth, bm.bmHeight if ii.hbmColor else bm.bmHeight // 2
        if w <= 0 or h <= 0 or w > 512 or h > 512: return None
        black = draw_cursor(hcur, w, h, 0x00); white = draw_cursor(hcur, w, h, 0xFF)
        if not black or not white: return None
        out = bytearray(w * h * 4)
        for i in range(0, w * h * 4, 4):
            b0, g0, r0 = black[i], black[i + 1], black[i + 2]
            b1, g1, r1 = white[i], white[i + 1], white[i + 2]
            diff = ((b1 - b0) + (g1 - g0) + (r1 - r0)) / 3
            if diff < -8:                                   # inverted pixel: show as ink
                out[i:i + 4] = bytes((INK[2], INK[1], INK[0], 255)); continue
            a = max(0, min(255, round(255 - diff)))
            if a == 0: continue
            out[i] = min(255, r0 * 255 // a); out[i + 1] = min(255, g0 * 255 // a); out[i + 2] = min(255, b0 * 255 // a); out[i + 3] = a
        return bytes(out), w, h, (int(ii.xHotspot), int(ii.yHotspot))
    finally:
        if ii.hbmMask: gdi32.DeleteObject(ii.hbmMask)
        if ii.hbmColor: gdi32.DeleteObject(ii.hbmColor)

class Journal:
    """Append-only line journal (events.partial.jsonl) so a crash loses at most the last flush interval."""
    def __init__(self, path):
        self.path = path; self.lock = threading.Lock(); self.buf = []
        self.fh = open(path, "a", encoding="utf-8")
    def add(self, kind, data):
        with self.lock: self.buf.append(json.dumps({"k": kind, "d": data}))
    def flush(self):
        with self.lock:
            if not self.buf: return
            self.fh.write("\n".join(self.buf) + "\n"); self.buf.clear(); self.fh.flush()
    def close(self): self.flush(); self.fh.close()

def read_journal(path):
    moves, clicks, changes, cursors, pauses = [], [], [], {}, []
    if not os.path.exists(path): return moves, clicks, changes, cursors, pauses
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            try: e = json.loads(line)
            except ValueError: continue          # a torn last line after a crash
            k, d = e.get("k"), e.get("d")
            if k == "m": moves.extend(d)
            elif k == "c": clicks.append(d)
            elif k == "s": changes.append(d)
            elif k == "cur": cursors[d["id"]] = d["shape"]
            elif k == "pause": pauses.append([d, None])
            elif k == "resume" and pauses and pauses[-1][1] is None: pauses[-1][1] = d
    return moves, clicks, changes, cursors, pauses

class CursorLog:
    """Cursor position / buttons / shape by polling. No hooks, no extra permissions."""
    def __init__(self, disp, outdir, journal, hz=120):
        self.disp = disp; self.hz = hz; self.outdir = outdir; self.journal = journal
        os.makedirs(os.path.join(outdir, "cursors"), exist_ok=True)
        self.moves, self.clicks, self.cursorChanges, self.cursors = [], [], [], {}
        self.by_handle = {}          # hCursor → cursor id (rendered once per handle)
        self.last = None; self.buttons = [False, False]; self.cur_id = None
        self.stop = threading.Event()

    def cursor_id(self, hcur):
        if hcur in self.by_handle: return self.by_handle[hcur]
        r = render_cursor(hcur)
        if r is None: self.by_handle[hcur] = self.cur_id; return self.cur_id
        rgba, w, h, (hx, hy) = r
        cid = hashlib.sha1(rgba).hexdigest()[:12]
        if cid not in self.cursors:
            fn = f"cursors/{cid}.png"
            with open(os.path.join(self.outdir, fn), "wb") as fh: fh.write(write_png(w, h, rgba))
            s = self.disp["scale"]   # stored in points like macOS; the renderer multiplies by display.scale
            self.cursors[cid] = {"file": fn, "hotspot": [hx / s, hy / s], "size": [w / s, h / s]}
            self.journal.add("cur", {"id": cid, "shape": self.cursors[cid]})
        self.by_handle[hcur] = cid
        return cid

    def run(self):
        period = 1.0 / self.hz; n = 0; pending = []
        ci = CURSORINFO(); ci.cbSize = ctypes.sizeof(ci)
        pt = wintypes.POINT(); ox, oy = self.disp["x"], self.disp["y"]
        while not self.stop.is_set():
            t = now()
            if user32.GetCursorPos(ctypes.byref(pt)):
                x, y = pt.x - ox, pt.y - oy
                if self.last != (x, y):
                    self.last = (x, y); m = [round(t, 4), x, y]; self.moves.append(m); pending.append(m)
            for i, vk in enumerate((0x01, 0x02)):                     # VK_LBUTTON, VK_RBUTTON
                down = bool(user32.GetAsyncKeyState(vk) & 0x8000)
                if down != self.buttons[i] and self.last is not None:
                    self.buttons[i] = down
                    c = {"t": round(t, 4), "type": "down" if down else "up", "button": "left" if i == 0 else "right", "x": self.last[0], "y": self.last[1]}
                    self.clicks.append(c); self.journal.add("c", c)
            if n % 6 == 0 and user32.GetCursorInfo(ctypes.byref(ci)) and ci.hCursor and ci.flags & 1:
                cid = self.cursor_id(ci.hCursor)
                if cid and cid != self.cur_id:
                    self.cur_id = cid; ch = [round(t, 4), cid]; self.cursorChanges.append(ch); self.journal.add("s", ch)
            if n % 60 == 0:                                            # every 0.5 s: journal the moves and flush
                if pending: self.journal.add("m", pending); pending = []
                self.journal.flush()
            n += 1
            time.sleep(max(0, period - (now() - t)))
        if pending: self.journal.add("m", pending)
        self.journal.flush()

# ---------------------------------------------------------------- mic level meter
def meter(args):
    """Stream the microphone level (RMS, 0..1 with a soft log curve) at 10 Hz until stdin closes."""
    need_ffmpeg()
    mics = dshow_audio_devices()
    if not mics: emit(event="error", code="no_mic", message="No microphone detected."); return
    mic = mics[args.mic] if args.mic is not None and 0 <= args.mic < len(mics) else mics[0]
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-f", "dshow", "-audio_buffer_size", "50", "-i", f"audio={mic[1]}",
           "-ac", "1", "-ar", "16000", "-f", "s16le", "-flush_packets", "1", "-"]   # flush per packet or the pipe lags ~1 s
    p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=CREATE_NO_WINDOW)
    JOB.assign(p)
    threading.Thread(target=lambda: (sys.stdin.read(), kill(p)), daemon=True).start()   # app closes stdin → stop
    import array, math
    chunk = 1600 * 2                                                  # 100 ms of mono s16
    while True:
        data = p.stdout.read(chunk)
        if len(data) < chunk: break
        a = array.array("h", data)
        rms = math.sqrt(sum(v * v for v in a) / len(a)) / 32768.0
        db = 20 * math.log10(max(rms, 1e-6))
        emit(event="level", level=round(max(0.0, min(1.0, (db + 60) / 60)), 3))   # -60 dBFS → 0, 0 dBFS → 1
    kill(p)

# ---------------------------------------------------------------- helpers
def probe(path):
    try:
        out = run([FFPROBE, "-v", "error", "-show_entries", "stream=start_time,duration,nb_frames,codec_type,width,height", "-of", "json", path]).stdout
        return json.loads(out)["streams"][0]
    except Exception: return {}

def drain(pipe, sink):
    def go():
        for line in pipe: sink(line.rstrip("\n"))
    th = threading.Thread(target=go, daemon=True); th.start(); return th

def kill(proc):
    if proc.poll() is None:
        proc.terminate()
        try: proc.wait(2)
        except subprocess.TimeoutExpired: proc.kill(); proc.wait()

# ---------------------------------------------------------------- capture processes
MIC_BUFFER_MS = 50   # dshow audio_buffer_size; a packet is stamped on arrival, i.e. this long after its first sample

class _JobObject:
    """Windows job with KILL_ON_JOB_CLOSE: every ffmpeg assigned to it dies when this process dies, so a
    recorder crash never leaves an orphan capturing the screen (spec §62/§82)."""
    def __init__(self):
        self.h = None
        try:
            k32 = ctypes.windll.kernel32
            k32.CreateJobObjectW.restype = ctypes.c_void_p
            h = k32.CreateJobObjectW(None, None)
            class LIMIT(ctypes.Structure):
                _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64), ("LimitFlags", wintypes.DWORD),
                            ("MinimumWorkingSetSize", ctypes.c_size_t), ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                            ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]
            class IO(ctypes.Structure):
                _fields_ = [(n, ctypes.c_uint64) for n in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]
            class EXT(ctypes.Structure):
                _fields_ = [("BasicLimitInformation", LIMIT), ("IoInfo", IO), ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                            ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]
            info = EXT(); info.BasicLimitInformation.LimitFlags = 0x2000          # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if h and k32.SetInformationJobObject(ctypes.c_void_p(h), 9, ctypes.byref(info), ctypes.sizeof(info)): self.h = h   # 9 = JobObjectExtendedLimitInformation
        except Exception as e: log(f"[job] unavailable: {e}")
    def assign(self, proc):
        if self.h:
            try: ctypes.windll.kernel32.AssignProcessToJobObject(ctypes.c_void_p(self.h), ctypes.c_void_p(int(proc._handle)))
            except Exception as e: log(f"[job] assign failed: {e}")
JOB = _JobObject()

class Capture:
    """One ffmpeg process writing one stream; stdout/stderr drained, stopped with 'q'."""
    def __init__(self, name, cmd, path):
        self.name, self.cmd, self.path, self.err = name, cmd, path, []
        log(f"[{name}] " + " ".join(cmd))
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
                                     encoding="utf-8", errors="replace", creationflags=CREATE_NO_WINDOW)
        JOB.assign(self.proc)
        drain(self.proc.stderr, lambda l: (self.err.append(l), log(f"[{name}] {l}")))
    def alive(self): return self.proc.poll() is None
    def wait_for_data(self, seconds, min_bytes=4096):
        """True once the output file is growing; False if the process died or nothing arrived in time."""
        deadline = time.time() + seconds
        while time.time() < deadline:
            if not self.alive(): return False
            if os.path.exists(self.path) and os.path.getsize(self.path) > min_bytes: return True
            time.sleep(0.1)
        return False
    def stop(self, timeout=15):
        try: self.proc.stdin.write("q"); self.proc.stdin.flush()
        except Exception: pass
        try: self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired: kill(self.proc)
    def kill(self): kill(self.proc)
    def tail(self, n=6): return "\n".join(self.err[-n:])

def video_cmd(mode, d, w, h, fps, enc, extra, path):
    mbps = max(12, w * h * 8 // 1_000_000)                       # ~8 Mbit/s per megapixel, like the macOS recorder
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-thread_queue_size", "1024"]
    if mode == "ddagrab":
        idx = d["ordinal"]
        cmd += ["-f", "lavfi", "-use_wallclock_as_timestamps", "1",
                "-i", f"ddagrab=output_idx={idx}:framerate={fps}:draw_mouse=0,hwdownload,format=bgra,crop={w}:{h}:0:0"]
    else:
        cmd += ["-f", "gdigrab", "-use_wallclock_as_timestamps", "1", "-framerate", str(fps), "-draw_mouse", "0",
                "-offset_x", str(d["x"]), "-offset_y", str(d["y"]), "-video_size", f"{w}x{h}", "-i", "desktop"]
    cmd += ["-copyts", "-c:v", enc, *extra, "-pix_fmt", pix_fmt(enc), "-g", str(fps)]
    cmd += ["-crf", "18"] if enc == "libx264" else ["-b:v", f"{mbps}M", "-maxrate", f"{int(mbps * 1.5)}M", "-bufsize", f"{mbps * 2}M"]
    return cmd + [path]   # Matroska: a crash mid-recording leaves a playable file (spec §62); finalisation remuxes to MP4

def audio_cmd(mic, path):
    return [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-thread_queue_size", "1024",
            "-f", "dshow", "-use_wallclock_as_timestamps", "1", "-rtbufsize", "256M", "-audio_buffer_size", str(MIC_BUFFER_MS),
            "-i", f"audio={mic[1]}", "-copyts", "-c:a", "pcm_s16le", "-ar", "48000", path]   # Matroska: crash-tolerant

def camera_cmd(cam, fmt, enc, extra, path):
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-thread_queue_size", "1024",
           "-f", "dshow", "-use_wallclock_as_timestamps", "1", "-rtbufsize", "256M"]
    if fmt:
        w, h, fps, kind, f = fmt
        cmd += ["-video_size", f"{w}x{h}", "-framerate", str(fps), "-vcodec" if kind == "vcodec" else "-pixel_format", f]
    cmd += ["-i", f"video={cam[1]}", "-copyts", "-c:v", enc, *extra, "-pix_fmt", pix_fmt(enc), "-g", "30"]
    cmd += ["-crf", "20"] if enc == "libx264" else ["-b:v", "6M", "-maxrate", "9M", "-bufsize", "12M"]
    return cmd + [path]

# ---------------------------------------------------------------- record
def record(args):
    need_ffmpeg()
    outdir = args.out or os.path.join(os.path.expanduser("~"), "Videos", "Narrate", f"{datetime.now():%Y-%m-%d-%H-%M-%S}")
    os.makedirs(outdir, exist_ok=True)
    perms = check_permissions()
    if not args.no_mic and perms["mic"] == "denied":
        emit(event="error", code="mic_permission", message="Windows is blocking microphone access for desktop apps. Allow it in Settings → Privacy & security → Microphone."); sys.exit(3)

    disp_all = displays()
    if not disp_all: emit(event="error", code="no_screen", message="No display found."); sys.exit(3)
    d = disp_all[args.screen] if 0 <= args.screen < len(disp_all) else disp_all[0]
    d["ordinal"] = disp_all.index(d)
    w, h = d["width"] - d["width"] % 2, d["height"] - d["height"] % 2          # 4:2:0 needs even sizes
    disp = {"id": d["id"], "scale": d["scale"], "pointWidth": w / d["scale"], "pointHeight": h / d["scale"], "width": w, "height": h}

    mic = None
    if not args.no_mic:
        mics = dshow_audio_devices()
        if mics: mic = mics[args.mic] if args.mic is not None and 0 <= args.mic < len(mics) else mics[0]
        elif args.mic is not None:
            emit(event="error", code="no_mic", message="The selected microphone is no longer available. Choose another microphone."); sys.exit(3)
    cam = None
    if args.camera is not None:
        cams = dshow_video_devices()
        if 0 <= args.camera < len(cams): cam = cams[args.camera]
        else: emit(event="error", code="no_camera", message="The selected camera is no longer available. Choose another camera."); sys.exit(3)

    enc, extra = pick_encoder()
    raw_video = os.path.join(outdir, "screen.mkv"); mic_path = os.path.join(outdir, "mic.mka"); cam_path = os.path.join(outdir, "camera.mkv")
    t_launch = now()
    setup = {"version": 1, "display": disp, "fps": args.fps, "tLaunch": t_launch, "encoder": enc, "mic": mic[0] if mic else None,
             "camera": cam[0] if cam else None, "systemAudio": bool(args.system_audio), "startedAt": datetime.now().isoformat(timespec="seconds")}
    with open(os.path.join(outdir, "recording.json"), "w") as fh: json.dump(setup, fh)   # presence without events.json = unfinished

    loopback = None
    if args.system_audio:
        try:
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            from win_loopback import Loopback
            loopback = Loopback(os.path.join(outdir, "system.raw.wav")); loopback.start()
            log(f"[system] WASAPI loopback: {loopback.format}")
        except Exception as e:
            log(f"[system] loopback unavailable: {e}"); loopback = None

    audio = Capture("mic", audio_cmd(mic, mic_path), mic_path) if mic else None
    camera = Capture("camera", camera_cmd(cam, camera_format(cam[1]), enc, extra, cam_path), cam_path) if cam else None
    video = Capture("screen", video_cmd("ddagrab", d, w, h, args.fps, enc, extra, raw_video), raw_video)
    mode = "ddagrab"
    if not video.wait_for_data(6):
        log(f"[recorder] ddagrab unavailable ({video.tail(2) or 'no frames'}); falling back to gdigrab")
        video.kill(); mode = "gdigrab"
        video = Capture("screen", video_cmd("gdigrab", d, w, h, args.fps, enc, extra, raw_video), raw_video)
        if not video.wait_for_data(8):
            video.kill()
            for c in (audio, camera):
                if c: c.kill()
            emit(event="error", code="no_frames", message="The screen capture produced no frames.\n" + video.tail()); sys.exit(4)
    setup["capture"] = mode
    with open(os.path.join(outdir, "recording.json"), "w") as fh: json.dump(setup, fh)
    warnings = []
    if audio and not audio.wait_for_data(4, min_bytes=1024):
        audio.kill(); audio = None
        warnings.append("The microphone could not be started; recording without audio. " + audio.tail(1) if False else "The microphone could not be started; recording without audio.")
    if camera and not camera.wait_for_data(8, min_bytes=4096):
        tail = camera.tail(2); camera.kill(); camera = None
        warnings.append("The camera could not be started; recording without it. " + tail)
    if args.system_audio and not loopback:
        warnings.append("System audio could not be captured on this device; recording without it.")
    for w_ in warnings: log("[recorder] " + w_)
    warning = "\n".join(warnings) or None

    journal = Journal(os.path.join(outdir, "events.partial.jsonl"))
    cl = CursorLog(d, outdir, journal); th = threading.Thread(target=cl.run, daemon=True); th.start()
    pauses = []
    emit(event="started", out=outdir, display=disp, tLaunch=t_launch, encoder=enc, capture=mode, mic=mic[0] if audio else None,
         camera=cam[0] if camera else None, systemAudio=bool(loopback), warning=warning)

    stopped = threading.Event()
    def do_stop(*_): stopped.set()
    def handle(cmd):
        if cmd == "pause" and not (pauses and pauses[-1][1] is None):
            pauses.append([round(now(), 4), None]); journal.add("pause", pauses[-1][0]); journal.flush(); emit(event="paused", t=pauses[-1][0])
        elif cmd == "resume" and pauses and pauses[-1][1] is None:
            pauses[-1][1] = round(now(), 4); journal.add("resume", pauses[-1][1]); journal.flush(); emit(event="resumed", t=pauses[-1][1])
        elif cmd == "stop": do_stop()
    def stdin_loop():
        for line in sys.stdin:
            line = line.strip()
            if not line: handle("stop"); continue
            try: handle(json.loads(line).get("cmd"))
            except Exception: handle("stop")
        do_stop()   # stdin closed → the app died → stop cleanly
    threading.Thread(target=stdin_loop, daemon=True).start()
    signal.signal(signal.SIGINT, do_stop)
    try: signal.signal(signal.SIGBREAK, do_stop)
    except (AttributeError, ValueError): pass

    sys_t0_written = False
    while not stopped.is_set():
        if not video.alive():
            emit(event="error", code="ffmpeg_died", message="Capture stopped unexpectedly.\n" + video.tail(8)); stopped.set()
        elif audio and not audio.alive():
            log("[recorder] microphone capture ended early: " + audio.tail(3)); audio = None   # keep the video going
        elif camera and not camera.alive():
            log("[recorder] camera capture ended early: " + camera.tail(3)); camera = None
        if loopback and loopback.t0 is not None and not sys_t0_written:
            setup["t0System"] = loopback.t0; sys_t0_written = True                           # the journal/setup carry it for recovery
            with open(os.path.join(outdir, "recording.json"), "w") as fh: json.dump(setup, fh)
        stopped.wait(0.05)
    t_end = now()
    if pauses and pauses[-1][1] is None: pauses[-1][1] = round(t_end, 4)
    cl.stop.set(); th.join(timeout=1); journal.close()
    video.stop()
    for c in (audio, camera):
        if c: c.stop()
    if loopback:
        loopback.stop()
        if loopback.t0 is not None: setup["t0System"] = loopback.t0
    emit(event="stopped", out=outdir, duration=round(t_end - t_launch, 2))
    finalize(outdir, setup, t_end, capture=mode, log_data=(cl.moves, cl.clicks, cl.cursorChanges, cl.cursors, pauses))

def finalize(outdir, setup, t_end, capture=None, log_data=None):
    """Turn the raw capture (screen.mkv, mic.mka, journal) into screen.mp4 / mic.wav / events.json.
    Used at the end of a normal recording and by `finalize` after a crash (then log_data comes from the journal)."""
    raw_video = os.path.join(outdir, "screen.mkv"); screen_path = os.path.join(outdir, "screen.mp4"); mic_path = os.path.join(outdir, "mic.mka")
    journal_path = os.path.join(outdir, "events.partial.jsonl")
    moves, clicks, changes, cursors, pauses = log_data if log_data else read_journal(journal_path)
    if pauses and pauses[-1][1] is None: pauses[-1][1] = round(t_end, 4)

    emit(event="finalizing", step="video")
    if os.path.exists(raw_video):
        t0v = float(probe(raw_video).get("start_time", 0) or 0)     # wall-clock origin, before the remux resets it
        setup["t0Video"] = t0v
        with open(os.path.join(outdir, "recording.json"), "w") as fh: json.dump(setup, fh)   # survives a crash during the remux
        run([FFMPEG, "-v", "error", "-y", "-i", raw_video, "-c", "copy", "-movflags", "+faststart", screen_path], timeout=600)
        if not (os.path.exists(screen_path) and os.path.getsize(screen_path) > 0):
            emit(event="error", code="remux_failed", message="The recording could not be finalised. The raw capture is kept as screen.mkv."); sys.exit(5)
        os.remove(raw_video)
    elif os.path.exists(screen_path): t0v = float(setup.get("t0Video", 0) or 0)   # finalize re-run after a crash during finalize
    else:
        emit(event="error", code="no_video", message="This recording has no video file; nothing could be recovered."); sys.exit(5)
    vid = probe(screen_path)
    t0m = None
    wav = os.path.join(outdir, "mic.wav")
    if os.path.exists(mic_path):
        emit(event="finalizing", step="audio")
        st = probe(mic_path).get("start_time")
        run([FFMPEG, "-v", "error", "-y", "-i", mic_path, "-c:a", "pcm_s16le", "-ar", "48000", wav], timeout=600)
        if st is not None and os.path.exists(wav):
            t0m = float(st) - MIC_BUFFER_MS / 1000.0                  # packets are stamped on arrival; the first sample is one buffer older
            setup["t0Mic"] = t0m; os.remove(mic_path)
    elif os.path.exists(wav) and setup.get("t0Mic") is not None: t0m = float(setup["t0Mic"])
    # camera: same treatment as the screen (Matroska → faststart MP4), origin kept in setup for re-runs
    cam_raw = os.path.join(outdir, "camera.mkv"); cam_mp4 = os.path.join(outdir, "camera.mp4"); t0c = None; cam_info = None
    if os.path.exists(cam_raw):
        emit(event="finalizing", step="video")
        st = probe(cam_raw).get("start_time")
        run([FFMPEG, "-v", "error", "-y", "-i", cam_raw, "-c", "copy", "-movflags", "+faststart", cam_mp4], timeout=600)
        if st is not None and os.path.exists(cam_mp4) and os.path.getsize(cam_mp4) > 0:
            t0c = float(st); setup["t0Camera"] = t0c; os.remove(cam_raw)
    elif os.path.exists(cam_mp4) and setup.get("t0Camera") is not None: t0c = float(setup["t0Camera"])
    if t0c is not None:
        cp = probe(cam_mp4); cam_info = {"width": int(cp.get("width", 0) or 0), "height": int(cp.get("height", 0) or 0), "duration": float(cp.get("duration", 0) or 0)}
    # system audio: raw float WAV from WASAPI loopback → 48 kHz s16; its origin is the first packet's wall-clock time
    sys_raw = os.path.join(outdir, "system.raw.wav"); sys_wav = os.path.join(outdir, "system.wav"); t0s = None
    if os.path.exists(sys_raw) and setup.get("t0System") is not None:
        emit(event="finalizing", step="audio")
        run([FFMPEG, "-v", "error", "-y", "-i", sys_raw, "-c:a", "pcm_s16le", "-ar", "48000", sys_wav], timeout=600)
        if os.path.exists(sys_wav) and os.path.getsize(sys_wav) > 1000: t0s = float(setup["t0System"]); os.remove(sys_raw)
    elif os.path.exists(sys_wav) and setup.get("t0System") is not None: t0s = float(setup["t0System"])
    if os.path.exists(sys_raw) and t0s is None: os.remove(sys_raw)       # nothing ever played, or no origin: drop it
    events = {"version": 2, "display": setup["display"], "fps": setup["fps"], "tLaunch": setup["tLaunch"], "tEnd": t_end,
              "t0Video": t0v, "t0Mic": t0m, "t0Camera": t0c, "t0System": t0s,
              "videoDuration": float(vid.get("duration", 0) or 0), "videoFrames": int(vid.get("nb_frames", 0) or 0),
              "micOffset": (t0m - t0v) if t0m is not None else None,
              "cameraOffset": (t0c - t0v) if t0c is not None else None, "camera": cam_info,
              "systemOffset": (t0s - t0v) if t0s is not None else None,
              "pauses": pauses, "platform": "win32", "encoder": setup.get("encoder"), "capture": capture,
              "recovered": log_data is None,
              "cursors": cursors, "cursorChanges": changes, "moves": moves, "clicks": clicks, "scrolls": [],
              "files": {"screen": "screen.mp4", "mic": "mic.wav" if t0m is not None else None, "camera": "camera.mp4" if t0c is not None else None,
                        "system": "system.wav" if t0s is not None else None}}
    tmp = os.path.join(outdir, "events.json.tmp")
    with open(tmp, "w") as fh: json.dump(events, fh)
    os.replace(tmp, os.path.join(outdir, "events.json"))              # atomic: events.json is complete or absent
    for f in (journal_path, os.path.join(outdir, "recording.json")):
        if os.path.exists(f): os.remove(f)
    emit(event="ready", out=outdir, frames=events["videoFrames"], duration=events["videoDuration"], clicks=len(clicks) // 2, recovered=log_data is None)

def recover(args):
    """Finalize a recording whose recorder died. The end time is the raw video's last modification."""
    need_ffmpeg()
    outdir = args.out
    setup_path = os.path.join(outdir, "recording.json")
    if not outdir or not os.path.exists(setup_path):
        emit(event="error", code="not_recoverable", message="No unfinished recording found in that folder."); sys.exit(3)
    with open(setup_path) as fh: setup = json.load(fh)
    for name in ("screen.mkv", "screen.mp4"):
        p = os.path.join(outdir, name)
        if os.path.exists(p): t_end = os.path.getmtime(p); break
    else: t_end = now()
    finalize(outdir, setup, t_end, capture=setup.get("capture"))

# ---------------------------------------------------------------- analysis (Smart Director, add-on spec §7–9)
def ff_lines(args, timeout=1800):
    """Run ffmpeg and return its stderr lines (filters print their reports there)."""
    return run([FFMPEG, "-hide_banner", "-nostats", *args], timeout=timeout).stderr.splitlines()

def detect_silences(path, offset, noise_db=-35, min_len=0.8):
    """[(start, end)] in source seconds where the microphone is quiet."""
    out, start = [], None
    for line in ff_lines(["-i", path, "-af", f"silencedetect=noise={noise_db}dB:d={min_len}", "-f", "null", "-"]):
        m = re.search(r"silence_start:\s*([\d.]+)", line)
        if m: start = float(m.group(1)); continue
        m = re.search(r"silence_end:\s*([\d.]+)", line)
        if m and start is not None: out.append((round(start + offset, 3), round(float(m.group(1)) + offset, 3))); start = None
    return out

def detect_scenes(path, threshold=0.25):
    """[(t, score)] visual cuts: moments the screen content changed a lot (window switch, page change…)."""
    out, t = [], None
    for line in ff_lines(["-i", path, "-vf", f"scale=320:-2,select='gte(scene,{threshold})',metadata=print", "-f", "null", "-"]):
        m = re.search(r"pts_time:([\d.]+)", line)
        if m: t = float(m.group(1)); continue
        m = re.search(r"lavfi\.scene_score=([\d.]+)", line)
        if m and t is not None: out.append((round(t, 3), round(float(m.group(1)), 3))); t = None
    return out

def idle_stretches(ev, min_len=2.5):
    """[(start, end)] in source seconds with no cursor movement and no clicks."""
    t0, dur = ev["t0Video"], ev["videoDuration"]
    times = sorted([m[0] - t0 for m in ev["moves"]] + [c["t"] - t0 for c in ev["clicks"]])
    times = [t for t in times if 0 <= t <= dur]
    out, prev = [], 0.0
    for t in times + [dur]:
        if t - prev >= min_len: out.append((round(prev, 3), round(t, 3)))
        prev = t
    return out

def click_groups(ev, gap=2.6, dist_frac=0.33):
    """Same grouping as the renderer's auto-zoom (motion.ts): clicks close in time and space."""
    W, t0 = ev["display"]["width"], ev["t0Video"]
    downs = sorted([(c["t"] - t0, c["x"], c["y"]) for c in ev["clicks"] if c["type"] == "down"])
    groups = []
    for t, x, y in downs:
        if groups and t - groups[-1][-1][0] < gap and math.hypot(x - groups[-1][-1][1], y - groups[-1][-1][2]) < W * dist_frac: groups[-1].append((t, x, y))
        else: groups.append([(t, x, y)])
    return groups

def overlap(a, b): return (max(a[0], b[0]), min(a[1], b[1]))

def analyze(args):
    need_ffmpeg()
    outdir = args.out
    ev_path = os.path.join(outdir, "events.json")
    if not outdir or not os.path.exists(ev_path):
        emit(event="error", code="no_recording", message="No finished recording in that folder."); sys.exit(3)
    with open(ev_path) as fh: ev = json.load(fh)
    dur = ev["videoDuration"]
    emit(event="analyzing", step="audio")
    silences = detect_silences(os.path.join(outdir, ev["files"]["mic"]), ev.get("micOffset") or 0) if ev["files"].get("mic") else []
    emit(event="analyzing", step="screen")
    scenes = detect_scenes(os.path.join(outdir, ev["files"]["screen"]))
    emit(event="analyzing", step="interaction")
    idle = idle_stretches(ev)
    groups = click_groups(ev)
    t0 = ev["t0Video"]
    clicks = sorted(c["t"] - t0 for c in ev["clicks"] if c["type"] == "down")

    proposals, n = [], 0
    def add(kind, start, end, reason, confidence, **extra):
        nonlocal n; n += 1
        proposals.append({"id": f"{kind.lower()}-{n}", "type": kind, "start": round(max(0, start), 3), "end": round(min(dur, end), 3),
                          "reason": reason, "confidence": confidence, **extra})

    # REMOVE — dead air: nothing said and nothing happening. Keep a little breathing room at both ends.
    MARGIN = 0.35
    for s in silences:
        for i in idle:
            a, b = overlap(s, i)
            if b - a - 2 * MARGIN >= 1.0 and not any(a <= c <= b for c in clicks):
                add("REMOVE", a + MARGIN, b - MARGIN, f"{b - a:.1f}s with no speech and no activity", "high")
    for s in silences:   # long silence while still moving the mouse: probably thinking; medium confidence
        if s[1] - s[0] >= 4 and not any(abs(p["start"] - s[0]) < 1 for p in proposals if p["type"] == "REMOVE") and not any(s[0] <= c <= s[1] for c in clicks):
            add("REMOVE", s[0] + 0.5, s[1] - 0.5, f"{s[1] - s[0]:.1f}s without speech", "medium")

    # SPEED — repetitive navigation: long stretches of busy cursor movement without clicks or speech (add-on §9).
    moves_t = sorted(m[0] - t0 for m in ev["moves"])
    for s in silences:
        a, b = s
        if b - a < 6: continue
        if any(a <= c <= b for c in clicks): continue
        n_moves = sum(1 for t in moves_t if a <= t <= b)
        if n_moves / (b - a) >= 25:                                   # ≥25 position samples/s = the mouse is really moving
            add("SPEED", a + 0.3, b - 0.3, f"{b - a:.0f}s of moving around without talking or clicking", "medium", rate=1.5)

    # CHAPTER — big visual changes, spaced out, not in the first seconds.
    last = -1e9
    for t, score in scenes:
        if t < 3 or t > dur - 3 or t - last < 15: continue
        add("CHAPTER", t, t, f"the screen changed a lot (score {score:.2f})", "high" if score >= 0.45 else "medium", score=score)
        last = t

    # ZOOM — informational: these click clusters already drive the automatic zoom.
    for g in groups:
        add("ZOOM", g[0][0] - 0.55, g[-1][0] + 1.6, f"{len(g)} click{'s' if len(g) > 1 else ''} in one place", "high", clicks=len(g), x=g[0][1], y=g[0][2])

    # HIGHLIGHT — the busiest 12-second windows: dense interaction, clicks, and a visual change nearby.
    WIN = 12.0
    scores = []
    moves = sorted(m[0] - t0 for m in ev["moves"])
    for start in [x * 2.0 for x in range(int(max(0, dur - WIN) / 2.0) + 1)]:
        end = start + WIN
        sc = sum(1 for t in moves if start <= t < end) / 60.0 + 3 * sum(1 for c in clicks if start <= t < end) + 4 * sum(1 for t, _ in scenes if start <= t < end)
        scores.append((sc, start, end))
    scores.sort(reverse=True)
    chosen = []
    for sc, start, end in scores:
        if sc < 3 or any(start < e and end > s for s, e in chosen): continue
        chosen.append((start, end))
        add("HIGHLIGHT", start, end, "busy stretch with clicks and visible change", "medium" if sc < 8 else "high", score=round(sc, 2))
        if len(chosen) == 3: break

    summary = {k: sum(1 for p in proposals if p["type"] == k) for k in ("REMOVE", "SPEED", "ZOOM", "CHAPTER", "HIGHLIGHT")}
    removable = sum(p["end"] - p["start"] for p in proposals if p["type"] == "REMOVE")
    analysis = {"version": 1, "analyzedAt": datetime.now().isoformat(timespec="seconds"), "duration": dur,
                "signals": {"silences": silences, "scenes": scenes, "idle": idle, "clickGroups": [[g[0][0], g[-1][0], len(g)] for g in groups]},
                "proposals": proposals, "summary": {**summary, "removableSeconds": round(removable, 2)}}
    tmp = os.path.join(outdir, "analysis.json.tmp")
    with open(tmp, "w") as fh: json.dump(analysis, fh)
    os.replace(tmp, os.path.join(outdir, "analysis.json"))
    emit(event="ready", out=outdir, summary=analysis["summary"])

# ---------------------------------------------------------------- audio enhancement (spec §16)
def enhance(args):
    """mic.wav → mic.clean.wav: gentle high-pass, FFT noise reduction, two-pass EBU loudness to -16 LUFS. Same length, same start."""
    need_ffmpeg()
    outdir = args.out
    ev_path = os.path.join(outdir, "events.json")
    if not outdir or not os.path.exists(ev_path):
        emit(event="error", code="no_recording", message="No finished recording in that folder."); sys.exit(3)
    with open(ev_path) as fh: ev = json.load(fh)
    if not ev["files"].get("mic"):
        emit(event="error", code="no_mic", message="This recording has no microphone track."); sys.exit(3)
    src = os.path.join(outdir, ev["files"]["mic"]); dst = os.path.join(outdir, "mic.clean.wav"); tmp = dst + ".tmp.wav"
    emit(event="enhancing", step="measure")
    chain = "highpass=f=80,afftdn=nr=12:nf=-40:tn=1"
    lines = ff_lines(["-i", src, "-af", f"{chain},loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"], timeout=1800)
    stats = None
    try:
        js = "\n".join(lines); i = js.rfind("{"); stats = json.loads(js[i:js.rfind("}") + 1]) if i >= 0 else None
    except ValueError: stats = None
    emit(event="enhancing", step="render")
    if stats and all(k in stats for k in ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")):
        ln = (f"loudnorm=I=-16:TP=-1.5:LRA=11:measured_I={stats['input_i']}:measured_TP={stats['input_tp']}:measured_LRA={stats['input_lra']}"
              f":measured_thresh={stats['input_thresh']}:offset={stats['target_offset']}:linear=true")
    else: ln = "loudnorm=I=-16:TP=-1.5:LRA=11"
    r = run([FFMPEG, "-v", "error", "-y", "-i", src, "-af", f"{chain},{ln}", "-ar", "48000", "-c:a", "pcm_s16le", tmp], timeout=1800)
    if r.returncode != 0 or not os.path.exists(tmp):
        emit(event="error", code="enhance_failed", message="Could not clean the voice track.\n" + r.stderr[-300:]); sys.exit(4)
    os.replace(tmp, dst)
    emit(event="ready", out=outdir, file="mic.clean.wav", measured=stats and {"lufs": stats.get("input_i"), "peak": stats.get("input_tp")})

# ---------------------------------------------------------------- transcription (spec §43; local Whisper)
def speech_env():
    """Private virtual environment for the speech engine, created on first use. Returns its python.exe."""
    root = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "Narrate", "speech")
    py = os.path.join(root, "Scripts", "python.exe")
    marker = os.path.join(root, "installed.txt")
    if os.path.exists(py) and os.path.exists(marker): return py
    emit(event="transcribing", stage="installing", message="Setting up the speech engine (one time, ~300 MB)…")
    r = subprocess.run([sys.executable, "-m", "venv", root], capture_output=True, text=True, creationflags=CREATE_NO_WINDOW)
    if r.returncode != 0: raise RuntimeError("could not create the speech environment: " + r.stderr[-400:])
    # msvc-runtime provides the VC++ runtime DLLs ctranslate2 needs on machines without the system-wide redistributable
    r = subprocess.run([py, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "faster-whisper", "msvc-runtime"],
                       capture_output=True, text=True, creationflags=CREATE_NO_WINDOW, timeout=1800)
    if r.returncode != 0: raise RuntimeError("could not install the speech engine: " + r.stderr[-400:])
    with open(marker, "w") as fh: fh.write("faster-whisper\n")
    return py

def transcribe(args):
    outdir = args.out
    ev_path = os.path.join(outdir, "events.json")
    if not outdir or not os.path.exists(ev_path):
        emit(event="error", code="no_recording", message="No finished recording in that folder."); sys.exit(3)
    with open(ev_path) as fh: ev = json.load(fh)
    if not ev["files"].get("mic"):
        emit(event="error", code="no_mic", message="This recording has no microphone track to transcribe."); sys.exit(3)
    try: py = speech_env()
    except Exception as e:
        emit(event="error", code="speech_install", message=str(e)); sys.exit(4)
    emit(event="transcribing", stage="loading", message="Loading the speech model…")
    worker = os.path.join(os.path.dirname(os.path.abspath(__file__)), "transcribe_worker.py")
    raw = os.path.join(outdir, "transcript.raw.json")
    # decode with ffmpeg to 16 kHz mono float32 so the worker never needs a media library of its own
    pcm = os.path.join(outdir, "transcript.pcm.tmp")
    need_ffmpeg()
    r = run([FFMPEG, "-v", "error", "-y", "-i", os.path.join(outdir, ev["files"]["mic"]), "-ac", "1", "-ar", "16000", "-f", "f32le", pcm], timeout=600)
    if r.returncode != 0 or not os.path.exists(pcm):
        emit(event="error", code="decode_failed", message="Could not read the microphone track.\n" + r.stderr[-300:]); sys.exit(4)
    p = subprocess.Popen([py, worker, pcm, raw, args.model], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         text=True, encoding="utf-8", errors="replace", creationflags=CREATE_NO_WINDOW)
    JOB.assign(p)
    err = []; drain(p.stderr, lambda l: (err.append(l), log("[whisper] " + l)))
    for line in p.stdout:
        if not line.startswith("{"): continue
        try: m = json.loads(line)
        except ValueError: continue
        if m.get("event") == "progress": emit(event="transcribing", stage=m.get("stage", "transcribing"), done=m.get("done"), total=m.get("total"))
    p.wait()
    try: os.remove(pcm)
    except OSError: pass
    if p.returncode != 0 or not os.path.exists(raw):
        emit(event="error", code="transcribe_failed", message="Transcription failed.\n" + "\n".join(err[-4:])); sys.exit(4)
    # shift from mic time to source (screen) time so the editor and renderer can use it directly
    with open(raw, encoding="utf-8") as fh: t = json.load(fh)
    off = ev.get("micOffset") or 0
    for s in t["segments"]:
        s["start"] = round(s["start"] + off, 3); s["end"] = round(s["end"] + off, 3)
        for w in s["words"]: w["start"] = round(w["start"] + off, 3); w["end"] = round(w["end"] + off, 3)
    t["version"] = 1; t["createdAt"] = datetime.now().isoformat(timespec="seconds"); t["timebase"] = "source"
    tmp = os.path.join(outdir, "transcript.json.tmp")
    with open(tmp, "w", encoding="utf-8") as fh: json.dump(t, fh, ensure_ascii=False)
    os.replace(tmp, os.path.join(outdir, "transcript.json")); os.remove(raw)
    emit(event="ready", out=outdir, segments=len(t["segments"]), language=t.get("language"))

def main():
    set_dpi_aware()
    ap = argparse.ArgumentParser(prog="narrate")
    ap.add_argument("cmd", nargs="?", default="record")
    ap.add_argument("--out"); ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--screen", type=int, default=0); ap.add_argument("--mic", type=int); ap.add_argument("--no-mic", action="store_true")
    ap.add_argument("--camera", type=int); ap.add_argument("--system-audio", action="store_true")
    ap.add_argument("--model", default="base.en")
    ap.add_argument("--list", action="store_true"); ap.add_argument("--check", action="store_true"); ap.add_argument("--request", action="store_true")
    args = ap.parse_args()
    if args.list: print(json.dumps(devices_json())); return
    if args.check: print(json.dumps(check_permissions(args.request))); return
    if args.cmd == "finalize": recover(args); return
    if args.cmd == "meter": meter(args); return
    if args.cmd == "analyze": analyze(args); return
    if args.cmd == "transcribe": transcribe(args); return
    if args.cmd == "enhance": enhance(args); return
    record(args)

if __name__ == "__main__": main()
