import {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  dialog,
  clipboard,
  safeStorage,
  screen,
  nativeTheme,
  type IpcMainInvokeEvent,
  type IpcMainEvent,
  type MenuItemConstructorOptions,
} from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  connectSchema,
  idSchema,
  preferencesSchema,
  profileSchema,
  sizeSchema,
  type Action,
  type Profile,
} from '../shared/schema';
import { ConfigStore } from './store';
import { discoverShells } from './shells';
import { SessionManager } from './sessions';
import { openLocal, openRemote } from './transports';

app.setName('MyTerminal');
app.setAppUserModelId('com.impshial.myterminal');
if (process.env.MYTERMINAL_TEST_DATA)
  app.setPath('userData', path.resolve(process.env.MYTERMINAL_TEST_DATA));
const rendererFile = path.resolve(__dirname, '../renderer/index.html');
let window: BrowserWindow;
let store: ConfigStore;
let discoveredShells: ReturnType<typeof discoverShells> | undefined;
const localShells = () => (discoveredShells ??= discoverShells(store.data.preferences));
let closing = false;
let closePrompt = false;
const manager = new SessionManager((owner, event) => {
  if (window && !window.isDestroyed() && window.webContents.id === owner)
    window.webContents.send('terminal:event', event);
});
const targetSchema = z.object({ id: idSchema }).strict();
const streamSchema = z.object({ id: idSchema, generation: idSchema }).strict();
const inputSchema = streamSchema.extend({ data: z.string().max(65536) });
const resizeSchema = streamSchema.extend({ size: sizeSchema });
const ackSchema = streamSchema.extend({
  length: z
    .number()
    .int()
    .min(0)
    .max(4 * 1024 * 1024),
});

