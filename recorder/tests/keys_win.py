"""Unit test for the keyboard-shortcut log: starts the hook, presses Ctrl+Shift+F13 and plain letters synthetically,
and checks that only the shortcut was recorded (spec §20: shortcuts yes, typing never).

    python recorder/tests/keys_win.py
"""
import ctypes, os, sys, threading, time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import narrate_win as n

class FakeJournal:
    def add(self, *_): pass
    def flush(self): pass

kl = n.KeyLog(FakeJournal())
th = threading.Thread(target=kl.run, daemon=True); th.start()
time.sleep(0.5)
u = ctypes.windll.user32
def tap(vk, up): u.keybd_event(vk, 0, 2 if up else 0, 0); time.sleep(0.03)
for vk, up in ((0x11, False), (0x10, False), (0x7C, False), (0x7C, True), (0x10, True), (0x11, True)): tap(vk, up)   # Ctrl+Shift+F13
for vk in (0x48, 0x49):   # "h", "i" — plain typing, must not be logged
    tap(vk, False); tap(vk, True)
tap(0x1B, False); tap(0x1B, True)   # Esc alone is logged (useful in demos)
time.sleep(0.3); kl.stop(); th.join(timeout=2)
combos = [k["keys"] for k in kl.keys]
print("logged:", combos)
assert combos == ["Ctrl+Shift+F13", "Esc"], combos
print("OK")
