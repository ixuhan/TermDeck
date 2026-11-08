"""
Native Explorer context menu check.

The menu is a Win32 popup owned by the shell, not DOM, so it is detected by
enumerating windows of class #32768 and counting its items. Passing --close
sends Escape to it, the same way a user would dismiss it.
"""

import ctypes
import json
import sys
from ctypes import wintypes

user32 = ctypes.windll.user32
WM_KEYDOWN = 0x0100
VK_ESCAPE = 0x1B

found = []


def _cb(hwnd, _lparam):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    if buf.value == "#32768":
        # A floating TrackPopupMenu has no window menu handle, so GetMenu returns
        # null. Its size is the reliable signal that it is populated rather than
        # an empty strip.
        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        found.append(
            {
                "hwnd": int(hwnd),
                "w": int(rect.right - rect.left),
                "h": int(rect.bottom - rect.top),
            }
        )
    return True


WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows(WNDENUMPROC(_cb), 0)

if "--close" in sys.argv:
    for f in found:
        user32.PostMessageW(f["hwnd"], WM_KEYDOWN, VK_ESCAPE, 0)

print(json.dumps(found))
