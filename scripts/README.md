<!-- The phone-testing guide: how to open the dev server on a real device, and every
     failure you will hit doing it. Read this the first time the phone says "no".
     Add a section here whenever the room's Wi-Fi teaches you something new. -->

# Testing on a phone

```bash
make dev
```

That starts the backend and the frontend, prints the LAN URL, and draws a QR code.
Point the phone camera at the QR. Both devices must be on **the same Wi-Fi**.

```
Local   https://localhost:5173
Phone   https://192.168.1.42:5173   same Wi-Fi
API     http://192.168.1.42:8000    proxied at /api — never open directly
```

Open the **Phone** URL, not the API one. The frontend proxies `/api/*` to the backend, so
no IP is ever hardcoded in the app and there is no mixed-content problem.

---

## Why HTTPS, always

Browsers treat `getUserMedia` (camera, microphone), `DeviceOrientation`, `DeviceMotion`,
geolocation and service workers as **secure-context-only** APIs. A secure context means
HTTPS *or* `localhost`. `http://192.168.1.42:5173` is neither, so on the phone:

- Safari and Chrome return `NotAllowedError` / `undefined` for `navigator.mediaDevices` —
  often with no permission prompt at all, which reads like a bug in your code.
- The failure is silent enough that teams lose 20 minutes blaming their camera hook.

The dev server therefore serves **HTTPS over the LAN** with a self-signed certificate.
That certificate is not trusted by anything, which is fine — you just have to click past
the warning once per device.

## Getting past the certificate warning

**iOS Safari** — "This Connection Is Not Private"
→ tap **Show Details** → **visit this website** → **Visit**.

**Chrome (iOS, Android, desktop)** — "Your connection is not private"
→ tap **Advanced** → **Proceed to 192.168.x.x (unsafe)**.

**Android Chrome sometimes hides the Advanced link** when the page auto-reloads. Load the
URL once with the tab in the foreground and do not touch it until the warning settles.

You accept once per device per certificate. Regenerating the cert (or `make clean`) means
accepting again. If Safari refuses to show the bypass at all, close the tab, kill Safari
from the app switcher, and open the URL again in a fresh tab.

## The device-specific traps

**iOS refuses Tailscale addresses.** If the URL shows `100.x.x.x`, that is Tailscale's
CGNAT range; iOS Safari frequently will not load a self-signed HTTPS origin there. Use the
Wi-Fi address instead — the printer already filters `100.64.0.0/10`, but if it picked the
wrong interface, force it:

```bash
LAN_IP=192.168.1.42 make dev
```

Find the right address with `ipconfig getifaddr en0`.

**iOS Chrome needs OS-level camera permission too.** Granting the site prompt is not
enough: **Settings → Chrome → Camera** (and **Microphone**) must be on, or the in-page
prompt never appears. Same for Firefox and Edge on iOS.

**DeviceOrientation on iOS 13+ requires an explicit request from a user gesture:**

```ts
// Must be called inside a click/tap handler — not on mount, not in an effect.
const anyEvent = DeviceOrientationEvent as any
if (typeof anyEvent.requestPermission === 'function') {
  const state = await anyEvent.requestPermission() // 'granted' | 'denied'
  if (state !== 'granted') return
}
window.addEventListener('deviceorientation', onOrientation)
```

Calling it outside a gesture throws `NotAllowedError` and iOS will not prompt again until
the page reloads. Put it behind a "Start" button.

**Low Power Mode** on iOS throttles `requestAnimationFrame` and can pause autoplaying
video. If motion looks broken only on one phone, check the battery icon.

**Lock screen kills the stream.** After unlocking, an existing `MediaStream` is often
dead. Re-acquire it on `visibilitychange` rather than assuming the old track still works.

## When the phone cannot reach the laptop at all

Symptom: the browser hangs or says "cannot connect", no certificate warning ever appears.

1. **Confirm they are on the same network.** Guest SSIDs and 5 GHz/2.4 GHz split networks
   with different subnets do not talk to each other.
2. **Check the address is the Wi-Fi one:** `ipconfig getifaddr en0`. If that prints
   nothing, Wi-Fi is off or you are on Ethernet — try `en1`.
3. **AP isolation / client isolation.** Most venue, café and hotel Wi-Fi blocks device-to-
   device traffic by design. Nothing on the laptop can fix it. **Fix: turn on the phone's
   personal hotspot and join the laptop to it**, then re-run `make dev` — the new LAN
   address prints automatically. This is the reliable move at a hackathon venue; do it
   first rather than debugging the network.
4. **macOS firewall.** System Settings → Network → Firewall → Options: allow incoming
   connections for `python3` and `node`, or turn the firewall off for the session.
5. **VPN on either device** (corporate VPN, Tailscale, Mullvad) reroutes the traffic. Turn
   it off on both.
6. **Port already taken by something else.** `make dev` kills stale listeners on 5173/8000
   before starting; if a different app owns the port, run with `WEB_PORT=5180 make dev`.

## Verifying quickly

From the phone browser, `https://<lan-ip>:5173/api/health` should return the backend's
health JSON — that proves DNS-free routing, HTTPS, the proxy and the backend all work
before you debug any feature.

On the laptop:

```bash
make qr                                        # reprint the URLs and the QR, nothing restarts
backend/.venv/bin/python scripts/lan.py --ip-only   # just the address, for scripts
```

Use the **venv** interpreter, not bare `python3`. The `qrcode` package is installed into
`backend/.venv` by `make install`, so `python3 scripts/lan.py` prints the URL but no QR.
The URL always prints — the QR is never allowed to break the dev loop.

If the printed address is wrong (docking station, VPN, two Wi-Fi adapters), override it:

```bash
LAN_IP=192.168.1.42 make dev
```

An override that is loopback, link-local or `100.64.0.0/10` is rejected out loud and
auto-detection runs instead — it would not be reachable from the phone anyway.