function owner(event: IpcMainInvokeEvent | IpcMainEvent) {
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw new Error('Untrusted IPC sender.');
  try {
    if (fileURLToPath(event.senderFrame.url) !== rendererFile) throw new Error();
  } catch {
    throw new Error('Untrusted document.');
  }
  return event.sender.id;
}
function handle<T>(
  channel: string,
  schema: z.ZodType<T>,
  fn: (owner: number, value: T) => unknown,
) {
  ipcMain.handle(channel, async (event, raw) => {
    try {
      const sender = owner(event);
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new Error('Invalid request. Check the fields and try again.');
      return { ok: true, value: await fn(sender, parsed.data) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'The operation could not be completed.',
      };
    }
  });
}
function stream<T>(channel: string, schema: z.ZodType<T>, fn: (owner: number, value: T) => void) {
  ipcMain.on(channel, (event, raw) => {
    try {
      fn(owner(event), schema.parse(raw));
    } catch {
      /* Ignore stale, oversized, or untrusted streaming messages. Never log terminal data. */
    }
  });
}
async function confirm(message: string, detail: string, proceed: string) {
  const result = await dialog.showMessageBox(window, {
    type: 'warning',
    title: 'MyTerminal',
    message,
    detail,
    buttons: ['Cancel', proceed],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return result.response === 1;
}
async function replacementAllowed(sender: number, id: string, destination: string) {
  const tab = manager.snapshot(sender, id);
  if (tab.pending) throw new Error('A connection attempt is already in progress.');
  if (tab.state !== 'running' && tab.state !== 'connected') return true;
  return confirm(
    'Replace this tab’s terminal session?',
    `Current: ${tab.label}\nDestination: ${destination}\n\nThe current session will close only after the new session is ready. Its displayed history will be cleared. Other tabs will keep running.`,
    'Connect and replace',
  );
}
async function trust(profile: Profile, fingerprint: string, automatic: boolean) {
  const previous = store.hostKey(profile.host, profile.port);
  if (previous === fingerprint) return true;
  if (previous && automatic) return false;
  const result = await dialog.showMessageBox(window, {
    type: previous ? 'warning' : 'question',
    title: 'MyTerminal — Verify SSH host',
    message: previous ? 'The SSH host key has changed' : 'Trust this SSH host?',
    detail: `${profile.host}:${profile.port}\n\n${previous ? `Previous fingerprint:\n${previous}\n\n` : ''}Presented fingerprint:\n${fingerprint}\n\n${previous ? 'A changed key can indicate an impersonated server. Verify this change independently with the server administrator before replacing the trusted key.' : 'Compare this fingerprint with one provided by the server administrator before trusting it.'}`,
    buttons: [
      'Cancel',
      previous ? 'I verified the change — replace trusted key' : 'Trust and connect',
    ],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (result.response !== 1 || window.isDestroyed()) return false;
  await store.trustHost(profile.host, profile.port, fingerprint);
  return true;
}
async function confirmPaste(text: string) {
  if (text.length > 1024 * 1024) throw new Error('Paste is limited to 1 MB.');
  if (store.data.preferences.confirmMultilinePaste && /[\r\n]/.test(text))
    return confirm(
      'Paste multiple lines into the active terminal?',
      'The pasted text contains line breaks and may execute commands. Review the clipboard before continuing.',
      'Paste',
    );
  return true;
}
function registerIPC() {
  handle('app:bootstrap', z.undefined(), async () => ({
    profiles: store.publicProfiles(),
    preferences: store.data.preferences,
    shells: await localShells(),
    warning: store.warning,
    version: app.getVersion(),
  }));
  handle('tab:create', z.undefined(), (sender) => manager.create(sender));
  handle(
    'tab:local',
    targetSchema.extend({ shellId: z.string().max(200), cwd: z.string().max(2048).optional() }),
    async (sender, args) => {
      const shell = (await localShells()).find((s) => s.id === args.shellId);
      if (!shell?.available)
        throw new Error(shell?.reason ?? 'This shell is unavailable. Check Settings.');
      if (!(await replacementAllowed(sender, args.id, shell.name)))
        throw new Error('Session replacement cancelled.');
      await manager.replace(sender, args.id, { shell }, (size) => openLocal(shell, size, args.cwd));
    },
  );
  handle('tab:connect', connectSchema, async (sender, args) => {
    if (args.saveSecret && !args.saveProfile)
      throw new Error('Save the profile before saving its credential.');
    if (
      !(await replacementAllowed(
        sender,
        args.id,
        `${args.profile.username}@${args.profile.host}:${args.profile.port}`,
      ))
    )
      throw new Error('Session replacement cancelled.');
    let secret = args.secret || (await store.secret(args.profile));
    try {
      await manager.replace(sender, args.id, { profile: args.profile }, (size, signal) =>
        openRemote(args.profile, secret, size, signal, trust, args.automatic),
      );
      if (args.saveProfile) {
        try {
          await store.saveProfile(args.profile, secret, args.saveSecret);
        } catch {
          await dialog.showMessageBox(window, {
            type: 'warning',
            title: 'MyTerminal',
            message: 'Connected, but the profile could not be saved.',
            detail:
              'Your new session is active. Check access to the application-data folder and Windows credential protection, then save the profile again.',
          });
        }
      }
    } finally {
      secret = undefined;
      args.secret = undefined;
    }
  });
  handle('tab:disconnect', targetSchema, async (sender, { id }) => {
    const tab = manager.snapshot(sender, id);
    if (
      store.data.preferences.confirmClose &&
      (tab.state === 'connected' || tab.pending) &&
      !(await confirm(
        'Disconnect this terminal?',
        'Active remote work may end. Terminal output will remain available. Other tabs are unaffected.',
        'Disconnect',
      ))
    )
      return;
    manager.disconnect(sender, id);
  });
  handle('tab:close', targetSchema, async (sender, { id }) => {
    const tab = manager.snapshot(sender, id);
    if (
      store.data.preferences.confirmClose &&
      (tab.state === 'running' || tab.state === 'connected' || tab.pending) &&
      !(await confirm(
        'Close this terminal?',
        'Foreground activity cannot always be detected. Closing this tab ends its session and may interrupt work.',
        'Close terminal',
      ))
    )
      return false;
    manager.close(sender, id);
    return true;
  });
  handle(
    'tab:rename',
    targetSchema.extend({ title: z.string().trim().min(1).max(80) }),
    (sender, { id, title }) => manager.rename(sender, id, title),
  );
  stream('terminal:input', inputSchema, (sender, a) =>
    manager.input(sender, a.id, a.generation, a.data),
  );
  stream('terminal:resize', resizeSchema, (sender, a) =>
    manager.resize(sender, a.id, a.generation, a.size),
  );
  stream('terminal:ack', ackSchema, (sender, a) =>
    manager.ack(sender, a.id, a.generation, a.length),
  );
  handle('profiles:list', z.undefined(), () => store.publicProfiles());
  handle('profiles:save', profileSchema, (_, profile) => store.saveProfile(profile));
  handle('profiles:delete', targetSchema, async (_, { id }) => {
    if (
      await confirm(
        'Delete this saved profile?',
        'Its saved credential will also be removed. Open sessions will keep running.',
        'Delete profile',
      )
    )
      await store.deleteProfile(id);
  });
  handle('profiles:forget', targetSchema, (_, { id }) => store.forgetSecret(id));
  handle('preferences:save', preferencesSchema, async (_, preferences) => {
    await store.preferences(preferences);
    discoveredShells = undefined;
    nativeTheme.themeSource = preferences.appTheme;
    setupMenu();
  });
  handle('key:browse', z.undefined(), async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Select SSH private key',
      properties: ['openFile'],
    });
    return result.canceled ? undefined : result.filePaths[0];
  });
  handle('clipboard:copy', z.string().max(1024 * 1024), (_, text) => clipboard.writeText(text));
  handle('clipboard:paste', z.undefined(), async () => {
    const text = await clipboard.readText();
    return (await confirmPaste(text)) ? text : undefined;
  });
  handle('clipboard:confirm', z.string().max(1024 * 1024), (_, text) => confirmPaste(text));
}
function setupMenu() {
  const action = (name: Action) => () => window.webContents.send('app:action', name);
  const appearance = async (change: Partial<typeof store.data.preferences>) => {
    try {
      await store.preferences({ ...store.data.preferences, ...change });
      nativeTheme.themeSource = store.data.preferences.appTheme;
      setupMenu();
      action('refreshPreferences')();
    } catch {
      setupMenu();
      await dialog.showMessageBox(window, {
        type: 'error',
        message: 'Could not save appearance preferences.',
      });
    }
  };
  const item = (label: string, name: Action, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: action(name),
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '&File',
        submenu: [
          item('New Tab', 'new', 'Ctrl+Shift+T'),
          item('Connect…', 'connect', 'Ctrl+Shift+O'),
          item('Manage Connections…', 'manage'),
          { type: 'separator' },
          item('Close Tab', 'close', 'Ctrl+Shift+W'),
          item('Settings…', 'settings', 'Ctrl+,'),
          { type: 'separator' },
          { label: 'Exit', click: () => window.close() },
        ],
      },
      {
        label: '&Edit',
        submenu: [
          item('Copy', 'copy', 'Ctrl+Shift+C'),
          item('Paste', 'paste', 'Ctrl+Shift+V'),
          item('Select All', 'selectAll'),
          item('Find…', 'find', 'Ctrl+Shift+F'),
          { type: 'separator' },
          item('Clear Scrollback', 'clear'),
        ],
      },
      {
        label: '&View',
        submenu: [
          {
            label: 'Light mode',
            type: 'checkbox',
            checked: store.data.preferences.appTheme === 'light',
            click: (menuItem) => {
              void appearance({ appTheme: menuItem.checked ? 'light' : 'dark' });
            },
          },
          {
            label: 'Terminal Mode',
            submenu: [
              {
                label: 'PowerShell',
                type: 'radio',
                checked: store.data.preferences.terminalTheme === 'powershell',
                click: () => {
                  void appearance({ terminalTheme: 'powershell', terminalFont: 'auto' });
                },
              },
              {
                label: 'Command Window',
                type: 'radio',
                checked: store.data.preferences.terminalTheme === 'command',
                click: () => {
                  void appearance({ terminalTheme: 'command', terminalFont: 'auto' });
                },
              },
              {
                label: '1970’s Screen',
                type: 'radio',
                checked: store.data.preferences.terminalTheme === 'retro',
                click: () => {
                  void appearance({ terminalTheme: 'retro', terminalFont: 'auto' });
                },
              },
            ],
          },
          { type: 'separator' },
          item('Increase Font Size', 'zoomIn', 'Ctrl+='),
          item('Decrease Font Size', 'zoomOut', 'Ctrl+-'),
          item('Reset Font Size', 'zoomReset', 'Ctrl+0'),
          { role: 'togglefullscreen', accelerator: 'F11' },
        ],
      },
      {
        label: '&Help',
        submenu: [
          item('Keyboard Shortcuts', 'shortcuts'),
          item('Local Shells and SSH Help', 'help'),
          { type: 'separator' },
          item('About MyTerminal', 'about'),
        ],
      },
    ]),
  );
}
async function start() {
  nativeTheme.themeSource = 'dark';
  store = new ConfigStore(app.getPath('userData'), {
    async encrypt(text) {
      if (process.platform !== 'win32' || !(await safeStorage.isAsyncEncryptionAvailable()))
        throw new Error(
          'Windows-protected credential storage is unavailable. Connect without saving the credential.',
        );
      return (await safeStorage.encryptStringAsync(text)).toString('base64');
    },
    async decrypt(text) {
      return (await safeStorage.decryptStringAsync(Buffer.from(text, 'base64'))).result;
    },
  });
  await store.load();
  nativeTheme.themeSource = store.data.preferences.appTheme;
  const saved = store.data.window;
  const bounds = {
    width: saved?.width ?? 1200,
    height: saved?.height ?? 780,
    x: saved?.x,
    y: saved?.y,
  };
  if (
    bounds.x !== undefined &&
    bounds.y !== undefined &&
    !screen
      .getAllDisplays()
      .some(
        (d) =>
          bounds.x! + 100 > d.workArea.x &&
          bounds.x! < d.workArea.x + d.workArea.width &&
          bounds.y! + 100 > d.workArea.y &&
          bounds.y! < d.workArea.y + d.workArea.height,
      )
  ) {
    bounds.x = undefined;
    bounds.y = undefined;
  }
  window = new BrowserWindow({
    ...bounds,
    minWidth: 760,
    minHeight: 500,
    title: 'MyTerminal',
    backgroundColor: '#101418',
    show: false,
    autoHideMenuBar: false,
    icon: path.join(__dirname, '../../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_, __, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.on('render-process-gone', () => {
    manager.dispose(window.webContents.id);
    window.destroy();
  });
  window.on('close', (event) => {
    if (closing) return;
    event.preventDefault();
    if (closePrompt) return;
    closePrompt = true;
    void (async () => {
      try {
        if (
          store.data.preferences.confirmClose &&
          manager.active(window.webContents.id) &&
          !(await confirm(
            'Exit MyTerminal?',
            'All terminal sessions in this window will close. Active work may be interrupted.',
            'Exit',
          ))
        )
          return;
        const b = window.getNormalBounds();
        await store.window({ ...b, maximized: window.isMaximized() });
        closing = true;
        manager.dispose(window.webContents.id);
        window.destroy();
      } catch {
        await dialog.showMessageBox(window, {
          type: 'error',
          message:
            'Could not save window settings. Check access to the MyTerminal application-data folder.',
        });
      } finally {
        closePrompt = false;
      }
    })();
  });
  registerIPC();
  setupMenu();
  window.once('ready-to-show', () => {
    if (saved?.maximized) window.maximize();
    if (process.env.MYTERMINAL_TEST_HIDDEN !== '1') window.show();
  });
  await window.loadFile(rendererFile);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app
    .whenReady()
    .then(start)
    .catch(() => {
      dialog.showErrorBox(
        'MyTerminal',
        'MyTerminal could not start. Check access to its application-data directory and reinstall if needed.',
      );
      app.exit(1);
    });
  app.on('window-all-closed', () => app.quit());
}
