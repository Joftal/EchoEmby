// The built app, launched the one way that survives the caller's environment.
//
// `npm start` was a bare `electron .`, which inherits whatever the shell has set — and
// ELECTRON_RUN_AS_NODE is the one variable that changes what the binary *is*: set to anything truthy,
// electron.exe runs as a plain node process, `require('electron')` hands back the path to the exe instead
// of the module, and dist/main/index.cjs dies on its first line with
// "TypeError: Cannot read properties of undefined (reading 'getAppPath')" — which reads like a broken
// build, not like a broken terminal. Measured 2026-10-28: reproduced from a shell that had it set
// (ELECTRON_RUN_AS_NODE=1 npm start), and that is what a GUI-hosted terminal hands to its children, since
// an Electron app exports the variable for the node processes it spawns.
//
// So the variable is dropped here, once, for the app's own process. Everything else in the environment is
// passed through untouched. The binary is the one npm installed rather than the `electron.cmd` shim, so
// nothing is launched through a shell: with `shell: true` node warns about unescaped arguments on every
// start (DEP0190) and the shell would add a level of quoting between the caller and the app.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const cmd = existsSync(exe) ? exe : path.join(root, 'node_modules', '.bin', 'electron.cmd');

const child = spawn(cmd, ['.'], {
  cwd: root,
  env,
  stdio: 'inherit',
  shell: !existsSync(exe),
});

child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
