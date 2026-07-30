#!/usr/bin/env python3
# Prints the LAN IP, the dev URLs and a scannable QR code for the phone.
# Called by scripts/dev.sh on startup; also usable standalone: `python3 scripts/lan.py`.
# Change the ports here only if you changed them in vite.config.ts / the backend too.

from __future__ import annotations

import argparse
import ipaddress
import os
import shutil
import socket
import subprocess
import sys

# ANSI pieces. Two separate switches on purpose: NO_COLOR turns off decoration, but the QR
# still needs forced black/white to scan, so it only follows isatty.
IS_TTY = sys.stdout.isatty()
USE_COLOR = IS_TTY and os.environ.get("NO_COLOR") is None
DIM = "\033[2m" if USE_COLOR else ""
BOLD = "\033[1m" if USE_COLOR else ""
CYAN = "\033[36m" if USE_COLOR else ""
GREEN = "\033[32m" if USE_COLOR else ""
RESET = "\033[0m" if USE_COLOR else ""
ANSI_RESET = "\033[0m"

# Addresses that exist but are useless for phone testing.
# 100.64/10 is CGNAT — Tailscale lives there and iOS often refuses to load it.
UNUSABLE_PREFIXES = ("127.", "169.254.")


def _usable(ip: str) -> bool:
    if not ip or ip.startswith(UNUSABLE_PREFIXES):
        return False
    try:
        addr = ipaddress.IPv4Address(ip)
    except ValueError:
        return False
    return addr not in ipaddress.IPv4Network("100.64.0.0/10")


def _run(cmd: list[str]) -> str:
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=3)
    except (OSError, subprocess.SubprocessError):
        return ""
    return out.stdout.strip()


def detect_lan_ip() -> str:
    """macOS first (Wi-Fi is en0 on every Mac laptop), then the default route, then a socket probe."""
    forced = os.environ.get("LAN_IP", "").strip()
    if forced:
        if _usable(forced):
            return forced
        # Never silently ignore an override the user typed on purpose.
        print(
            f"lan.py: LAN_IP={forced} is loopback, link-local or CGNAT (100.64/10) — "
            "a phone cannot reach it. Detecting instead.",
            file=sys.stderr,
        )

    for iface in ("en0", "en1", "en2"):
        ip = _run(["ipconfig", "getifaddr", iface])
        if _usable(ip):
            return ip

    route = _run(["route", "-n", "get", "default"])
    for line in route.splitlines():
        if "interface:" in line:
            ip = _run(["ipconfig", "getifaddr", line.split(":")[-1].strip()])
            if _usable(ip):
                return ip

    # Last resort, works on Linux too: ask the kernel which source address it would use.
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
    except OSError:
        ip = ""
    finally:
        sock.close()
    return ip if _usable(ip) else ""


def qr_lines(url: str) -> list[str]:
    """QR as terminal lines. Returns [] when the `qrcode` package is not installed."""
    try:
        import qrcode  # type: ignore
    except ImportError:
        return []

    qr = qrcode.QRCode(
        border=2,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
    )
    qr.add_data(url)
    qr.make(fit=True)
    matrix = qr.get_matrix()  # True = dark module

    if not IS_TTY:
        # Piped or redirected: no ANSI, so polarity depends on whatever renders the text.
        # Dark modules as filled blocks is the light-background convention and the one
        # phone scanners expect when the output is pasted into a doc or chat.
        return ["".join("██" if cell else "  " for cell in row) for row in matrix]

    # Half-block rendering: one character carries two rows, colors are forced so the
    # code scans on light and dark terminal themes alike.
    if len(matrix) % 2:
        matrix = matrix + [[False] * len(matrix[0])]
    lines: list[str] = []
    for top, bottom in zip(matrix[0::2], matrix[1::2]):
        chunks = []
        for t, b in zip(top, bottom):
            fg = 30 if t else 97  # black on dark module, white on light module
            bg = 40 if b else 107
            chunks.append(f"\033[{fg};{bg}m▀")
        lines.append("".join(chunks) + ANSI_RESET)
    return lines


def main() -> int:
    parser = argparse.ArgumentParser(description="LAN URLs + QR code for phone testing")
    parser.add_argument("--ip", default="", help="LAN IP to use instead of auto-detection")
    parser.add_argument("--web-port", default="5173")
    parser.add_argument("--api-port", default="8000")
    parser.add_argument("--scheme", default="https", choices=["https", "http"])
    parser.add_argument("--url", default="", help="Encode this exact URL in the QR")
    parser.add_argument("--ip-only", action="store_true", help="Print just the IP and exit")
    args = parser.parse_args()

    given = args.ip.strip()
    if given and not _usable(given):
        print(f"lan.py: --ip {given} is not reachable from a phone — detecting instead.", file=sys.stderr)
        given = ""
    ip = given or detect_lan_ip()

    if args.ip_only:
        print(ip)
        return 0

    local_url = f"{args.scheme}://localhost:{args.web_port}"
    lan_url = args.url or (f"{args.scheme}://{ip}:{args.web_port}" if ip else "")
    width = min(shutil.get_terminal_size((80, 24)).columns, 78)
    rule = DIM + "─" * width + RESET

    print()
    print(rule)
    print(f"  {BOLD}Local{RESET}   {local_url}")
    if lan_url:
        print(f"  {BOLD}Phone{RESET}   {GREEN}{lan_url}{RESET}   {DIM}same Wi-Fi{RESET}")
        print(f"  {BOLD}API{RESET}     http://{ip}:{args.api_port}   {DIM}proxied at /api — never open directly{RESET}")
    else:
        print(f"  {BOLD}Phone{RESET}   {DIM}no LAN address found — is Wi-Fi on?{RESET}")
        print(f"  {DIM}Override with: LAN_IP=192.168.x.x make dev{RESET}")
    print(rule)

    if lan_url:
        lines = qr_lines(lan_url)
        if lines:
            print()
            for line in lines:
                print("  " + line)
            print()
            print(f"  {DIM}Scan it. The certificate is self-signed, so the phone will warn once:{RESET}")
            print(f"  {DIM}Safari: Show Details → visit this website. Chrome: Advanced → Proceed.{RESET}")
            print(f"  {DIM}Stuck? {CYAN}scripts/README.md{RESET}{DIM} answers every phone problem.{RESET}")
        else:
            print()
            print(f"  {DIM}No QR: the `qrcode` package is missing from this interpreter.{RESET}")
            print(f"  {DIM}Type the URL above, or run `make install` to get the code back.{RESET}")
            print(f"  {DIM}Standalone use needs the venv: backend/.venv/bin/python scripts/lan.py{RESET}")
    print()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # never break the dev loop over a pretty banner
        print(f"lan.py: {exc}", file=sys.stderr)
        sys.exit(0)
