"""System-audio capture on Windows via WASAPI loopback, standard library only (ctypes + raw COM vtables).

ffmpeg has no loopback input on Windows and "Stereo Mix" is rarely available, so the recorder captures the default
render endpoint itself (spec §15). Samples are written as a float32 WAV (`WAVE_FORMAT_IEEE_FLOAT`) in the device's mix
format; the recorder converts it to 48 kHz s16 with ffmpeg at finalisation.

Sync: every packet carries a device position (frames since the stream started) and a QPC timestamp. The first
packet's QPC time is converted to wall-clock seconds (`t0`), and gaps in the device position (loopback delivers
nothing while the system is silent) are filled with zeros, so sample N is always at t0 + N / rate.

    python win_loopback.py out.wav 3      # record 3 s while beeping, print t0 and stats (self-test)
"""
import ctypes, struct, sys, threading, time
from ctypes import wintypes

ole32 = ctypes.windll.ole32; kernel32 = ctypes.windll.kernel32

class GUID(ctypes.Structure):
    _fields_ = [("d1", wintypes.DWORD), ("d2", wintypes.WORD), ("d3", wintypes.WORD), ("d4", ctypes.c_ubyte * 8)]
    def __init__(self, s):
        super().__init__()
        p = s.strip("{}").split("-")
        self.d1 = int(p[0], 16); self.d2 = int(p[1], 16); self.d3 = int(p[2], 16)
        b = bytes.fromhex(p[3] + p[4]); self.d4 = (ctypes.c_ubyte * 8)(*b)

CLSID_MMDeviceEnumerator = GUID("{BCDE0395-E52F-467C-8E3D-C4579291692E}")
IID_IMMDeviceEnumerator = GUID("{A95664D2-9614-4F35-A746-DE8DB63617E6}")
IID_IAudioClient = GUID("{1CB9AD4C-DBFA-4c32-B178-C2F568A703B2}")
IID_IAudioCaptureClient = GUID("{C8ADBD64-E71E-48a0-A4DE-185C395CD317}")
CLSCTX_ALL = 23; eRender = 0; eConsole = 0
AUDCLNT_SHAREMODE_SHARED = 0; AUDCLNT_STREAMFLAGS_LOOPBACK = 0x20000; AUDCLNT_BUFFERFLAGS_SILENT = 0x2

class WAVEFORMATEX(ctypes.Structure):
    _pack_ = 1   # mmreg.h declares these under pshpack1: 18 bytes, no padding
    _fields_ = [("wFormatTag", wintypes.WORD), ("nChannels", wintypes.WORD), ("nSamplesPerSec", wintypes.DWORD), ("nAvgBytesPerSec", wintypes.DWORD),
                ("nBlockAlign", wintypes.WORD), ("wBitsPerSample", wintypes.WORD), ("cbSize", wintypes.WORD)]
class WAVEFORMATEXTENSIBLE(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("Format", WAVEFORMATEX), ("wValidBitsPerSample", wintypes.WORD), ("dwChannelMask", wintypes.DWORD), ("SubFormat", GUID)]
KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = "{00000003-0000-0010-8000-00AA00389B71}"
KSDATAFORMAT_SUBTYPE_PCM = "{00000001-0000-0010-8000-00AA00389B71}"

def _method(obj, index, restype, *argtypes):
    """Call slot `index` of a COM object's vtable."""
    vtbl = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p)))[0]
    proto = ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)
    return proto(vtbl[index])

def _check(hr, what):
    if hr < 0: raise OSError(f"{what} failed: 0x{hr & 0xFFFFFFFF:08X}")

def _release(obj):
    if obj: _method(obj, 2, ctypes.c_ulong)(obj)

def _qpc_to_wall():
    """Return f(qpc_100ns) → wall-clock seconds, sampled now."""
    freq = ctypes.c_int64(); cnt = ctypes.c_int64()
    kernel32.QueryPerformanceFrequency(ctypes.byref(freq)); kernel32.QueryPerformanceCounter(ctypes.byref(cnt))
    wall = time.time(); now_100ns = cnt.value * 10_000_000 // freq.value
    return lambda q: wall - (now_100ns - q) / 1e7

