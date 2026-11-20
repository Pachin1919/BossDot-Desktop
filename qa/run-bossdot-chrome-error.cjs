'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtemp } = require('node:fs/promises');
const { createServer } = require('node:http');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '../desktop-app');
const { _electron } = createRequire(join(root, 'package.json'))('playwright-core');
const args = process.argv.slice(2);
const baseline = args.includes('--baseline');
const executablePath = resolve(args.find((arg) => arg !== '--baseline') || join(root, 'release/win-unpacked/BossDot.exe'));
const selector = '.workbench-host.is-active .browser-pane.is-active webview';
const chromeError = 'chrome-error://chromewebdata/';

async function run() {
  const profile = await mkdtemp(join(tmpdir(), 'bossdot-chrome-error-'));
  const fixture = createServer((request, response) => {
    console.log('FIXTURE', request.url);
    if (request.url === '/failed') {
      request.socket.destroy();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>Local fixture</title><a id="valid" href="/linked" target="_blank">Local HTTP link</a>');
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const origin = 'http://127.0.0.1:' + fixture.address().port;
  const failed = origin + '/failed';
  let app;
  try {
    console.log(JSON.stringify({ executablePath, profile, failed, baseline }));
    app = await _electron.launch({
      executablePath,
      args: [`--user-data-dir=${profile}`, '--disable-gpu', '--proxy-server=http://127.0.0.1:9', '--control-bridge=0'],
      env: { ...process.env, BOSSCLAW_DEBUG: '0', BOSSCLAW_CONTROL: '0' },
    });
    await app.evaluate(({ shell, app }) => {
      globalThis.externalCalls = [];
      shell.openExternal = async (url) => { globalThis.externalCalls.push(url); };
      return { version: app.getVersion(), packed: app.isPackaged };
    }).then((runtime) => {
      assert.equal(runtime.packed, true);
      console.log(JSON.stringify(runtime));
    });
    const page = await app.firstWindow({ timeout: 15000 });
    await page.locator('.hero-actions').getByRole('button', { name: '打开工作台' }).click();
    const webview = page.locator(selector);
    await page.waitForFunction((selector) => {
      try { return document.querySelector(selector)?.getWebContentsId() > 0; } catch { return false; }
    }, selector);
    const id = await webview.evaluate((element, baseline) => {
      window.errorNav = { attributes: [], messages: [], baselineBlankWrites: 0 };
      const original = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function (name, value) {
        if (this.localName === 'webview' && name === 'src') {
          // Record the attempted src write before Electron can handle the protocol.
          if (/^chrome-error:/i.test(value)) {
            window.errorNav.attributes.push(value);
            return;
          }
          // The old renderer also echoes initial/child about:blank, which can abort the fixture.
          if (baseline && value === 'about:blank') {
            window.errorNav.baselineBlankWrites++;
            return;
          }
        }
        return original.call(this, name, value);
      };
      element.addEventListener('ipc-message', (event) => {
        if (['nav', 'preload-alive'].includes(event.channel)) window.errorNav.messages.push({
          channel: event.channel, url: event.args[0]?.url,
        });
      });
      return element.getWebContentsId();
    }, baseline);
    const start = origin + '/';
    const address = page.locator('.workbench-host.is-active .browser-bar input');
    if (!baseline) {
      await address.fill(start);
      await page.waitForFunction((selector) => document.querySelector(selector)?.getTitle() === 'Local fixture', selector, { timeout: 5000 });
    }
    const failure = await app.evaluate(async ({ webContents }, { id, failed }) => {
      const guest = webContents.fromId(id);
      const events = [];
      guest.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
        events.push({ code, description, url, isMainFrame });
      });
      await guest.loadURL(failed).catch((error) => events.push({ rejected: error.code }));
      return { events, visibleUrl: guest.getURL(), documentUrl: await guest.executeJavaScript('location.href') };
    }, { id, failed });
    console.log('REAL_FAILURE', JSON.stringify(failure));
    assert.ok(failure.events.some((event) => event.isMainFrame && event.url === failed && event.code === -324));
    assert.match(failure.documentUrl, /^chrome-error:/);
    await page.waitForFunction(() => window.errorNav.messages.some((message) =>
      message.channel === 'nav' && message.url?.startsWith('chrome-error:')), null, { timeout: 5000 });
    const renderer = await page.evaluate(() => window.errorNav);
    console.log('RENDERER', JSON.stringify(renderer));
    if (baseline) {
      assert.ok(renderer.attributes.length > 0, 'Baseline did not try to replay the internal URL');
      assert.deepEqual(await app.evaluate(() => globalThis.externalCalls), []);
      console.log('PASS baseline: intercepted replay of internal error URL');
      return;
    }
    assert.deepEqual(renderer.attributes, []);
    assert.equal(await address.inputValue(), start);
    await address.fill(chromeError);
    assert.equal(await address.inputValue(), start);
    assert.deepEqual(await page.evaluate(() => window.errorNav.attributes), []);
    await app.evaluate(async ({ webContents }, { id, origin }) => {
      await webContents.fromId(id).loadURL(origin);
    }, { id, origin });
    await page.waitForFunction(({ selector, origin }) => document.querySelector(selector)?.getURL() === origin + '/', { selector, origin });
    const routes = await app.evaluate(async ({ webContents, Menu, BrowserWindow }, { id, origin, chromeError }) => {
      const guest = webContents.fromId(id);
      const host = BrowserWindow.getAllWindows()[0].webContents;
      const originalPopup = Menu.prototype.popup;
      let items;
      Menu.prototype.popup = function () { items = this.items; };
      const allowed = origin + '/external';
      const prevented = [];
      let rightClickError;
      let rightClickHttp;
      try {
        for (const [label, contents] of [['host', host], ['guest', guest]]) {
          for (const name of ['will-frame-navigate', 'will-redirect']) {
            contents.emit(name, { url: chromeError, preventDefault() { prevented.push(label + ':' + name); } });
          }
        }
        guest.emit('context-menu', {}, { linkURL: chromeError });
        rightClickError = items.some((item) => item.label === '在新标签打开链接');
        guest.emit('context-menu', {}, { linkURL: allowed });
        const open = items.find((item) => item.label === '在新标签打开链接');
        rightClickHttp = Boolean(open);
        open?.click();
      } finally {
        Menu.prototype.popup = originalPopup;
      }
      return { prevented, rightClickError, rightClickHttp };
    }, { id, origin, chromeError });
    assert.deepEqual(routes, {
      prevented: ['host:will-frame-navigate', 'host:will-redirect', 'guest:will-frame-navigate', 'guest:will-redirect'],
      rightClickError: false,
      rightClickHttp: true,
    });
    await page.getByRole('button', { name: '在系统浏览器打开', exact: true }).click();
    await page.evaluate((url) => window.electron.openExternal(url), chromeError);
    const popupControl = await app.evaluate(async ({ webContents, BrowserWindow }, { id, origin, chromeError }) => {
      const guest = webContents.fromId(id);
      const host = BrowserWindow.getAllWindows()[0].webContents;
      const before = webContents.getAllWebContents().length;
      // The production <webview> omits allowpopups. Check the installed callbacks
      // directly so the default Chromium popup suppression cannot mask these branches.
      const guestLoads = [];
      const originalLoad = guest.loadURL;
      guest.loadURL = function (url) {
        guestLoads.push(url);
        return originalLoad.call(this, url);
      };
      const linked = origin + '/linked';
      const hostPopup = origin + '/host-popup';
      const results = [
        guest._windowOpenHandler({ url: chromeError }),
        guest._windowOpenHandler({ url: linked }),
        host._windowOpenHandler({ url: chromeError }),
        host._windowOpenHandler({ url: hostPopup }),
      ];
      guest.loadURL = originalLoad;
      for (let attempt = 0; attempt < 40 && guest.getURL() !== linked; attempt++) {
        await new Promise((done) => setTimeout(done, 50));
      }
      return {
        guestUrl: guest.getURL(),
        newContents: webContents.getAllWebContents().length - before,
        guestLoads,
        actions: results.map((result) => result.action),
      };
    }, { id, origin, chromeError });
    console.log('POPUP_CONTROL', JSON.stringify(popupControl));
    assert.deepEqual(popupControl, {
      guestUrl: origin + '/linked',
      newContents: 0,
      guestLoads: [origin + '/linked'],
      actions: ['deny', 'deny', 'deny', 'deny'],
    });
    const externalCalls = await app.evaluate(() => globalThis.externalCalls);
    assert.deepEqual(externalCalls, [origin + '/external', origin + '/host-popup']);
    console.log('ROUTES', JSON.stringify({ ...routes, popupControl, externalCalls }));
    console.log('PASS packaged Chromium error-page regression');
  } finally {
    if (app) await app.close();
    fixture.closeAllConnections();
    await new Promise((done) => fixture.close(done));
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
