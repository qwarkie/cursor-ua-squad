<!-- Where capability modules land: camera, mic, files, API client, async-state helpers.
     Copy a module folder in here, fix its import paths, delete its README.
     Change: nothing in this file - it is a signpost, and it is deleted before submission. -->

# src/lib/

Kit modules are copied into this directory - one folder per capability.

```
src/lib/
  camera/     getUserMedia, frame capture
  mic/        recording, speech
  files/      drag and drop, extraction
  api.ts      typed fetch wrappers over /api
```

Rules that keep this directory usable under a 90-minute clock:

- **Types come from `src/types/contract.ts`.** A module never declares its own copy of a
  payload that crosses the network.
- **Modules never call `/api` with a hardcoded IP.** Relative `/api/...` only - the Vite
  proxy handles the rest, which is what makes the phone work.
- **No silent fallbacks.** A module that cannot do its job raises or returns a typed error;
  the screen renders it. An empty array on failure is how a demo dies quietly.
- **Strip the instruction headers and delete this file** before the repo is submitted.

## The one error that eats twenty minutes

```
TypeError: Cannot read properties of undefined (reading 'getUserMedia')
```

`navigator.mediaDevices` is **undefined**, not empty, on an insecure origin — so camera and
mic code throws before any permission prompt appears, and it reads like a bug in the module.
It is not. Check the address bar:

- `https://<lan-ip>:5173` — correct. Accept the certificate warning once per device.
- `http://<lan-ip>:5173` — the cause. `basicSsl()` is missing from `vite.config.ts`, or the
  URL was typed by hand without the `s`. Scan the QR instead of typing.
- `http://localhost:5173` on the laptop works and proves nothing: localhost is a secure
  context by definition, so a camera bug is invisible there and only shows up on the phone.

DeviceOrientation on iOS needs one extra thing beyond HTTPS: `requestPermission()` must be
called **from inside a tap handler**. Called on mount it rejects, and the sensor stays silent.
