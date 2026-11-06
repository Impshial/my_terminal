# Validation

Validation is performed on Windows 10 x64. Run the commands in the README to repeat it. The current desktop tests produce machine-readable results and screenshots under `test-results/desktop/` and `test-results/packaged/`.

## Automated checks

- TypeScript checks and production renderer/main/preload builds.
- 18 focused tests: injected-transport lifecycle, tab ownership and isolation, cancellation, stale input, output backpressure, atomic profile persistence, credential binding, recovery from invalid settings, and schema validation.
- Real loopback SSH connections: two independent sessions on the same endpoint, a second endpoint, password and encrypted-private-key authentication, wrong passwords/passphrases, rejected fingerprints, unavailable explicit shells, resize requests, interruptions, and unreachable destinations. The fixture echoes data; it is not a remote operating-system shell.
- Desktop integration: real PowerShell 7, Windows PowerShell, Command Prompt, and Git Bash PTYs; independent working directories and retained output; actual Ctrl+C interruption; tab rename/close; terminal search and multiline paste; runtime renderer security settings; separate Light mode and all three Terminal Mode choices; profile and appearance persistence across restart.
- Desktop SSH integration: actual loopback authentication, DPAPI-backed safeStorage encryption, reconnect using the saved credential after restart, changed-host-key rejection during automatic connection, failed session replacement preserving the existing local PTY, and blocked OSC 52 clipboard writes. Native consent dialogs are deliberately stubbed only inside the test process.
- Terminal layout regression (`pnpm test:layout`): fills a real PowerShell viewport and checks that the last prompt, cursor, and full terminal grid fit above the status bar. Covers 20 layouts across all three terminal modes, both app themes, 9/14/32px fonts, 760×500 through 1200×780 windows, and opening/closing search. Results and screenshots are saved in `test-results/layout/` (or `layout-packaged/` with `--packaged`).

Version 0.1.1 fixes terminal clipping caused by counting the terminal host's padding as usable row/column space. The regression failed on 0.1.0: the bottom row extended 8px into the status bar. The host now uses content-box sizing so xterm's FitAddon receives the actual available content dimensions. All 20 layout cases passed against both the development build and the packaged 0.1.1 executable.

The desktop suite runs against both development files and `release/win-unpacked/MyTerminal.exe`. The Windows installer and portable wrapper are separate output artifacts. Installer wizard installation/uninstallation, Windows 11, and real external SSH/RunPod hosts require the manual checks below.

On this host, Ubuntu is registered but its distribution directory is missing, and `wsl --status` also reports a missing WSL 2 kernel. Starting Bash directly fails. WSL execution therefore remains unverified. MyTerminal checks the registration paths and WSL status, disabling affected entries with setup guidance. It does not install or repair WSL automatically.

## Remaining manual checks

1. On a clean Windows 10/11 account, install the setup executable, start it from the Start menu with no network, and confirm a usable local PowerShell. Also launch the portable executable directly. Keep normal Windows security settings enabled.
2. Confirm both native View menu checkmarks persist: Light mode applies only to the app; PowerShell, Command Window, and 1970’s Screen change terminal appearance without replacing the shell.
3. Use the actual SSH dialog with an external server and a RunPod destination. Independently verify the displayed host-key fingerprints. Exercise both password and encrypted-key authentication and a custom port/proxied username.
4. Open two sessions on one real host and one on a second host. Disconnect one, interrupt the network, and confirm all affected tabs accurately report their state while local terminals remain usable. Reconnect must start a fresh shell without replaying commands.
5. Run an interactive editor/monitor on a real remote host, exercise Unicode and terminal resizing, and verify multiline paste confirmation. Try an unavailable remote shell and confirm the previous session survives.
6. If WSL is installed, open its distribution from + and run Bash commands. `node scripts/desktop-test.mjs --packaged --wsl` also exercises discovered WSL distributions. Missing WSL/Git Bash options should explain setup; override paths in Settings when needed.
7. Verify the real unknown/changed-key dialogs and active-session close confirmations manually. The automated suite tests the decisions and outcomes with native dialog responses stubbed.

## Build observations

The first development launch encountered Codex workspace ACLs incompatible with Electron's AppContainer access check. Validation runs outside that filesystem sandbox while retaining Electron's renderer sandbox. No `--no-sandbox` flag or security-policy bypass is used.

An unnecessary node-pty source rebuild encountered missing Visual Studio Spectre libraries. Packaging now verifies the upstream Windows x64 Node-API prebuilt modules inside the exact Electron runtime and ships them with ConPTY helpers. A source rebuild remains optional and requires the complete toolchain. The build is unsigned because no signing certificate was provided.
