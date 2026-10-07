#!/usr/bin/env python3
"""narrate recorder sidecar for Windows — screen + mic + cursor capture.

Same command line and line protocol as recorder/narrate.py (macOS), so the app drives both identically:

    narrate_win.py --list                 devices (JSON)
    narrate_win.py --check [--request]    permission state (JSON); --request opens Windows' microphone privacy page
    narrate_win.py record --out DIR [--fps 60] [--screen N] [--mic N | --no-mic]

Protocol (one JSON object per line):
  stdout → {"event":"started"|"paused"|"resumed"|"stopped"|"finalizing"|"ready"|"error", ...}
  stdin  ← {"cmd":"pause"|"resume"|"stop"}      (a bare newline, a closed stdin or Ctrl-C also stops)

Output folder: screen.mp4 (cursor hidden), mic.wav, events.json, cursors/*.png.

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
import argparse, ctypes, glob, hashlib, json, os, re, shutil, signal, struct, subprocess, sys, threading, time, zlib
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
def dshow_audio_devices():
    """[(friendly name, alternative name)] — the alternative name is unique even with two identical mics."""
    try: err = run([FFMPEG, "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]).stderr
    except Exception: return []
    devs, cur = [], None
    for line in err.splitlines():
        m = re.search(r'"(.+)" \(([^)]*)\)\s*$', line)
        if m:
            cur = {"name": m.group(1), "alt": None} if "audio" in m.group(2) else None
            if cur: devs.append(cur)
            continue
        m = re.search(r'Alternative name "(.+)"', line)
        if m and cur: cur["alt"] = m.group(1)
    return [(d["name"], d["alt"] or d["name"]) for d in devs]

def devices_json():
    disp = displays(); mics = dshow_audio_devices() if FFMPEG else []
    return {"screens": [{"index": k, "name": d["name"]} for k, d in enumerate(disp)],
            "mics": [{"index": i, "name": n} for i, (n, _) in enumerate(mics)],
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

class CursorLog:
    """Cursor position / buttons / shape by polling. No hooks, no extra permissions."""
    def __init__(self, disp, outdir, hz=120):
        self.disp = disp; self.hz = hz; self.outdir = outdir
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
        self.by_handle[hcur] = cid
        return cid

    def run(self):
        period = 1.0 / self.hz; n = 0
        ci = CURSORINFO(); ci.cbSize = ctypes.sizeof(ci)
        pt = wintypes.POINT(); ox, oy = self.disp["x"], self.disp["y"]
        while not self.stop.is_set():
            t = now()
            if user32.GetCursorPos(ctypes.byref(pt)):
                x, y = pt.x - ox, pt.y - oy
                if self.last != (x, y):
                    self.last = (x, y); self.moves.append([round(t, 4), x, y])
            for i, vk in enumerate((0x01, 0x02)):                     # VK_LBUTTON, VK_RBUTTON
                down = bool(user32.GetAsyncKeyState(vk) & 0x8000)
                if down != self.buttons[i] and self.last is not None:
                    self.buttons[i] = down
                    self.clicks.append({"t": round(t, 4), "type": "down" if down else "up",
                                        "button": "left" if i == 0 else "right", "x": self.last[0], "y": self.last[1]})
            if n % 6 == 0 and user32.GetCursorInfo(ctypes.byref(ci)) and ci.hCursor and ci.flags & 1:
                cid = self.cursor_id(ci.hCursor)
                if cid and cid != self.cur_id:
                    self.cur_id = cid; self.cursorChanges.append([round(t, 4), cid])
            n += 1
            time.sleep(max(0, period - (now() - t)))

# ---------------------------------------------------------------- helpers
def probe(path):
    try:
        out = run([FFPROBE, "-v", "error", "-show_entries", "stream=start_time,duration,nb_frames,codec_type", "-of", "json", path]).stdout
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

class Capture:
    """One ffmpeg process writing one stream; stdout/stderr drained, stopped with 'q'."""
    def __init__(self, name, cmd, path):
        self.name, self.cmd, self.path, self.err = name, cmd, path, []
        log(f"[{name}] " + " ".join(cmd))
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
                                     encoding="utf-8", errors="replace", creationflags=CREATE_NO_WINDOW)
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

    enc, extra = pick_encoder()
    raw_video = os.path.join(outdir, "screen.mkv"); screen_path = os.path.join(outdir, "screen.mp4")
    mic_path = os.path.join(outdir, "mic.mka")
    t_launch = now()

    audio = Capture("mic", audio_cmd(mic, mic_path), mic_path) if mic else None
    video = Capture("screen", video_cmd("ddagrab", d, w, h, args.fps, enc, extra, raw_video), raw_video)
    mode = "ddagrab"
    if not video.wait_for_data(6):
        log(f"[recorder] ddagrab unavailable ({video.tail(2) or 'no frames'}); falling back to gdigrab")
        video.kill(); mode = "gdigrab"
        video = Capture("screen", video_cmd("gdigrab", d, w, h, args.fps, enc, extra, raw_video), raw_video)
        if not video.wait_for_data(8):
            video.kill()
            if audio: audio.kill()
            emit(event="error", code="no_frames", message="The screen capture produced no frames.\n" + video.tail()); sys.exit(4)
    warning = None
    if audio and not audio.wait_for_data(4, min_bytes=1024):
        audio.kill(); audio = None
        warning = "The microphone could not be started; recording without audio.\n" + video.tail(2)
        log("[recorder] " + warning)

    cl = CursorLog(d, outdir); th = threading.Thread(target=cl.run, daemon=True); th.start()
    pauses = []
    emit(event="started", out=outdir, display=disp, tLaunch=t_launch, encoder=enc, capture=mode, mic=mic[0] if audio else None, warning=warning)

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
    signal.signal(signal.SIGINT, do_stop)
    try: signal.signal(signal.SIGBREAK, do_stop)
    except (AttributeError, ValueError): pass

    while not stopped.is_set():
        if not video.alive():
            emit(event="error", code="ffmpeg_died", message="Capture stopped unexpectedly.\n" + video.tail(8)); stopped.set()
        elif audio and not audio.alive():
            log("[recorder] microphone capture ended early: " + audio.tail(3)); audio = None   # keep the video going
        stopped.wait(0.05)
    t_end = now()
    if pauses and pauses[-1][1] is None: pauses[-1][1] = round(t_end, 4)
    cl.stop.set(); th.join(timeout=1)
    video.stop()
    if audio: audio.stop()
    emit(event="stopped", out=outdir, duration=round(t_end - t_launch, 2))

    # ---- finalize: media become zero-based so Chromium can play them; events.json keeps the clock origins
    emit(event="finalizing", step="video")
    t0v = float(probe(raw_video).get("start_time", 0) or 0)         # wall-clock origin, before the remux resets it
    run([FFMPEG, "-v", "error", "-y", "-i", raw_video, "-c", "copy", "-movflags", "+faststart", screen_path], timeout=600)
    if not (os.path.exists(screen_path) and os.path.getsize(screen_path) > 0):
        emit(event="error", code="remux_failed", message="The recording could not be finalised. The raw capture is kept as screen.mkv."); sys.exit(5)
    os.remove(raw_video)
    vid = probe(screen_path)
    t0m = None
    if os.path.exists(mic_path):
        emit(event="finalizing", step="audio")
        st = probe(mic_path).get("start_time")
        run([FFMPEG, "-v", "error", "-y", "-i", mic_path, "-c:a", "pcm_s16le", "-ar", "48000", os.path.join(outdir, "mic.wav")], timeout=600)
        if st is not None and os.path.exists(os.path.join(outdir, "mic.wav")):
            t0m = float(st) - MIC_BUFFER_MS / 1000.0                  # packets are stamped on arrival; the first sample is one buffer older
            os.remove(mic_path)
    events = {"version": 2, "display": disp, "fps": args.fps, "tLaunch": t_launch, "tEnd": t_end,
              "t0Video": t0v, "t0Mic": t0m,
              "videoDuration": float(vid.get("duration", 0) or 0), "videoFrames": int(vid.get("nb_frames", 0) or 0),
              "micOffset": (t0m - t0v) if t0m is not None else None,
              "pauses": pauses, "platform": "win32", "encoder": enc, "capture": mode,
              "cursors": cl.cursors, "cursorChanges": cl.cursorChanges, "moves": cl.moves, "clicks": cl.clicks, "scrolls": [],
              "files": {"screen": "screen.mp4", "mic": "mic.wav" if t0m is not None else None}}
    with open(os.path.join(outdir, "events.json"), "w") as fh: json.dump(events, fh)
    emit(event="ready", out=outdir, frames=events["videoFrames"], duration=events["videoDuration"], clicks=len(cl.clicks) // 2)

def main():
    set_dpi_aware()
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
