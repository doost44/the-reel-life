"""Monitors: list them, and open a screen fullscreen on one of them.

Windows lists them through user32, a Mac through CoreGraphics (pyobjc).
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

MAC = sys.platform == "darwin"

if sys.platform == "win32":
    import ctypes
    import ctypes.wintypes as wt

    _user32 = ctypes.windll.user32

    class _MonitorInfo(ctypes.Structure):
        _fields_ = [("cbSize", wt.DWORD), ("rcMonitor", wt.RECT), ("rcWork", wt.RECT),
                    ("dwFlags", wt.DWORD), ("szDevice", wt.WCHAR * 32)]

    class _DisplayDevice(ctypes.Structure):
        _fields_ = [("cb", wt.DWORD), ("DeviceName", wt.WCHAR * 32), ("DeviceString", wt.WCHAR * 128),
                    ("StateFlags", wt.DWORD), ("DeviceID", wt.WCHAR * 128), ("DeviceKey", wt.WCHAR * 128)]

    _MonitorCallback = ctypes.WINFUNCTYPE(wt.BOOL, wt.HMONITOR, wt.HDC, ctypes.POINTER(wt.RECT), wt.LPARAM)
elif MAC:
    import Quartz


def list_monitors() -> list[dict]:
    """Every monitor, left to right: in real pixels on Windows (ignoring display
    scaling), in points on a Mac, which is what Chrome positions windows in there."""
    if MAC:
        return _list_mac_monitors()
    if sys.platform != "win32":
        return []
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except (AttributeError, OSError):
        pass
    found = []

    def on_monitor(handle, _dc, _rect, _data):
        info = _MonitorInfo()
        info.cbSize = ctypes.sizeof(info)
        _user32.GetMonitorInfoW(handle, ctypes.byref(info))
        bounds = info.rcMonitor
        found.append({
            "id": info.szDevice,
            "label": _label(info.szDevice),
            "x": bounds.left,
            "y": bounds.top,
            "width": bounds.right - bounds.left,
            "height": bounds.bottom - bounds.top,
            "primary": bool(info.dwFlags & 1),
        })
        return True

    _user32.EnumDisplayMonitors(None, None, _MonitorCallback(on_monitor), 0)
    return sorted(found, key=lambda monitor: (monitor["x"], monitor["y"]))


def _label(device: str) -> str:
    """'\\\\.\\DISPLAY5' becomes 'Display 5 (Generic PnP Monitor)'."""
    number = device.rsplit("DISPLAY", 1)[-1]
    attached = _DisplayDevice()
    attached.cb = ctypes.sizeof(attached)
    if _user32.EnumDisplayDevicesW(device, 0, ctypes.byref(attached), 0) and attached.DeviceString:
        return f"Display {number} ({attached.DeviceString})"
    return f"Display {number}"


def _list_mac_monitors() -> list[dict]:
    error, displays, count = Quartz.CGGetActiveDisplayList(32, None, None)
    if error:
        return []
    found = []
    for display in displays[:count]:
        if Quartz.CGDisplayMirrorsDisplay(display):
            continue  # a mirror of another display isn't a place of its own
        bounds = Quartz.CGDisplayBounds(display)
        found.append({
            "id": f"display-{display}",
            "builtin": bool(Quartz.CGDisplayIsBuiltin(display)),
            "x": round(bounds.origin.x),
            "y": round(bounds.origin.y),
            "width": round(bounds.size.width),
            "height": round(bounds.size.height),
            "primary": bool(Quartz.CGDisplayIsMain(display)),
        })
    found.sort(key=lambda monitor: (monitor["x"], monitor["y"]))
    for number, monitor in enumerate(found, 1):
        builtin = monitor.pop("builtin")
        monitor["label"] = f"Display {number} (built-in)" if builtin else f"Display {number}"
    return found


def find_browser(configured: str = "") -> str | None:
    candidates = [Path(configured).expanduser()] if configured else []
    if MAC:
        for name in ("Google Chrome", "Microsoft Edge"):
            candidates += [Path(folder, f"{name}.app") for folder in ("/Applications", Path.home() / "Applications")]
    else:
        program_files = [os.environ.get(name) for name in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA")]
        candidates += [Path(base, "Google/Chrome/Application/chrome.exe") for base in program_files if base]
        candidates += [Path(base, "Microsoft/Edge/Application/msedge.exe") for base in program_files if base]
    for path in candidates:
        if path.suffix == ".app":  # a Mac app is a folder; the program is inside it
            path = path / "Contents" / "MacOS" / path.stem
        if path.is_file():
            return str(path)
    return None


def open_fullscreen(url: str, monitor: dict, profile: Path, browser: str) -> subprocess.Popen:
    """Open url as a kiosk window filling the monitor.

    Each screen gets its own browser profile folder. Without one, Chrome hands
    the URL to a window that's already open and ignores the position.
    """
    inset = 40  # start the window just inside the monitor so Chrome picks that one to go fullscreen on
    return subprocess.Popen([
        browser,
        f"--user-data-dir={profile}",
        f"--window-position={monitor['x'] + inset},{monitor['y'] + inset}",
        f"--window-size={monitor['width'] - 2 * inset},{monitor['height'] - 2 * inset}",
        "--kiosk",
        "--no-first-run",
        "--no-default-browser-check",
        "--hide-crash-restore-bubble",
        "--autoplay-policy=no-user-gesture-required",
        "--disable-features=Translate",
        *(["--use-mock-keychain"] if MAC else []),  # a new profile on a Mac can otherwise ask for the keychain
        url,
    ])
