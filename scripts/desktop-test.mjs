import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startSSHFixture } from './ssh-fixture.mjs';

const packaged = process.argv.includes('--packaged');
const screenshots = !process.argv.includes('--no-screenshots');
const artifacts = path.resolve('test-results', packaged ? 'packaged' : 'desktop');
await mkdir(artifacts, { recursive: true });
const userData = path.join(artifacts, `profile-${randomUUID()}`);
const env = { ...process.env, MYTERMINAL_TEST_DATA: userData, MYTERMINAL_TEST_HIDDEN: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const launch = () =>
  electron.launch({
    ...(packaged
      ? { executablePath: path.resolve('release/win-unpacked/MyTerminal.exe'), args: [] }
      : { args: ['.'] }),
    cwd: process.cwd(),
    env,
    chromiumSandbox: true,
    timeout: 45000,
  });
let app;
let fixture;
const checks = [];
try {
  app = await launch();
  console.log('Test app process:', app.process().pid);
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => {
    errors.push(e.message);
    console.error('Renderer error:', e.message);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('Renderer console:', message.text());
  });
  await page.waitForSelector('.session-state.running', { timeout: 30000 });
  assert.equal(await page.title(), 'MyTerminal');
  await page.waitForFunction(() =>
    document.querySelector('.xterm-screen')?.textContent?.includes('PS '),
  );
  checks.push('Default Windows GUI opens a real PowerShell PTY without a remote connection');
  console.log('PASS:', checks.at(-1));
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  const startup = await page.evaluate(() => window.myterminal.bootstrap());
  assert.equal(startup.preferences.terminalTheme, 'powershell');
  assert.equal(startup.preferences.appTheme, 'dark');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const preferences = await app.evaluate(({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      sandbox: p.sandbox,
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
    };
  });
  assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  checks.push(
    'Renderer sandbox, context isolation, and disabled Node integration verified at runtime',
  );
  await page.evaluate(() => {
    window.__events = [];
    window.myterminal.onEvent((e) => window.__events.push(e));
  });
  const firstId = await page
    .locator('.terminal-panel.visible .terminal-host')
    .getAttribute('data-terminal-id');
  await page.locator('.terminal-panel.visible .xterm-helper-textarea').focus();
  await page.keyboard.type("Set-Location $env:SystemRoot; Write-Output ('FIRST_' + 'TERMINAL_OK')");
  await page.keyboard.press('Enter');
  await page.waitForFunction(() =>
    document
      .querySelector('.terminal-panel.visible .xterm-screen')
      ?.textContent?.includes('FIRST_TERMINAL_OK'),
  );
  await page.getByRole('button', { name: 'New terminal tab', exact: true }).click();
  await page
    .locator('.new-menu')
    .getByRole('button', { name: /Windows PowerShell/ })
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll('.session-state.running').length === 2,
  );
  const secondId = await page
    .locator('.terminal-panel.visible .terminal-host')
    .getAttribute('data-terminal-id');
  assert.notEqual(firstId, secondId);
  await page.locator('.terminal-panel.visible .xterm-helper-textarea').focus();
  await page.keyboard.type("Write-Output ('SECOND_' + 'TERMINAL_OK'); (Get-Location).Path");
  await page.keyboard.press('Enter');
  await page.waitForFunction(() =>
    document
      .querySelector('.terminal-panel.visible .xterm-screen')
      ?.textContent?.includes('SECOND_TERMINAL_OK'),
  );
  const secondText = await page.locator('.terminal-panel.visible .xterm-screen').textContent();
  assert.ok(!secondText.includes('FIRST_TERMINAL_OK'));
  await page.getByRole('tab').first().click();
  await page.locator('.terminal-panel.visible .xterm-helper-textarea').focus();
  assert.ok(
    (await page.locator('.terminal-panel.visible .xterm-screen').textContent()).includes(
      'FIRST_TERMINAL_OK',
    ),
  );
  await page.keyboard.type("Write-Output ('CWD_' + (Get-Location).Path)");
  await page.keyboard.press('Enter');
  await page.waitForFunction(() =>
    document
      .querySelector('.terminal-panel.visible .xterm-screen')
      ?.textContent?.includes('CWD_C:\\Windows'),
  );
  checks.push(
    'Two live local tabs retain output, separate working directories, and sessions when switching',
  );
  console.log('PASS:', checks.at(-1));
  const promptsBeforeInterrupt = await page
    .locator('.terminal-panel.visible .xterm-screen')
    .evaluate((el) => (el.textContent.match(/PS C:\\Windows>/g) ?? []).length);
  await page.keyboard.type("Write-Output ('INTERRUPT_' + 'READY'); Start-Sleep -Seconds 60");
  await page.keyboard.press('Enter');
  await page.waitForFunction(() =>
    document
      .querySelector('.terminal-panel.visible .xterm-screen')
      ?.textContent?.includes('INTERRUPT_READY'),
  );
  await page.waitForTimeout(300);
  await page.locator('.terminal-panel.visible .xterm-helper-textarea').press('Control+c');
  await page.waitForFunction(
    (count) =>
      (
        document
          .querySelector('.terminal-panel.visible .xterm-screen')
          ?.textContent?.match(/PS C:\\Windows>/g) ?? []
      ).length > count,
    promptsBeforeInterrupt,
  );
  await page.keyboard.type("Write-Output ('INTERRUPT_' + 'OK')");
  await page.keyboard.press('Enter');
  await page.waitForFunction(() =>
    document
      .querySelector('.terminal-panel.visible .xterm-screen')
      ?.textContent?.includes('INTERRUPT_OK'),
  );
  checks.push('Ctrl+C interrupts a real foreground PowerShell command');
  for (const shell of startup.shells.filter(
    (s) =>
      s.available &&
      (['cmd', 'gitbash'].includes(s.id) ||
        (process.argv.includes('--wsl') && s.id.startsWith('wsl:'))),
  )) {
    const tab = await page.evaluate(() => window.myterminal.create());
    await page.evaluate(({ id, shellId }) => window.myterminal.local(id, shellId), {
      id: tab.id,
      shellId: shell.id,
    });
    const marker = shell.id === 'cmd' ? 'CMD_READY' : 'BASH_READY';
    await page.evaluate(
      ({ id, command }) => {
        const current = window.__events
          .filter((e) => e.type === 'tab' && e.tab.id === id)
          .at(-1).tab;
        window.myterminal.input(id, current.generation, command);
      },
      {
        id: tab.id,
        command: shell.id === 'cmd' ? 'echo CMD^_READY\r' : "printf 'BASH_%s\\n' READY\r",
      },
    );
    await page.waitForFunction(
      ({ id, marker }) =>
        window.__events
          .filter((e) => e.type === 'data' && e.id === id)
          .map((e) => e.data)
          .join('')
          .includes(marker),
      { id: tab.id, marker },
    );
    await page.evaluate((id) => window.myterminal.close(id), tab.id);
    checks.push(`Real ${shell.name} PTY opened and executed a command independently`);
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 700));
  await page.waitForTimeout(200);
  if (screenshots)
    await page.screenshot({ path: path.join(artifacts, 'dark-powershell.png'), timeout: 60000 });
  const menuClick = async (label, checked) =>
    app.evaluate(
      ({ Menu, BrowserWindow }, args) => {
        const view = Menu.getApplicationMenu().items.find((i) => i.label === '&View');
        const item = view.submenu.items.find((i) => i.label === args.label);
        if (args.checked !== undefined && item.checked === args.checked) return;
        item.click(item, BrowserWindow.getAllWindows()[0], {});
      },
      { label, checked },
    );
  await menuClick('Light mode', true);
  await page.waitForFunction(() => document.documentElement.dataset.appTheme === 'light');
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.terminalTheme),
    'powershell',
  );
  if (screenshots)
    await page.screenshot({ path: path.join(artifacts, 'light-powershell.png'), timeout: 60000 });
  for (const [label, theme] of [
    ['Command Window', 'command'],
    ['1970’s Screen', 'retro'],
    ['PowerShell', 'powershell'],
  ]) {
    await app.evaluate(({ Menu, BrowserWindow }, label) => {
      const modes = Menu.getApplicationMenu()
        .items.find((i) => i.label === '&View')
        .submenu.items.find((i) => i.label === 'Terminal Mode').submenu;
      const item = modes.items.find((i) => i.label === label);
      item.click(item, BrowserWindow.getAllWindows()[0], {});
    }, label);
    await page.waitForFunction(
      (theme) => document.documentElement.dataset.terminalTheme === theme,
      theme,
    );
    assert.equal(await page.evaluate(() => document.documentElement.dataset.appTheme), 'light');
    if (screenshots)
      await page.screenshot({ path: path.join(artifacts, `light-${theme}.png`), timeout: 60000 });
  }
  checks.push(
    'View menu light toggle and all three checked Terminal Mode choices operate independently',
  );
  console.log('PASS:', checks.at(-1));
  await page.getByRole('button', { name: 'Find in output', exact: true }).first().click();
  await page
    .getByRole('textbox', { name: 'Find in terminal', exact: true })
    .fill('FIRST_TERMINAL_OK');
  assert.equal(await page.getByText('No matches', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Close search', exact: true }).click();
  await app.evaluate(({ clipboard }) => clipboard.writeText("Write-Output ('PASTE_' + 'OK')\r\n"));
  await app.evaluate(({ Menu, BrowserWindow }) => {
    const item = Menu.getApplicationMenu()
      .items.find((i) => i.label === '&Edit')
      .submenu.items.find((i) => i.label === 'Paste');
    item.click(item, BrowserWindow.getAllWindows()[0], {});
  });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() =>
    document
      .querySelector('.terminal-panel.visible .xterm-screen')
      ?.textContent?.includes('PASTE_OK'),
  );
  checks.push('Terminal output search and confirmed multiline clipboard paste work');
  const p = {
    id: randomUUID(),
    name: 'Persistence test',
    host: '127.0.0.1',
    port: 22222,
    username: 'fixture',
    auth: 'password',
    keyPath: '',
    remoteShell: '',
    autoConnect: false,
  };
  await page.evaluate((p) => window.myterminal.saveProfile(p), p);
  await page.getByRole('tab').first().dblclick();
  await page.getByRole('textbox', { name: 'Tab title' }).fill('Build shell');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByRole('tab', { name: /Build shell/ }).waitFor();
  await page.getByRole('button', { name: 'Close Windows PowerShell', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 1);
  checks.push('Rename and close isolate tabs without stopping the remaining shell');
  const password = `test-only-${randomUUID()}`;
  fixture = await startSSHFixture(password);
  const sshProfile = {
    ...p,
    id: randomUUID(),
    name: 'SSH fixture',
    port: fixture.port,
    username: 'fixture-user',
  };
  const remote = await page.evaluate(() => window.myterminal.create());
  await page.evaluate(
    ({ id, profile, secret }) =>
      window.myterminal.connect({
        id,
        profile,
        secret,
        saveProfile: true,
        saveSecret: true,
        automatic: false,
      }),
    { id: remote.id, profile: sshProfile, secret: password },
  );
  await page.waitForFunction(
    (id) =>
      window.__events.some(
        (e) => e.type === 'tab' && e.tab.id === id && e.tab.state === 'connected',
      ),
    remote.id,
  );
  const persisted = await readFile(path.join(userData, 'config.json'), 'utf8');
  await app.evaluate(({ clipboard }) => clipboard.writeText('clipboard-safety-sentinel'));
  fixture.sendAll(
    `\x1b]52;c;${Buffer.from('unsolicited-remote-clipboard').toString('base64')}\x07clipboard-check-complete\r\n`,
  );
  await page.waitForFunction(
    (id) =>
      window.__events
        .filter((e) => e.type === 'data' && e.id === id)
        .map((e) => e.data)
        .join('')
        .includes('clipboard-check-complete'),
    remote.id,
  );
  assert.equal(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    'clipboard-safety-sentinel',
  );
  checks.push('Remote OSC 52 output cannot overwrite the Windows clipboard');
  assert.ok(!persisted.includes(password));
  assert.ok(JSON.parse(persisted).secrets[sshProfile.id].ciphertext.length > 20);
  assert.ok(
    !(await page.evaluate(() => window.myterminal.profiles())).some(
      (p) => p.secret || p.password || p.ciphertext,
    ),
  );
  await assert.rejects(
    page.evaluate(
      ({ id, profile }) =>
        window.myterminal.connect({
          id,
          profile,
          secret: 'incorrect-test-password',
          saveProfile: false,
          saveSecret: false,
          automatic: false,
        }),
      { id: firstId, profile: sshProfile },
    ),
    /Authentication failed/,
  );
  const retained = await page.evaluate(
    (id) => window.__events.filter((e) => e.type === 'tab' && e.tab.id === id).at(-1).tab,
    firstId,
  );
  assert.equal(retained.state, 'running');
  assert.equal(retained.kind, 'local');
  await page.evaluate((id) => window.myterminal.disconnect(id), remote.id);
  checks.push(
    'Real SSH authentication, Windows-protected credential storage, and failed destination replacement preserve the local PTY',
  );
  console.log('PASS:', checks.at(-1));
  assert.deepEqual(errors, []);
  await app.close();
  app = await launch();
  const reopened = await app.firstWindow();
  await reopened.waitForSelector('.session-state.running', { timeout: 30000 });
  const restored = await reopened.evaluate(() => window.myterminal.bootstrap());
  assert.equal(restored.preferences.appTheme, 'light');
  assert.equal(restored.preferences.terminalTheme, 'powershell');
  assert.equal(restored.profiles.find((x) => x.id === p.id).name, p.name);
  const retry = await reopened.evaluate(() => window.myterminal.create());
  await reopened.evaluate(
    ({ id, profile }) =>
      window.myterminal.connect({
        id,
        profile,
        saveProfile: false,
        saveSecret: false,
        automatic: false,
      }),
    { id: retry.id, profile: sshProfile },
  );
  checks.push('A saved Windows-protected credential reconnects successfully after restart');
  const oldPort = fixture.port;
  await fixture.close();
  fixture = await startSSHFixture(password, oldPort);
  await assert.rejects(
    reopened.evaluate(
      ({ id, profile }) =>
        window.myterminal.connect({
          id,
          profile,
          saveProfile: false,
          saveSecret: false,
          automatic: true,
        }),
      { id: retry.id, profile: sshProfile },
    ),
    /not trusted/,
  );
  checks.push('A changed SSH host key blocks automatic reconnection');
  checks.push('Profiles and independent appearance preferences survive an application restart');
  const config = JSON.parse(await readFile(path.join(userData, 'config.json'), 'utf8'));
  assert.equal(config.version, 1);
  await writeFile(
    path.join(artifacts, 'results.json'),
    JSON.stringify({ packaged, checks, userData, completed: new Date().toISOString() }, null, 2),
  );
  console.log(JSON.stringify({ packaged, checks }, null, 2));
} catch (error) {
  if (app) {
    const pages = app.windows();
    if (pages[0]) {
      if (screenshots)
        await pages[0]
          .screenshot({ path: path.join(artifacts, 'failure.png'), timeout: 10000 })
          .catch(() => {});
      console.error(
        (
          await pages[0]
            .locator('body')
            .innerText()
            .catch(() => '')
        ).slice(0, 6000),
      );
    }
  }
  throw error;
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  }
  if (fixture) await fixture.close();
}
