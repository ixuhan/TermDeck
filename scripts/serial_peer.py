"""
Peer device on the far end of a virtual serial pair.

Talks to the port through raw Win32 calls so no extra package is needed.

    python serial_peer.py write COM7 "hello\r\n"
    python serial_peer.py read  COM7 3000

`read` exits as soon as data arrives or the timeout expires, and prints the raw
bytes to stdout so the caller can assert on them.
"""

import ctypes
import struct
import sys
import time
from ctypes import wintypes

GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
OPEN_EXISTING = 3

k32 = ctypes.windll.kernel32
k32.CreateFileW.restype = wintypes.HANDLE


def open_port(name: str, baud: int, purge: bool = True):
    handle = k32.CreateFileW(
        f"\\\\.\\{name}",
        GENERIC_READ | GENERIC_WRITE,
        0,
        None,
        OPEN_EXISTING,
        0,
        None,
    )
    if handle == wintypes.HANDLE(-1).value or handle is None:
        raise OSError(f"无法打开 {name}（错误 {k32.GetLastError()}）")

    # BuildCommDCB fills a DCB without us having to model its bitfields.
    dcb = ctypes.create_string_buffer(64)
    cfg = f"baud={baud} parity=N data=8 stop=1".encode("utf-16-le")
    if not k32.BuildCommDCBW(cfg, dcb):
        raise OSError("BuildCommDCB 失败")
    if not k32.SetCommState(handle, dcb):
        raise OSError("SetCommState 失败")

    # Read returns whatever is buffered right away; the constant is the ceiling.
    timeouts = struct.pack("5I", 0xFFFFFFFF, 0, 2000, 0, 0)
    k32.SetCommTimeouts(handle, timeouts)
    if purge:
        # Never purge a reader: the peer may have written before we attached.
        k32.PurgeComm(handle, 0x000F)
    return handle


def write(port: str, data: bytes, baud: int = 115200) -> None:
    h = open_port(port, baud)
    try:
        written = wintypes.DWORD()
        if not k32.WriteFile(h, data, len(data), ctypes.byref(written), None):
            raise OSError(f"写入失败（错误 {k32.GetLastError()}）")
        if not k32.FlushFileBuffers(h):
            pass
        time.sleep(0.15)
    finally:
        k32.CloseHandle(h)


def read(port: str, wait_ms: int, baud: int = 115200) -> bytes:
    h = open_port(port, baud)
    try:
        # Announce readiness so the caller only sends after we can actually
        # receive; without it the first bytes race the port being opened.
        print("READY", file=sys.stderr, flush=True)
        buf = ctypes.create_string_buffer(4096)
        got = wintypes.DWORD()
        deadline = time.time() + wait_ms / 1000.0
        out = b""
        while time.time() < deadline:
            if k32.ReadFile(h, buf, 4096, ctypes.byref(got), None) and got.value:
                out += buf.raw[: got.value]
            time.sleep(0.02)
        return out
    finally:
        k32.CloseHandle(h)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: serial_peer.py write|read PORT [DATA|WAIT_MS]", file=sys.stderr)
        sys.exit(2)
    action, port = sys.argv[1], sys.argv[2]
    try:
        if action == "write":
            payload = (sys.argv[3] if len(sys.argv) > 3 else "").encode()
            write(port, payload)
            print("ok")
        elif action == "read":
            wait_ms = int(sys.argv[3]) if len(sys.argv) > 3 else 3000
            data = read(port, wait_ms)
            sys.stdout.write(data.decode("utf-8", errors="replace"))
        else:
            print(f"unknown action {action}", file=sys.stderr)
            sys.exit(2)
    except OSError as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
