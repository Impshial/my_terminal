import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import type { Preferences, ShellOption } from '../shared/schema';
const exec = promisify(execFile);
async function isFile(file: string) {
  try {
    await access(file, constants.F_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
async function locate(override: string, candidates: string[]) {
  if (override) return (await isFile(override)) ? override : '';
  for (const c of candidates) if (await isFile(c)) return c;
  return '';
}
function onPath(exe: string) {
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((p) => path.join(p.replace(/^"|"$/g, ''), exe));
}
export async function discoverShells(preferences: Preferences): Promise<ShellOption[]> {
  const windows = process.env.SystemRoot ?? 'C:\\Windows';
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const overrides = preferences.shellPaths;
  const definitions: [string, string, string[], string[], string][] = [
    [
      'pwsh',
      'PowerShell 7',
      [path.join(pf, 'PowerShell', '7', 'pwsh.exe'), ...onPath('pwsh.exe')],
      ['-NoLogo'],
      'Install PowerShell 7 from Microsoft, or set its executable path in Settings.',
    ],
    [
      'powershell',
      'Windows PowerShell',
      [path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
      ['-NoLogo'],
      'Set the Windows PowerShell executable path in Settings.',
    ],
    [
      'cmd',
      'Command Prompt',
      [path.join(windows, 'System32', 'cmd.exe')],
      [],
      'Set cmd.exe in Settings.',
    ],
    [
      'gitbash',
      'Git Bash',
      [
        path.join(pf, 'Git', 'bin', 'bash.exe'),
        path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'Programs', 'Git', 'bin', 'bash.exe'),
      ],
      ['--login', '-i'],
      'Install Git for Windows, or select its bin\\bash.exe in Settings.',
    ],
  ];
  const shells = await Promise.all(
    definitions.map(async ([id, name, candidates, args, reason]) => {
      const executable = await locate(overrides[id as keyof typeof overrides], candidates);
      return {
        id,
        name,
        executable,
        args,
        available: !!executable,
        reason: executable ? undefined : reason,
      };
    }),
  );
  const wsl = await locate(overrides.wsl, [path.join(windows, 'System32', 'wsl.exe')]);
  let distros: string[] = [];
  let wslStatus = { ok: true, output: '' };
  let wslVersions = '';
  if (wsl) {
    const readWsl = async (args: string[]) => {
      const decode = (b: Buffer | undefined) =>
        b ? b.toString(b.includes(0) ? 'utf16le' : 'utf8').replace(/\u0000|\uFEFF/g, '') : '';
      try {
        const result = await exec(wsl, args, {
          encoding: 'buffer',
          timeout: 6000,
          windowsHide: true,
          maxBuffer: 65536,
        });
        return { ok: true, output: decode(result.stdout as Buffer) };
      } catch (error: any) {
        return { ok: false, output: decode(error.stdout) || decode(error.stderr) };
      }
    };
    const [status, versions] = await Promise.all([
      readWsl(['--status']),
      readWsl(['--list', '--verbose']),
    ]);
    wslStatus = status;
    wslVersions = versions.output;
    try {
      const result = await exec(wsl, ['--list', '--quiet'], {
        encoding: 'buffer',
        timeout: 6000,
        windowsHide: true,
        maxBuffer: 65536,
      });
      const b = result.stdout as Buffer;
      distros = b
        .toString(b.includes(0) ? 'utf16le' : 'utf8')
        .replace(/\u0000|\uFEFF/g, '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(s));
    } catch {
      /* WSL may exist without an enabled feature or distribution. */
    }
  }
  if (distros.length)
    for (const distro of distros) {
      const row = wslVersions
        .split(/\r?\n/)
        .map((line) =>
          line
            .replace(/^\s*\*?/, '')
            .trim()
            .split(/\s+/),
        )
        .find((parts) => parts[0] === distro);
      // A registered WSL 2 distribution may still be unusable if its kernel is missing.
      // WSL 1 remains available even when WSL 2 reports a setup problem.
      const unavailable = row?.at(-1) === '2' && !wslStatus.ok;
      shells.push({
        id: `wsl:${distro}`,
        name: `${distro} — Local Bash`,
        executable: wsl,
        args: ['--distribution', distro, '--cd', '~', '--exec', 'bash', '-l'],
        available: !unavailable,
        reason: unavailable
          ? `WSL 2 needs setup. ${
              wslStatus.output
                .split(/\r?\n/)
                .filter((line) => line.trim())
                .at(-1)
                ?.trim()
                .slice(0, 220) ?? 'Run wsl --status in Windows PowerShell for details.'
            } After repairing WSL, refresh Settings.`
          : undefined,
      });
    }
  else
    shells.push({
      id: 'wsl',
      name: 'WSL Bash',
      executable: wsl,
      args: [],
      available: false,
      reason:
        'No WSL distributions detected. Enable WSL and install a distribution yourself, then refresh Settings.',
    });
  return shells;
}
