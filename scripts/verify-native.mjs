import { createRequire } from 'node:module';
import { access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import electron from 'electron';
const require = createRequire(import.meta.url);
if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Package MyTerminal on Windows x64.');
const directory = path.dirname(require.resolve('node-pty/package.json'));
for (const file of [
  'conpty.node',
  'conpty_console_list.node',
  'conpty/conpty.dll',
  'conpty/OpenConsole.exe',
])
  await access(path.join(directory, 'prebuilds/win32-x64', file));
// node-pty 1.1 ships Node-API prebuilds, compatible across Node/Electron ABIs.
// Validate in the exact Electron runtime rather than rebuilding them needlessly.
const result = spawnSync(
  electron,
  [
    '-e',
    `require('node-pty'); console.log('node-pty loaded in Electron ' + process.versions.electron)`,
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    windowsHide: true,
  },
);
if (result.status !== 0)
  throw new Error(result.stderr || result.error?.message || 'Native module verification failed.');
process.stdout.write(result.stdout);
