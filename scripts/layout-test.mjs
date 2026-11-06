import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Exercise actual font metrics and ConPTY output; a DOM-only test cannot measure xterm rows.
const packaged = process.argv.includes('--packaged');
const screenshots = !process.argv.includes('--no-screenshots');
const artifacts = path.resolve('test-results', packaged ? 'layout-packaged' : 'layout');
await mkdir(artifacts, { recursive: true });
const env = {
  ...process.env,
  MYTERMINAL_TEST_DATA: path.join(artifacts, `profile-${randomUUID()}`),
  MYTERMINAL_TEST_HIDDEN: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
const results = [];
try {
  app = await electron.launch({
    ...(packaged
      ? { executablePath: path.resolve('release/win-unpacked/MyTerminal.exe'), args: [] }
      : { args: ['.'] }),
    cwd: process.cwd(),
    env,
    chromiumSandbox: true,
    timeout: 45000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.session-state.running', { timeout: 30000 });
  await page.waitForFunction(() =>
    document.querySelector('.xterm-screen')?.textContent?.includes('PS '),
  );
  const { preferences } = await page.evaluate(() => window.myterminal.bootstrap());

  async function applyPreferences(value) {
    await page.evaluate((value) => window.myterminal.preferences(value), value);
    // Saving through IPC persists settings; the menu/settings UI then requests this refresh.
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send('app:action', 'refreshPreferences'),
    );
    await page.waitForFunction(
      ({ terminalTheme, appTheme, fontSize }) =>
        document.documentElement.dataset.terminalTheme === terminalTheme &&
        document.documentElement.dataset.appTheme === appTheme &&
        document.querySelector('.app-footer')?.textContent?.includes(`${fontSize}px`),
      value,
    );
  }

  async function check(label) {
    // Fill the viewport after each resize so the cursor exercises the very last row.
    const marker = `BOTTOM_READY_${results.length}`;
    await page.locator('.terminal-panel.visible .xterm-helper-textarea').focus();
    await page.keyboard.type(
      `1..120 | ForEach-Object { "Line $_" }; Write-Output ('BOTTOM_' + 'READY_${results.length}')`,
    );
    await page.keyboard.press('Enter');
    await page.waitForFunction((marker) => {
      const rows = document.querySelector('.terminal-panel.visible .xterm-rows');
      return (
        rows?.textContent?.includes(marker) && rows.lastElementChild?.textContent?.startsWith('PS ')
      );
    }, marker);
    const geometry = await page.evaluate(() => {
      const host = document.querySelector('.terminal-panel.visible .terminal-host');
      const screen = host.querySelector('.xterm-screen').getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      const style = getComputedStyle(host);
      const lastRow = host.querySelector('.xterm-rows').lastElementChild.getBoundingClientRect();
      const cursor = host.querySelector('.xterm-cursor')?.getBoundingClientRect();
      return {
        contentBottom: hostRect.bottom - parseFloat(style.paddingBottom),
        contentRight: hostRect.right - parseFloat(style.paddingRight),
        screenBottom: screen.bottom,
        screenRight: screen.right,
        lastRowBottom: lastRow.bottom,
        cursorBottom: cursor?.bottom,
        footerTop: document.querySelector('.app-footer').getBoundingClientRect().top,
        viewportHeight: innerHeight,
        footerBottom: document.querySelector('.app-footer').getBoundingClientRect().bottom,
      };
    });
    results.push({ label, ...geometry });
    console.log(label, JSON.stringify(geometry));
    if (screenshots && (results.length === 1 || label === 'powershell default restored'))
      await page.screenshot({
        path: path.join(artifacts, `${results.length === 1 ? 'initial' : 'final'}.png`),
        timeout: 60000,
      });
    assert.ok(
      geometry.screenBottom <= geometry.contentBottom + 0.5,
      `${label}: terminal rows extend below the content area`,
    );
    assert.ok(
      geometry.screenRight <= geometry.contentRight + 0.5,
      `${label}: terminal columns extend outside the content area`,
    );
    assert.ok(
      geometry.lastRowBottom <= geometry.footerTop,
      `${label}: bottom prompt overlaps the status bar`,
    );
    assert.ok(geometry.cursorBottom <= geometry.contentBottom + 0.5, `${label}: cursor is clipped`);
    assert.ok(
      geometry.footerBottom <= geometry.viewportHeight,
      `${label}: status bar is outside the window`,
    );
  }

  await check('initial PowerShell');
  for (const terminalTheme of ['powershell', 'command', 'retro']) {
    for (const [width, height, fontSize, appTheme] of [
      [760, 500, 32, 'dark'],
      [1050, 700, 9, 'light'],
      [1200, 780, 14, 'dark'],
    ]) {
      await applyPreferences({
        ...preferences,
        terminalTheme,
        fontSize,
        appTheme,
      });
      await app.evaluate(
        ({ BrowserWindow }, { width, height }) =>
          BrowserWindow.getAllWindows()[0].setSize(width, height),
        { width, height },
      );
      await page.waitForTimeout(200);
      await check(`${terminalTheme} ${width}x${height} ${fontSize}px ${appTheme}`);
      await page.getByRole('button', { name: 'Find in output', exact: true }).first().click();
      await check(`${terminalTheme} ${fontSize}px with search bar`);
      await page.getByRole('button', { name: 'Close search', exact: true }).click();
    }
  }
  await applyPreferences(preferences);
  await check('powershell default restored');
  assert.deepEqual(errors, []);
  console.log(
    `PASS: ${results.length} terminal layouts keep the bottom prompt and cursor visible.`,
  );
} finally {
  await writeFile(path.join(artifacts, 'results.json'), JSON.stringify(results, null, 2));
  if (app) {
    // Let the normal close handler dispose the real PTY before Electron shuts down.
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      })
      .catch(() => {});
    await app.close();
  }
}