class Loopback:
    """Capture the default output device into a float32 WAV until stop() is called.
    After start(): .rate, .channels; after the first packet: .t0 (wall-clock seconds of sample 0)."""
    def __init__(self, path):
        self.path = path; self.t0 = None; self.frames = 0; self.rate = 0; self.channels = 0; self.format = ""
        self._stop = threading.Event(); self._thread = None; self.error = None

    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True); self._thread.start()
        deadline = time.time() + 3
        while time.time() < deadline and not self.rate and not self.error: time.sleep(0.01)
        if self.error: raise self.error
        if not self.rate: raise OSError("WASAPI loopback did not start")

    def stop(self):
        self._stop.set()
        if self._thread: self._thread.join(timeout=5)

    def _run(self):
        fh = None; enum = None; dev = None; client = None; cap = None; pwfx = None
        try:
            _check(ole32.CoInitializeEx(None, 0), "CoInitializeEx")
            enum = ctypes.c_void_p()
            _check(ole32.CoCreateInstance(ctypes.byref(CLSID_MMDeviceEnumerator), None, CLSCTX_ALL, ctypes.byref(IID_IMMDeviceEnumerator), ctypes.byref(enum)), "CoCreateInstance")
            dev = ctypes.c_void_p()
            _check(_method(enum, 4, ctypes.c_long, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p))(enum, eRender, eConsole, ctypes.byref(dev)), "GetDefaultAudioEndpoint")
            client = ctypes.c_void_p()
            _check(_method(dev, 3, ctypes.c_long, ctypes.POINTER(GUID), wintypes.DWORD, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))(dev, ctypes.byref(IID_IAudioClient), CLSCTX_ALL, None, ctypes.byref(client)), "Activate(IAudioClient)")
            pwfx = ctypes.POINTER(WAVEFORMATEXTENSIBLE)()
            _check(_method(client, 8, ctypes.c_long, ctypes.POINTER(ctypes.POINTER(WAVEFORMATEXTENSIBLE)))(client, ctypes.byref(pwfx)), "GetMixFormat")
            fmt = pwfx.contents.Format
            # WAVE_FORMAT_EXTENSIBLE: the subformat GUID's first field is 3 for IEEE float, 1 for PCM
            is_float = fmt.wFormatTag == 3 or (fmt.wFormatTag == 0xFFFE and pwfx.contents.SubFormat.d1 == 3)
            self.format = f"{'float' if is_float else 'pcm'}{fmt.wBitsPerSample} {fmt.nSamplesPerSec} Hz {fmt.nChannels} ch (subformat {str_guid(pwfx.contents.SubFormat) if fmt.wFormatTag == 0xFFFE else fmt.wFormatTag})"
            _check(_method(client, 3, ctypes.c_long, wintypes.DWORD, wintypes.DWORD, ctypes.c_int64, ctypes.c_int64, ctypes.c_void_p, ctypes.c_void_p)(
                client, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 10_000_000, 0, ctypes.cast(pwfx, ctypes.c_void_p), None), "IAudioClient.Initialize(loopback)")
            cap = ctypes.c_void_p()
            _check(_method(client, 14, ctypes.c_long, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p))(client, ctypes.byref(IID_IAudioCaptureClient), ctypes.byref(cap)), "GetService(IAudioCaptureClient)")
            get_next = _method(cap, 5, ctypes.c_long, ctypes.POINTER(wintypes.UINT))
            get_buf = _method(cap, 3, ctypes.c_long, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.UINT), ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(ctypes.c_uint64), ctypes.POINTER(ctypes.c_uint64))
            release = _method(cap, 4, ctypes.c_long, wintypes.UINT)
            _check(_method(client, 10, ctypes.c_long)(client), "IAudioClient.Start")

            block = fmt.nBlockAlign
            fh = open(self.path, "wb"); fh.write(wav_header(fmt, is_float))
            self.rate, self.channels = fmt.nSamplesPerSec, fmt.nChannels
            n = wintypes.UINT(); data = ctypes.c_void_p(); flags = wintypes.DWORD(); pos = ctypes.c_uint64(); qpc = ctypes.c_uint64()
            base_pos = None
            while not self._stop.is_set():
                time.sleep(0.01)
                while True:
                    _check(get_next(cap, ctypes.byref(n)), "GetNextPacketSize")
                    if n.value == 0: break
                    _check(get_buf(cap, ctypes.byref(data), ctypes.byref(n), ctypes.byref(flags), ctypes.byref(pos), ctypes.byref(qpc)), "GetBuffer")
                    if base_pos is None:
                        base_pos = pos.value; self.t0 = _qpc_to_wall()(qpc.value)
                    expected = pos.value - base_pos                     # frames that should have been written before this packet
                    if expected > self.frames:                          # silence while nothing played: keep the timeline continuous
                        fh.write(b"\x00" * ((expected - self.frames) * block)); self.frames = expected
                    if flags.value & AUDCLNT_BUFFERFLAGS_SILENT: fh.write(b"\x00" * (n.value * block))
                    else: fh.write(ctypes.string_at(data, n.value * block))
                    self.frames += n.value
                    _check(release(cap, n.value), "ReleaseBuffer")
            _method(client, 11, ctypes.c_long)(client)                 # Stop
        except Exception as e:
            self.error = e
        finally:
            if fh:
                size = self.frames * (pwfx.contents.Format.nBlockAlign if pwfx else 0)
                fh.seek(4); fh.write(struct.pack("<I", 36 + 22 + size if False else 4 + 26 + 8 + size))
                fh.seek(42); fh.write(struct.pack("<I", size))          # data chunk size (header is 46 bytes: see wav_header)
                fh.close()
            for o in (cap, client, dev, enum): _release(o)
            if pwfx: ole32.CoTaskMemFree(pwfx)
            ole32.CoUninitialize()

