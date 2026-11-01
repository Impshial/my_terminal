import { useEffect, useRef, useState, type ReactNode } from 'react';
import { profileSchema, type Preferences, type Profile, type ShellOption } from '../shared/schema';

export function Modal({
  title,
  subtitle,
  children,
  close,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? 'modal wide' : 'modal'}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <header>
        <div>
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button className="icon-button" aria-label="Close dialog" onClick={close}>
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function freshProfile(): Profile {
  return {
    id: crypto.randomUUID(),
    name: '',
    host: '',
    port: 22,
    username: '',
    auth: 'key',
    keyPath: '',
    remoteShell: '',
    autoConnect: false,
  };
}
export type ConnectionInput = {
  profile: Profile;
  secret?: string;
  saveProfile: boolean;
  saveSecret: boolean;
};
export function ConnectionDialog({
  profiles,
  initial,
  editing,
  target,
  submit,
  close,
}: {
  profiles: Profile[];
  initial?: Profile;
  editing?: boolean;
  target?: string;
  submit: (input: ConnectionInput) => Promise<void>;
  close: () => void;
}) {
  const [profile, setProfile] = useState<Profile>(() =>
    initial ? { ...initial } : freshProfile(),
  );
  const [secret, setSecret] = useState('');
  const [saveProfile, setSave] = useState(!!initial || !!editing);
  const [saveSecret, setSaveSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const patch = <K extends keyof Profile>(key: K, value: Profile[K]) =>
    setProfile((p) => ({ ...p, [key]: value }));
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const result = profileSchema.safeParse(profile);
    if (!result.success) {
      setError(result.error.issues.map((i) => i.message).join(' '));
      return;
    }
    setBusy(true);
    const transient = secret;
    setSecret('');
    try {
      await submit({
        profile: result.data,
        secret: transient || undefined,
        saveProfile: editing || saveProfile,
        saveSecret,
      });
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to connect.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={editing ? 'Connection profile' : 'Connect with SSH'}
      subtitle={
        editing
          ? 'Saved settings are used for future connections.'
          : `Destination for ${target ?? 'a new terminal tab'}`
      }
      close={() => {
        if (!busy) {
          setSecret('');
          close();
        }
      }}
    >
      <form onSubmit={onSubmit}>
        <fieldset disabled={busy}>
          {!editing && (
            <label>
              Saved connection
              <select
                aria-label="Saved connection"
                value={profiles.some((p) => p.id === profile.id) ? profile.id : ''}
                onChange={(e) => {
                  setProfile({
                    ...(profiles.find((p) => p.id === e.target.value) ?? freshProfile()),
                  });
                  setSecret('');
                  setSaveSecret(false);
                  setSave(!!e.target.value);
                }}
              >
                <option value="">New connection</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Profile name
            <input
              autoFocus
              value={profile.name}
              placeholder="e.g. RunPod workspace"
              maxLength={80}
              onChange={(e) => patch('name', e.target.value)}
              required
            />
          </label>
          <div className="field-row host">
            <label>
              Hostname or IP
              <input
                value={profile.host}
                placeholder="ssh.example.com"
                onChange={(e) => patch('host', e.target.value)}
                required
                spellCheck={false}
              />
            </label>
            <label>
              Port
              <input
                type="number"
                min="1"
                max="65535"
                value={profile.port}
                onChange={(e) => patch('port', Number(e.target.value))}
                required
              />
            </label>
          </div>
          <label>
            Username
            <input
              value={profile.username}
              placeholder="Your SSH username"
              onChange={(e) => patch('username', e.target.value)}
              required
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="segmented" aria-label="Authentication method">
            <button
              type="button"
              className={profile.auth === 'key' ? 'selected' : ''}
              onClick={() => {
                patch('auth', 'key');
                setSecret('');
              }}
            >
              Private key
            </button>
            <button
              type="button"
              className={profile.auth === 'password' ? 'selected' : ''}
              onClick={() => {
                patch('auth', 'password');
                setSecret('');
              }}
            >
              Password
            </button>
          </div>
          {profile.auth === 'key' && (
            <label>
              Private key file
              <div className="input-with-button">
                <input
                  value={profile.keyPath}
                  placeholder="C:\\Users\\you\\.ssh\\id_ed25519"
                  onChange={(e) => patch('keyPath', e.target.value)}
                  required
                />
                <button
                  type="button"
                  onClick={() =>
                    void window.myterminal
                      .browseKey()
                      .then((p) => {
                        if (p) patch('keyPath', p);
                      })
                      .catch((e) => setError(e.message))
                  }
                >
                  Browse…
                </button>
              </div>
            </label>
          )}
          {!editing && (
            <label>
              {profile.auth === 'key' ? 'Key passphrase (if needed)' : 'Password'}
              <input
                type="password"
                value={secret}
                autoComplete="off"
                placeholder="Leave blank to use a saved credential"
                onChange={(e) => setSecret(e.target.value)}
              />
            </label>
          )}
          <details>
            <summary>Startup and remote shell</summary>
            <label>
              Remote shell path
              <input
                value={profile.remoteShell}
                placeholder="Server default (recommended)"
                onChange={(e) => patch('remoteShell', e.target.value)}
              />
              <span className="hint">
                Optional absolute POSIX path, such as /bin/zsh. The server’s default shell is used
                when empty.
              </span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={profile.autoConnect}
                onChange={(e) => patch('autoConnect', e.target.checked)}
              />
              Connect automatically when MyTerminal starts
            </label>
          </details>
          {!editing && (
            <div className="checks">
              <label className="check">
                <input
                  type="checkbox"
                  checked={saveProfile}
                  onChange={(e) => {
                    setSave(e.target.checked);
                    if (!e.target.checked) setSaveSecret(false);
                  }}
                />
                Save connection profile
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  disabled={!saveProfile}
                  checked={saveSecret}
                  onChange={(e) => setSaveSecret(e.target.checked)}
                />
                Save credential with Windows protection
              </label>
            </div>
          )}
        </fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <p className="security-note">
          ◇ New SSH host keys require your approval. Private keys stay in their original files.
        </p>
        <footer>
          <button type="button" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Connecting…' : editing ? 'Save profile' : 'Connect'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function ManageDialog({
  profiles,
  close,
  edit,
  refresh,
  error,
}: {
  profiles: Profile[];
  close: () => void;
  edit: (profile?: Profile) => void;
  refresh: () => Promise<void>;
  error: (message: string) => void;
}) {
  return (
    <Modal
      title="Saved connections"
      subtitle="Reusable profiles. Each tab gets an independent session."
      close={close}
      wide
    >
      <div className="profiles">
        {!profiles.length && (
          <div className="empty-inline">
            No saved connections yet.
            <br />
            <span>Add your first SSH destination to make it available in every tab.</span>
          </div>
        )}
        {profiles.map((p) => (
          <div className="profile-row" key={p.id}>
            <span className="profile-icon">↗</span>
            <div>
              <strong>{p.name}</strong>
              <p>
                {p.username}@{p.host}:{p.port}
              </p>
              {p.autoConnect && <small>Connects on startup</small>}
            </div>
            <button onClick={() => edit(p)}>Edit</button>
            <button
              onClick={() =>
                void window.myterminal
                  .forgetSecret(p.id)
                  .then(() => error('Saved credential removed.'))
                  .catch((e) => error(e.message))
              }
            >
              Forget credential
            </button>
            <button
              className="danger-text"
              onClick={() =>
                void window.myterminal
                  .deleteProfile(p.id)
                  .then(refresh)
                  .catch((e) => error(e.message))
              }
            >
              Delete
            </button>
          </div>
        ))}
      </div>
      <footer>
        <button onClick={close}>Done</button>
        <button className="primary" onClick={() => edit()}>
          + Add connection
        </button>
      </footer>
    </Modal>
  );
}
export function SettingsDialog({
  preferences,
  shells,
  save,
  close,
}: {
  preferences: Preferences;
  shells: ShellOption[];
  save: (p: Preferences) => Promise<void>;
  close: () => void;
}) {
  const [value, setValue] = useState(() => structuredClone(preferences));
  useEffect(() => {
    setValue((current) => ({
      ...current,
      appTheme: preferences.appTheme,
      terminalTheme: preferences.terminalTheme,
      terminalFont: preferences.terminalFont,
    }));
  }, [preferences.appTheme, preferences.terminalTheme, preferences.terminalFont]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Settings" subtitle="Your terminals, your preferences." close={close} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void save(value)
            .then(close)
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <fieldset disabled={busy}>
          <h2>Terminal</h2>
          <div className="field-row">
            <label>
              Font size
              <input
                type="number"
                min="9"
                max="32"
                value={value.fontSize}
                onChange={(e) => setValue({ ...value, fontSize: +e.target.value })}
              />
            </label>
            <label>
              Scrollback lines
              <input
                type="number"
                min="100"
                max="100000"
                value={value.scrollback}
                onChange={(e) => setValue({ ...value, scrollback: +e.target.value })}
              />
            </label>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={value.confirmClose}
              onChange={(e) => setValue({ ...value, confirmClose: e.target.checked })}
            />
            Confirm before closing or disconnecting active sessions
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={value.confirmMultilinePaste}
              onChange={(e) => setValue({ ...value, confirmMultilinePaste: e.target.checked })}
            />
            Confirm pastes containing multiple lines
          </label>
          <h2>Local shell paths</h2>
          <p className="hint">
            Leave blank for automatic discovery. Enter the full path to an executable. Changes apply
            to new sessions.
          </p>
          {Object.entries({
            pwsh: 'PowerShell 7',
            powershell: 'Windows PowerShell',
            cmd: 'Command Prompt',
            wsl: 'WSL',
            gitbash: 'Git Bash',
          }).map(([key, label]) => (
            <label className="shell-setting" key={key}>
              {label}
              <input
                value={value.shellPaths[key as keyof typeof value.shellPaths]}
                placeholder="Discover automatically"
                onChange={(e) =>
                  setValue({ ...value, shellPaths: { ...value.shellPaths, [key]: e.target.value } })
                }
              />
            </label>
          ))}
          <details>
            <summary>Detected shells</summary>
            {shells.map((s) => (
              <p className="hint" key={s.id}>
                {s.available ? '✓' : '–'} {s.name}: {s.available ? s.executable : s.reason}
              </p>
            ))}
          </details>
        </fieldset>
        {error && <p className="error">{error}</p>}
        <footer>
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            Save and refresh shells
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function RenameDialog({
  title,
  submit,
  close,
}: {
  title: string;
  submit: (title: string) => Promise<void>;
  close: () => void;
}) {
  const [value, setValue] = useState(title);
  const [error, setError] = useState('');
  return (
    <Modal title="Rename terminal" close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(value.trim())
            .then(close)
            .catch((e) => setError(e.message));
        }}
      >
        <label>
          Tab title
          <input
            autoFocus
            value={value}
            maxLength={80}
            required
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <footer>
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button className="primary">Rename</button>
        </footer>
      </form>
    </Modal>
  );
}
export function HelpDialog({
  kind,
  version,
  close,
}: {
  kind: 'help' | 'shortcuts' | 'about';
  version: string;
  close: () => void;
}) {
  return (
    <Modal
      title={
        kind === 'about'
          ? 'MyTerminal'
          : kind === 'shortcuts'
            ? 'Keyboard shortcuts'
            : 'Local shells and SSH'
      }
      subtitle={kind === 'about' ? `Version ${version} · Windows desktop terminal` : undefined}
      close={close}
      wide
    >
      <div className="help-content">
        {kind === 'about' ? (
          <>
            <div className="about-mark">&gt;_</div>
            <p>A home for your local shells and remote sessions.</p>
            <p>Built with Electron, React, xterm.js, node-pty, and ssh2.</p>
            <p className="hint">
              Settings are stored in %APPDATA%\MyTerminal. Passwords and passphrases are saved only
              with your permission and protected by Windows for your user account.
            </p>
          </>
        ) : kind === 'shortcuts' ? (
          <dl className="shortcuts">
            {[
              ['New tab menu', 'Ctrl + Shift + T'],
              ['Close active tab', 'Ctrl + Shift + W'],
              ['Connect active tab', 'Ctrl + Shift + O'],
              ['Copy selection', 'Ctrl + Shift + C'],
              ['Paste', 'Ctrl + Shift + V'],
              ['Find output', 'Ctrl + Shift + F'],
              ['Settings', 'Ctrl + ,'],
              ['Font size', 'Ctrl + / Ctrl −'],
              ['Reset font size', 'Ctrl + 0'],
              ['Fullscreen', 'F11'],
              ['Rename tab', 'Double-click tab'],
              ['Interrupt command', 'Ctrl + C'],
            ].map(([a, b]) => (
              <div key={a}>
                <dt>{a}</dt>
                <dd>
                  <kbd>{b}</kbd>
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <>
            <h2>Local shells work offline</h2>
            <p>
              MyTerminal starts PowerShell 7 when available and falls back to Windows PowerShell.
              Use + to open Command Prompt, Git Bash, or Bash in a specific WSL distribution. Every
              tab owns its own process and working directory.
            </p>
            <p>
              Install optional shells yourself from Microsoft (PowerShell / WSL) or Git for Windows.
              MyTerminal does not install Windows features or change execution policies. Set
              executable paths in Settings if discovery misses your installation.
            </p>
            <h2>Connect to any SSH server</h2>
            <p>
              Enter the hostname, port, exact username, and private key or password supplied by your
              server provider. For RunPod, use the direct or proxied SSH details it provides,
              including its custom port and complete username. Do not paste an entire SSH command
              into the host field.
            </p>
            <p>
              Compare the host-key fingerprint with a trusted source. A changed key is blocked
              during automatic startup; manually connect only after verifying the change.
            </p>
            <h2>Independent sessions</h2>
            <p>
              Disconnect keeps output read-only. Reconnect opens a fresh remote shell; it does not
              recover old jobs. Use tmux or screen on a server if you need persistent jobs. Closing
              MyTerminal does not send commands to stop a RunPod instance.
            </p>
            <p>
              The server’s default interactive shell is used. Explicit shell paths require a
              POSIX-compatible server. Keyboard-interactive MFA, SSH agents, jump hosts, and file
              transfer are not supported in this version.
            </p>
            <h2>Credentials and clipboard</h2>
            <p>
              Saving a credential is optional. Windows protection ties it to your Windows account;
              other software running as you may be able to decrypt it. Use Manage Connections to
              forget credentials. Private key files are referenced, never copied. Remote clipboard
              escape sequences are blocked.
            </p>
          </>
        )}
      </div>
      <footer>
        <button className="primary" onClick={close}>
          Done
        </button>
      </footer>
    </Modal>
  );
}
