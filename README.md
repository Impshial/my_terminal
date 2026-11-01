# MyTerminal

A standalone Windows 10/11 x64 desktop app with real local terminals and SSH sessions inside its own window. Launch **MyTerminal.exe** or use the installed Start menu shortcut; an external terminal is not required.

## Install and launch

Build artifacts are written to `release/`:

- `MyTerminal-0.1.0-x64-setup.exe`: per-user installer with a Start menu shortcut and optional desktop shortcut.
- `MyTerminal-0.1.0-x64-portable.exe`: portable launcher.
- `win-unpacked/MyTerminal.exe`: unpacked application, with its adjacent runtime files.

The app runs as your normal Windows user. This initial build is unsigned; Windows may show publisher/reputation prompts. Do not disable Windows protections. The installer and portable launcher do not require an external terminal or a Node.js installation.

## Use

MyTerminal opens PowerShell 7 when installed, otherwise Windows PowerShell. The **+** immediately after the tabs opens local shells and SSH profiles. Each tab owns an independent process or SSH connection; switching tabs retains its output, scroll position, and working directory. Double-click a tab to rename it.

Each tab has its own connection bar. **Connect** changes that tab only, asks before replacing an active session, and keeps the existing session if the new connection fails. Input pauses during the transition. Disconnect keeps output read-only; reconnect starts a fresh remote shell. No commands are replayed. Use tmux or screen on a remote server for persistent jobs.

### Appearance

App and terminal appearance are independent and saved between launches:

- **View → Light mode**: checked for light app chrome, unchecked for dark. This affects the menus, tabs, connection bars, and dialogs, not terminal content.
- **View → Terminal Mode → PowerShell**: **default**, blue background, light text, Consolas.
- **View → Terminal Mode → Command Window**: black background, white text, Consolas.
- **View → Terminal Mode → 1970’s Screen**: black background, green palette, Courier New, block cursor.

These are visual styles; changing one does not change the shell or destination. Programs can still emit ANSI colors. Font size and scrollback are adjustable in Settings. The active terminal mode has a checkmark in the flyout.

### Local shells

PowerShell 7, Windows PowerShell, Command Prompt, installed WSL distributions, and Git Bash are discovered locally. Settings lets you correct executable paths. Unavailable optional shells show setup guidance. WSL tabs run Bash in the chosen distribution; Git Bash uses its own login shell. Every new local tab starts in your user directory (WSL uses its Linux home).

MyTerminal never installs optional shells, enables Windows features, changes PowerShell execution policy, adds bypass flags, opens firewall ports, or changes Defender settings.

### SSH and RunPod

Enter the exact hostname, port, username, and authentication details supplied by your server provider. RunPod direct SSH and proxied usernames work through the same form; no RunPod account integration is required. Do not paste a full `ssh` command into a field.

Password authentication and private-key files, including encrypted keys, are supported. Private keys stay in their original files. The default server shell is used unless you supply an explicit absolute POSIX shell path. Explicit shell selection requires a POSIX-compatible server and checks that the executable exists before replacing a session.

Save profiles from the connection dialog or **File → Manage Connections**. Profiles can be edited, renamed, deleted, and optionally connected on startup. Changes apply to future connections. Deleting a profile does not interrupt existing tabs. If a startup connection needs credentials, use its Connect button. Startup host-key changes are rejected.

Verify the displayed SHA256 host-key fingerprint through a trusted source before accepting an unknown host. Changed keys require deliberate manual review. Saving a password or passphrase is optional and explicit; stored secrets are encrypted using Electron safeStorage backed by Windows protection. Secrets never go back to the renderer. Windows account protection is not a defense against other software running as the same user. **Forget credential** removes a saved secret.

### Shortcuts

| Action                           | Shortcut                    |
| -------------------------------- | --------------------------- |
| New tab menu                     | Ctrl+Shift+T                |
| Close tab                        | Ctrl+Shift+W                |
| Connect active tab               | Ctrl+Shift+O                |
| Copy / paste                     | Ctrl+Shift+C / Ctrl+Shift+V |
| Find output                      | Ctrl+Shift+F                |
| Settings                         | Ctrl+,                      |
| Increase / decrease / reset font | Ctrl+= / Ctrl+- / Ctrl+0    |
| Fullscreen                       | F11                         |
| Interrupt foreground command     | Ctrl+C                      |

Multiline paste and closing active sessions ask for confirmation by default. Foreground job detection is not reliable across all supported shells, so close confirmation is conservative and configurable. Clear Scrollback clears displayed history only.

## Develop and package

Use Windows x64, Node.js 22 or newer, and pnpm 11.25.0. The lockfile pins the dependency graph. If native rebuilds are needed, install Visual Studio 2022 C++ build tools, its x64 Spectre-mitigated libraries, and Python. These are development prerequisites, not end-user requirements.

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm dev

pnpm build
pnpm test:desktop
pnpm package
node scripts/desktop-test.mjs --packaged
```

`pnpm dev` builds and opens the desktop app; restart after source edits. `pnpm verify:native` loads node-pty in the exact Electron runtime. This Windows x64 build uses node-pty 1.1's shipped, ABI-stable Node-API binaries, so packaging skips unnecessary source rebuilds and unpacks its native binaries and ConPTY helpers. `pnpm rebuild` is an optional source rebuild and needs the complete C++/Spectre toolchain. SSH's native acceleration is optional; ssh2 retains its JavaScript fallback.

Desktop tests launch hidden windows, use isolated user-data directories under ignored `test-results/`, and generate screenshots. They use actual Windows PTYs and a loopback-only SSH protocol fixture. Native confirmation dialogs are stubbed in that test process. Unit lifecycle tests inject fake transports; they are not SSH integration tests.

If a development environment rewrites ACLs and Electron reports that its runtime directory is inaccessible to AppContainer processes, run validation outside that tool's filesystem sandbox. Preserve Electron's renderer sandbox. Ordinary installed Windows applications do not depend on Codex.

## Architecture and storage

Electron's privileged main process owns PTYs, SSH clients, credential storage, host trust, native menus, and validated IPC. The sandboxed renderer uses React and xterm.js with no Node integration. Navigation, new windows, permissions, webviews, and remote clipboard escape sequences are blocked. There is no network control endpoint.

Session generation IDs reject stale input when destinations change. Output uses high/low-watermark backpressure, bounded scrollback, and a hard safety cap. Background tabs remain mounted. Window close cleans up owned sessions; it does not issue commands to stop a RunPod instance.

Versioned configuration is atomically written to `%APPDATA%\MyTerminal\config.json`. Invalid configurations are preserved with a timestamp and replaced in memory with safe defaults. Profiles, known host fingerprints, encrypted credentials, preferences, and window bounds stay out of the install directory and source tree. `MYTERMINAL_TEST_DATA` and `MYTERMINAL_TEST_HIDDEN` are only test-launch overrides.

## Validation and limits

See [validation notes](docs/VALIDATION.md) for actual results and the remaining manual checks. Keyboard-interactive MFA, SSH agents, jump hosts, file transfer, split panes, session restoration, and automatic SSH reconnection are outside this initial scope. Remote shell recovery is not claimed. WSL and Git Bash require their own installations.

Upstream references: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage), [node-pty](https://github.com/microsoft/node-pty), [ssh2](https://github.com/mscdex/ssh2), and [xterm flow control](https://xtermjs.org/docs/guides/flowcontrol/).
