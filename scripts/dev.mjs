import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = 5173;

// The same variable `start.mjs` drops, for the same reason: with ELECTRON_RUN_AS_NODE set, electron.exe
// runs as plain node and the app dies on `app.getAppPath()`. A dev shell is exactly where it is set.
const baseEnv = { ...process.env };
delete baseEnv.ELECTRON_RUN_AS_NODE;

const run = (cmd, args, env = {}) =>
  spawn(cmd, args, { cwd: root, env: { ...baseEnv, ...env }, stdio: 'inherit', shell: process.platform === 'win32' });

const waitForPort = (port, ms = 30000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const probe = () => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() - t0 > ms) reject(new Error(`dev server did not open :${port}`));
        else setTimeout(probe, 200);
      });
    };
    probe();
  });

const vite = run(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort']);
await waitForPort(PORT);
console.log(`vite dev on :${PORT}`);

const electron = run(path.join(root, 'node_modules', '.bin', 'electron.cmd'), ['.'], {
  VITE_DEV_URL: `http://127.0.0.1:${PORT}`,
  ELECTRON_ENABLE_LOGGING: '1',
});

const stop = () => { vite.kill(); electron.kill(); };
process.on('SIGINT', stop);
electron.on('exit', code => { stop(); process.exit(code ?? 0); });