def str_guid(g):
    return "{%08x-%04x-%04x-%s-%s}" % (g.d1, g.d2, g.d3, bytes(g.d4[:2]).hex(), bytes(g.d4[2:]).hex())

def wav_header(fmt, is_float):
    """46-byte WAV header (fmt chunk with cbSize=0) and a data size of 0xFFFFFFFF, which ffmpeg reads as 'to EOF' —
    so a file whose recorder crashed before patching the sizes is still fully playable."""
    tag = 3 if is_float else 1
    f = struct.pack("<HHIIHH", tag, fmt.nChannels, fmt.nSamplesPerSec, fmt.nSamplesPerSec * fmt.nBlockAlign, fmt.nBlockAlign, fmt.wBitsPerSample)
    return b"RIFF" + struct.pack("<I", 0xFFFFFFFF) + b"WAVE" + b"fmt " + struct.pack("<I", 18) + f + struct.pack("<H", 0) + b"data" + struct.pack("<I", 0xFFFFFFFF)

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "loopback-test.wav"
    secs = float(sys.argv[2]) if len(sys.argv) > 2 else 3
    import winsound
    lb = Loopback(out); t_start = time.time(); lb.start()
    print(f"started: {lb.format}")
    beeper = threading.Thread(target=lambda: (time.sleep(0.5), winsound.Beep(880, 400), time.sleep(1.2), winsound.Beep(440, 400)), daemon=True); beeper.start()
    time.sleep(secs); t_stop = time.time(); lb.stop()
    if lb.t0:
        print(f"t0 - start = {lb.t0 - t_start:+.3f}s; samples cover {lb.frames / lb.rate:.3f}s, wall clock from t0 to stop {t_stop - lb.t0:.3f}s (difference = sync error)")
    else: print("no packets received (nothing played?)")
    print(f"error: {lb.error}")
