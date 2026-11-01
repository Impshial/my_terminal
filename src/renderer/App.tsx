import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  preferencesSchema,
  type Action,
  type Bootstrap,
  type Preferences,
  type Profile,
  type Tab,
} from '../shared/schema';
import { Terminals } from './terminals';
import {
  ConnectionDialog,
  HelpDialog,
  ManageDialog,
  RenameDialog,
  SettingsDialog,
  type ConnectionInput,
} from './dialogs';

type Dialog =
  | { kind: 'connect'; id?: string; profile?: Profile }
  | { kind: 'edit'; profile?: Profile }
  | { kind: 'manage' | 'settings' | 'help' | 'shortcuts' | 'about' }
  | { kind: 'rename'; id: string; title: string };
const stateLabel = (tab: Tab) =>
  tab.pending
    ? tab.pending.startsWith('Reconnecting')
      ? 'Reconnecting'
      : 'Connecting'
    : {
        idle: 'Ready',
        running: 'Running',
        connected: 'Connected',
        disconnected: 'Disconnected',
        exited: `Exited${tab.exitCode !== undefined ? ` (${tab.exitCode})` : ''}`,
        error: 'Error',
      }[tab.state];
export function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap>();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState('');
  const [dialog, setDialog] = useState<Dialog>();
  const [menu, setMenu] = useState(false);
  const [notice, setNotice] = useState('');
  const [find, setFind] = useState(false);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState(true);
  const menuAnchor = useRef<HTMLDivElement>(null);
  const runtime = useRef<Terminals | null>(null);
  const activeRef = useRef('');
  const stateRef = useRef({ tabs, bootstrap, dialog });
  activeRef.current = active;
  stateRef.current = { tabs, bootstrap, dialog };
  const report = useCallback((message: string) => setNotice(message), []);
  const refresh = useCallback(async () => {
    const data = await window.myterminal.bootstrap();
    setBootstrap(data);
    runtime.current?.update(data.preferences);
  }, []);
  const run = (promise: Promise<unknown>) => void promise.catch((e) => report(e.message));
  const select = (id: string) => {
    flushSync(() => {
      setActive(id);
      setFind(false);
    });
    runtime.current?.focus(id);
  };
  async function newTab(shellId?: string) {
    setMenu(false);
    const tab = await window.myterminal.create();
    select(tab.id);
    if (shellId) await window.myterminal.local(tab.id, shellId);
    return tab.id;
  }
  async function savePreferences(preferences: Preferences) {
    await window.myterminal.preferences(preferences);
    await refresh();
  }
  const actionRef = useRef<(action: Action) => void>(() => {});
  actionRef.current = (action) => {
    if (action === 'refreshPreferences') {
      run(refresh());
      return;
    }
    const id = activeRef.current;
    if (stateRef.current.dialog) return;
    if (action === 'new') {
      setMenu((v) => !v);
      return;
    }
    if (action === 'connect') {
      setDialog({ kind: 'connect', id: id || undefined });
      return;
    }
    if (['manage', 'settings', 'help', 'shortcuts', 'about'].includes(action)) {
      setDialog({ kind: action as 'manage' });
      return;
    }
    if (action === 'close' && id) run(window.myterminal.close(id));
    if (action === 'copy' && id) run(runtime.current!.copy(id));
    if (action === 'paste' && id) run(runtime.current!.paste(id));
    if (action === 'selectAll' && id) runtime.current?.selectAll(id);
    if (action === 'clear' && id) runtime.current?.clear(id);
    if (action === 'find' && id) setFind((v) => !v);
    if (action.startsWith('zoom') && stateRef.current.bootstrap) {
      const p = stateRef.current.bootstrap.preferences;
      run(
        savePreferences({
          ...p,
          fontSize:
            action === 'zoomReset'
              ? 14
              : Math.max(9, Math.min(32, p.fontSize + (action === 'zoomIn' ? 1 : -1))),
        }),
      );
    }
  };
  useEffect(() => {
    let alive = true;
    runtime.current = new Terminals(preferencesSchema.parse({}), report);
    const stop = window.myterminal.onEvent((event) => {
      runtime.current?.event(event);
      if (event.type === 'tab') {
        flushSync(() =>
          setTabs((current) =>
            current.some((t) => t.id === event.tab.id)
              ? current.map((t) => (t.id === event.tab.id ? event.tab : t))
              : [...current, event.tab],
          ),
        );
      } else if (event.type === 'removed') {
        setTabs((current) => {
          const i = current.findIndex((t) => t.id === event.id);
          const next = current.filter((t) => t.id !== event.id);
          if (activeRef.current === event.id)
            setActive(next[Math.min(i, next.length - 1)]?.id ?? '');
          return next;
        });
      }
    });
    const stopActions = window.myterminal.onAction((action) => actionRef.current(action));
    void (async () => {
      const data = await window.myterminal.bootstrap();
      if (!alive) return;
      setBootstrap(data);
      runtime.current!.update(data.preferences);
      if (data.warning) report(data.warning);
      const preferred =
        data.shells.find((s) => s.id === 'pwsh' && s.available) ??
        data.shells.find((s) => s.id === 'powershell' && s.available) ??
        data.shells.find((s) => s.available);
      if (preferred) await newTab(preferred.id).catch((e) => report(e.message));
      else report('No local shell was found. Open Settings to correct executable paths.');
      for (const profile of data.profiles.filter((p) => p.autoConnect)) {
        const tab = await window.myterminal.create();
        void window.myterminal
          .connect({ id: tab.id, profile, saveProfile: false, saveSecret: false, automatic: true })
          .catch((e) =>
            report(
              `${profile.name}: ${e.message} Use Connect to enter credentials or review the host key.`,
            ),
          );
      }
    })().catch((e) => report(e.message));
    return () => {
      alive = false;
      stop();
      stopActions();
      runtime.current?.dispose();
    };
  }, [report]);
  useEffect(() => {
    if (active) requestAnimationFrame(() => runtime.current?.focus(active));
  }, [active]);
  useEffect(() => {
    if (!dialog && active) requestAnimationFrame(() => runtime.current?.focus(active));
  }, [dialog]);
  useEffect(() => {
    if (!menu) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [menu]);
  async function connect(input: ConnectionInput) {
    if (dialog?.kind === 'edit') {
      await window.myterminal.saveProfile(input.profile);
      await refresh();
      return;
    }
    const id = dialog?.kind === 'connect' && dialog.id ? dialog.id : await newTab();
    // Keep the same new tab when a failed attempt is retried.
    setDialog({ kind: 'connect', id, profile: input.profile });
    await window.myterminal.connect({ ...input, id, automatic: false });
    await refresh();
  }
  const current = tabs.find((t) => t.id === active);
  const localShells = bootstrap?.shells ?? [];
  const closeDialog = () => setDialog(undefined);
  return (
    <main>
      <nav className="tab-strip" aria-label="Terminal tabs">
        <div className="tab-scroll" role="tablist">
          {tabs.map((t) => (
            <div className={`tab ${active === t.id ? 'active' : ''}`} key={t.id}>
              <button
                className="tab-select"
                role="tab"
                aria-selected={active === t.id}
                aria-controls={`panel-${t.id}`}
                title={`${t.label}\nDouble-click to rename`}
                onClick={() => select(t.id)}
                onDoubleClick={() => setDialog({ kind: 'rename', id: t.id, title: t.title })}
              >
                <span className={`shell-icon ${t.kind}`}>{t.kind === 'remote' ? '↗' : '>_'}</span>
                <span className="tab-title">{t.title}</span>
                {t.pending && <span className="spinner" />}
              </button>
              <button
                className="tab-close"
                aria-label={`Close ${t.title}`}
                onClick={() => run(window.myterminal.close(t.id))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="new-tab-wrap" ref={menuAnchor}>
          <button
            className={`new-tab ${menu ? 'open' : ''}`}
            aria-label="New terminal tab"
            title="New tab (Ctrl+Shift+T)"
            aria-expanded={menu}
            onClick={() => setMenu((v) => !v)}
          >
            +
          </button>
          {menu && (
            <>
              <div className="menu-scrim" onClick={() => setMenu(false)} />
              <div
                className="new-menu"
                style={{
                  position: 'fixed',
                  left: Math.min(
                    Math.max(8, menuAnchor.current?.getBoundingClientRect().left ?? 8),
                    window.innerWidth - 338,
                  ),
                  right: 'auto',
                }}
              >
                <h2>Local</h2>
                {localShells.map((s) => (
                  <button
                    key={s.id}
                    disabled={!s.available}
                    title={s.reason ?? s.executable}
                    onClick={() => run(newTab(s.id))}
                  >
                    <span className="menu-icon">&gt;_</span>
                    <span>
                      {s.name}
                      {!s.available && <small>{s.reason}</small>}
                    </span>
                    {s.available && <span className="enter">↵</span>}
                  </button>
                ))}
                <h2>Remote</h2>
                <button
                  onClick={() => {
                    setMenu(false);
                    setDialog({ kind: 'connect' });
                  }}
                >
                  <span className="menu-icon">↗</span>New SSH connection…
                </button>
                {bootstrap?.profiles.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      setMenu(false);
                      setDialog({ kind: 'connect', profile: p });
                    }}
                  >
                    <span className="menu-icon">◇</span>
                    <span>
                      {p.name}
                      <small>
                        {p.username}@{p.host}
                      </small>
                    </span>
                  </button>
                ))}
                <div className="menu-footer">
                  <button
                    onClick={() => {
                      setMenu(false);
                      setDialog({ kind: 'manage' });
                    }}
                  >
                    Manage connections
                  </button>
                  <button
                    onClick={() => {
                      setMenu(false);
                      setDialog({ kind: 'settings' });
                    }}
                  >
                    Settings
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
        <div className="brand">MYTERMINAL</div>
      </nav>
      {notice && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button aria-label="Dismiss notification" onClick={() => setNotice('')}>
            ×
          </button>
        </div>
      )}
      <div className="workspace">
        {tabs.map((tab) => (
          <section
            className={`terminal-panel ${tab.id === active ? 'visible' : ''}`}
            id={`panel-${tab.id}`}
            role="tabpanel"
            aria-label={tab.title}
            key={tab.id}
          >
            <div className="connection-bar">
              <button
                className="connect-button"
                onClick={() => setDialog({ kind: 'connect', id: tab.id, profile: tab.profile })}
                disabled={!!tab.pending}
              >
                ↗ Connect
              </button>
              <span className={`location-badge ${tab.kind}`}>
                {tab.kind === 'local' ? '▣ Local' : '◇ Remote'}
              </span>
              <span className="destination" title={tab.label}>
                {tab.label}
              </span>
              <span className={`session-state ${tab.state}`}>
                <span className={tab.pending ? 'spinner' : 'status-dot'} />
                {stateLabel(tab)}
              </span>
              <div className="session-actions">
                {tab.pending ? (
                  <button onClick={() => run(window.myterminal.disconnect(tab.id))}>Cancel</button>
                ) : tab.kind === 'remote' ? (
                  <>
                    {tab.state === 'connected' && (
                      <button onClick={() => run(window.myterminal.disconnect(tab.id))}>
                        Disconnect
                      </button>
                    )}
                    <button
                      onClick={() =>
                        setDialog({ kind: 'connect', id: tab.id, profile: tab.profile })
                      }
                    >
                      Reconnect
                    </button>
                  </>
                ) : (
                  tab.state !== 'running' &&
                  tab.shellId && (
                    <button onClick={() => run(window.myterminal.local(tab.id, tab.shellId!))}>
                      Restart
                    </button>
                  )
                )}
                <button
                  className="icon-button"
                  title="Find in output"
                  aria-label="Find in output"
                  onClick={() => setFind((v) => !v)}
                >
                  ⌕
                </button>
              </div>
            </div>
            {tab.pending && (
              <div className="transition" role="status">
                {tab.pending}. Input is paused until the destination is ready.
              </div>
            )}
            {tab.error && (
              <div className="session-error" role="alert">
                {tab.error}
                {['running', 'connected'].includes(tab.state) &&
                  ' Your existing session is still available.'}
              </div>
            )}
            {find && tab.id === active && (
              <div className="find-bar">
                <input
                  aria-label="Find in terminal"
                  placeholder="Find in terminal output…"
                  value={query}
                  autoFocus
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setFound(runtime.current!.search(tab.id, e.target.value));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter')
                      setFound(runtime.current!.search(tab.id, query, e.shiftKey));
                    if (e.key === 'Escape') {
                      setFind(false);
                      runtime.current?.focus(tab.id);
                    }
                  }}
                />
                {query && !found && <small>No matches</small>}
                <button
                  onClick={() => setFound(runtime.current!.search(tab.id, query, true))}
                  aria-label="Previous match"
                >
                  ↑
                </button>
                <button
                  onClick={() => setFound(runtime.current!.search(tab.id, query))}
                  aria-label="Next match"
                >
                  ↓
                </button>
                <button
                  onClick={() => {
                    setFind(false);
                    runtime.current?.focus(tab.id);
                  }}
                  aria-label="Close search"
                >
                  ×
                </button>
              </div>
            )}
            <TerminalPane id={tab.id} terminals={runtime.current} />
            {!tab.pending && !['running', 'connected'].includes(tab.state) && (
              <div className="ended">
                <span>
                  {tab.state === 'idle'
                    ? 'Choose a destination for this terminal.'
                    : `Session ${tab.state}${tab.exitCode !== undefined ? ` · exit code ${tab.exitCode}` : ''}. Output is read-only.`}
                </span>
                {tab.kind === 'remote' && <span>Reconnect starts a fresh shell.</span>}
                <select
                  aria-label="Start local terminal"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) run(window.myterminal.local(tab.id, e.target.value));
                  }}
                >
                  <option value="">Start local terminal…</option>
                  {localShells
                    .filter((s) => s.available)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
                <button onClick={() => run(window.myterminal.close(tab.id))}>Close</button>
              </div>
            )}
          </section>
        ))}
        {!tabs.length && (
          <div className="empty-workspace">
            <div className="empty-symbol">&gt;_</div>
            <h1>Your next session starts here.</h1>
            <p>Open a local shell or connect to a remote machine.</p>
            <button className="primary" onClick={() => setMenu(true)}>
              + New terminal
            </button>
            <span>Ctrl + Shift + T</span>
          </div>
        )}
      </div>
      <div className="app-footer">
        <span>
          <i /> {current?.kind === 'remote' ? 'REMOTE SESSION' : 'LOCAL WORKSPACE'}
        </span>
        <span>
          {tabs.length} {tabs.length === 1 ? 'terminal' : 'terminals'}
          <b>·</b>UTF-8<b>·</b>
          {bootstrap?.preferences.fontSize ?? 14}px
        </span>
      </div>
      {dialog?.kind === 'connect' && (
        <ConnectionDialog
          profiles={bootstrap?.profiles ?? []}
          initial={dialog.profile}
          target={tabs.find((t) => t.id === dialog.id)?.title}
          submit={connect}
          close={closeDialog}
        />
      )}
      {dialog?.kind === 'edit' && (
        <ConnectionDialog
          key={dialog.profile?.id ?? 'new'}
          profiles={bootstrap?.profiles ?? []}
          initial={dialog.profile}
          editing
          submit={connect}
          close={() => setDialog({ kind: 'manage' })}
        />
      )}
      {dialog?.kind === 'manage' && (
        <ManageDialog
          profiles={bootstrap?.profiles ?? []}
          close={closeDialog}
          edit={(profile) => setDialog({ kind: 'edit', profile })}
          refresh={refresh}
          error={report}
        />
      )}
      {dialog?.kind === 'settings' && bootstrap && (
        <SettingsDialog
          preferences={bootstrap.preferences}
          shells={localShells}
          save={savePreferences}
          close={closeDialog}
        />
      )}
      {dialog?.kind === 'rename' && (
        <RenameDialog
          title={dialog.title}
          submit={(title) => window.myterminal.rename(dialog.id, title)}
          close={closeDialog}
        />
      )}
      {dialog && ['help', 'shortcuts', 'about'].includes(dialog.kind) && (
        <HelpDialog
          kind={dialog.kind as 'help' | 'shortcuts' | 'about'}
          version={bootstrap?.version ?? '0.1.0'}
          close={closeDialog}
        />
      )}
    </main>
  );
}
function TerminalPane({ id, terminals }: { id: string; terminals: Terminals | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) terminals?.mount(id, ref.current);
  }, [id, terminals]);
  return <div className="terminal-host" ref={ref} data-terminal-id={id} />;
}
