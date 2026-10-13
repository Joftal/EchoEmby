import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, mkdirSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = fileURLToPath(new URL('..', import.meta.url));
const dest = path.join(root, 'resources', 'mpv');
const exe = path.join(dest, 'mpv.exe');

if (existsSync(exe)) {
  console.log('mpv already present:', exe);
  process.exit(0);
}

// GitHub's release asset host is unreachable from this machine without the local
// proxy, so curl is invoked through it (same finding as for the Emby server).
const PROXY = process.env.ECHOEMBY_PROXY || 'http://127.0.0.1:7899';
const API = 'https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest';

const curl = (args) => spawnSync('curl.exe', ['-sSL', '--max-time', '120', '--proxy', PROXY, ...args], { encoding: 'utf8' });

const rel = JSON.parse(curl([API]).stdout || '{}');
const asset = (rel.assets || []).find(a => /^mpv-x86_64.*\.zip$/.test(a.name));
if (!asset) {
  console.error('Could not resolve a portable mpv zip from', API);
  console.error('Download one from https://sourceforge.net/projects/mpv-player-windows/files/ and unzip into', dest);
  process.exit(1);
}

const tmp = path.join(os.tmpdir(), 'echoemby-mpv');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const zip = path.join(tmp, asset.name);
console.log('fetching', asset.name);
const dl = curl(['-o', zip, asset.browser_download_url]);
if (dl.status !== 0) { console.error('download failed', dl.stderr); process.exit(1); }

const unzipDir = path.join(tmp, 'x');
const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${unzipDir}' -Force`], { encoding: 'utf8' });
if (ps.status !== 0) { console.error('extract failed', ps.stderr); process.exit(1); }

// archives nest the binaries under <mpv-build>/mpv-*/bin
const walk = (dir, depth = 0) => {
  if (depth > 3) return null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'bin' && existsSync(path.join(p, 'mpv.exe'))) return p;
      const hit = walk(p, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
};
const bin = walk(unzipDir);
if (!bin) { console.error('mpv.exe not found inside archive'); process.exit(1); }
mkdirSync(dest, { recursive: true });
for (const f of readdirSync(bin)) renameSync(path.join(bin, f), path.join(dest, f));
rmSync(tmp, { recursive: true, force: true });
console.log('installed ->', dest);
