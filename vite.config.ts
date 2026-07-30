// Vite dev/build config: HTTPS over the LAN, /api proxy to FastAPI, LAN URL + QR on startup.
// HTTPS is not optional here - getUserMedia and DeviceOrientation are blocked on plain http
// from a non-localhost origin, so a phone could not open the camera or the mic without it.
// Change: BACKEND_URL below if the backend does not run on 127.0.0.1:8000.

import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
// Default import, not a named one: qrcode-terminal is CommonJS and Vite loads this config
// as native ESM, where a named import from a CJS module throws at startup.
import qrcodeTerminal from 'qrcode-terminal';

// Where the FastAPI backend listens. http is the default; https also works because the
// proxy runs with secure:false and will accept the backend's self-signed certificate.
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://127.0.0.1:8000';

const PORT = 5173;
const PREVIEW_PORT = 4173;

// One proxy table, used by both `vite` and `vite preview`. Without it on preview, a
// production bundle served by `npm run preview` 404s every /api call and the bug looks
// like the backend died.
const apiProxy = {
  // The frontend always calls /api/... - never a hardcoded IP.
  '/api': {
    target: BACKEND_URL,
    changeOrigin: true,
    secure: false,
  },
};

/** True for a real Wi-Fi address. Excludes link-local and the 100.64/10 CGNAT block,
 *  where Tailscale lives - a phone that is not on that tailnet cannot load it. */
function isReachableLanIp(ip: string): boolean {
  if (ip.startsWith('169.254.')) return false;
  return !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
}

/** First non-internal IPv4 address, preferring private LAN ranges. Null when offline.
 *  LAN_IP overrides detection - docker/compose.yaml sets it, because inside a container
 *  the only address Vite can see is the 172.x bridge one, which no phone can reach. */
function lanAddress(): string | null {
  const forced = (process.env.LAN_IP ?? '').trim();
  if (forced) {
    // Never encode an override that cannot work into the QR: an unscannable-in-practice
    // code costs more time than no code, because it looks like it should have worked.
    if (isReachableLanIp(forced)) return forced;
    console.log(`\n  LAN_IP=${forced} is link-local or CGNAT - a phone cannot reach it. Detecting instead.`);
  }

  const candidates: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (!isReachableLanIp(address.address)) continue;
      candidates.push(address.address);
    }
  }
  const private4 = candidates.find(
    (ip) =>
      ip.startsWith('192.168.') ||
      ip.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(ip),
  );
  return private4 ?? candidates[0] ?? null;
}

/** Prints the phone-reachable https URL and a scannable QR code after Vite's own banner. */
function lanQrCode(): Plugin {
  return {
    name: 'lan-qr-code',
    apply: 'serve',
    configureServer(server) {
      const printUrls = server.printUrls.bind(server);
      server.printUrls = () => {
        printUrls();

        // The one-command launcher prints its own QR before Vite starts; NO_QR stops
        // the terminal filling with two of them. Plain `npm run dev` always prints.
        if (process.env.NO_QR) return;

        const host = lanAddress();
        if (!host) {
          console.log('\n  No LAN address found - is Wi-Fi on? Phones cannot reach this.\n');
          return;
        }

        const address = server.httpServer?.address();
        const port = typeof address === 'object' && address !== null ? address.port : PORT;
        const secure = Boolean(server.config.server.https);
        const url = `${secure ? 'https' : 'http'}://${host}:${port}/`;

        console.log(`\n  Phone on the same Wi-Fi:  ${url}`);
        if (secure) {
          // basic-ssl signs for localhost / 127.0.0.1 only - never for this LAN IP - so
          // the phone always warns about the name. That is expected, not a broken setup.
          console.log('  Cert warning is normal (it is signed for localhost, not this IP).');
          console.log('  iOS Safari: Show Details -> visit this website. Chrome: Advanced -> Proceed.');
        } else {
          console.log('  WARNING: http, not https. Camera, mic and motion sensors will NOT');
          console.log('  work on the phone - navigator.mediaDevices is undefined on an');
          console.log('  insecure origin. Put basicSsl() back in the plugins array.');
        }
        console.log('');
        qrcodeTerminal.generate(url, { small: true });
      };
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), basicSsl(), lanQrCode()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // host:true binds 0.0.0.0 so phones on the LAN can connect.
    // No allowedHosts entry is needed: Vite skips its host check entirely while https
    // is on, so a LAN IP, a machine.local name and a tunnel hostname all work.
    host: true,
    port: PORT,
    strictPort: false,
    proxy: apiProxy,
  },
  // `npm run preview` serves the built bundle - same LAN binding, same /api proxy.
  preview: {
    host: true,
    port: PREVIEW_PORT,
    strictPort: false,
    proxy: apiProxy,
  },
});
