'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { createInterface } = require('node:readline');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtemp, mkdir, readFile, readdir, stat } = require('node:fs/promises');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const windowHitTest = require('./window-hit-test.cjs');

const packageRoot = resolve(__dirname, '../desktop-app');
const appRequire = createRequire(join(packageRoot, 'package.json'));
const { _electron } = appRequire('playwright-core');
const mammoth = appRequire('mammoth');
const executablePath = process.env.BOSSDOT_QA_EXE || join(packageRoot, 'release', 'win-unpacked', 'BossDot.exe');
const registration = require('../.mcp.json').mcpServers.bossdot;
const onlineResumeUrl = 'https://www.zhipin.com/web/geek/resume';
const onlineResumeFixture = [
  '在线简历', '期望职位', '工作经历', '项目经历', '教育经历', '手机号：13800000000',
  '期望职位', '全职职位', 'AI产品经理20-40K上海，广州', '海外运营18-30K上海，深圳',
  '工作经历', '甲公司：整理跨平台营销数据', '项目经历', '协作工具原型',
  '教育经历', '外部区域',
].map((line) => `<div>${line}</div>`).join('');
const identity = require(join(packageRoot, 'resources', 'app-identity.json'));
const claims = '使用业务样本检查工具输出，记录结果并写成操作说明';
const greeting = '您好，我想应聘贵公司的AI方案顾问岗位。我注意到这个职位要从日常业务任务里梳理工具使用场景。我曾用业务样本检查输出，并把测试结果写成操作说明，希望进一步了解团队目前遇到的流程问题，也可以在交流中说明我实际做过的测试和整理工作。感谢您阅读。';
const original = `姓名：测试用户\n甲公司；正式工作｜2024.02—2024.08\n${claims}\n`;
const draft = (source = claims) => JSON.stringify({
  tailoredSummary: '业务场景测试与操作说明',
  coverLetter: greeting,
  resume: { works: [{ heading: '甲公司', meta: '2024.02—2024.08', bullets: [{ text: claims, source }] }] },
  jdPoints: [{ point: '应用测试', layer: 'duty', verdict: 'covered', evidence: claims }],
  matchScore: { before: 60, after: 70 },
});
const review = JSON.stringify({ reviewPassed: true, reviewNote: '本地测试复检通过' });
let draftCalls = 0;
let reviewCalls = 0;
let rejectEvidence = false;
const model = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    assert.equal(req.headers.authorization, 'Bearer local-openai-fixture');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-6-luna' }, { id: 'qa-catalog-only' }, { id: 'qa-catalog-only' }] }));
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (req.url === '/v1/responses') {
    assert.equal(payload.model, 'gpt-6-luna');
    assert.equal(payload.text.format.type, 'json_object');
    assert.equal(payload.reasoning.effort, 'none');
    assert.ok(payload.max_output_tokens >= 256);
    assert.deepEqual(Object.keys(payload).sort(), ['input', 'max_output_tokens', 'model', 'reasoning', 'text']);
    assert.match(payload.input.find(({ role }) => role === 'user').content, /"ok":true/);
    if (req.headers.authorization === 'Bearer local-quota-fixture') {
      res.writeHead(429, { 'content-type': 'application/json', 'x-request-id': 'req-offline-quota' });
      res.end(JSON.stringify({ error: { code: 'insufficient_quota', message: 'Quota expired for local-quota-fixture' } }));
    } else {
      assert.equal(req.headers.authorization, 'Bearer local-openai-fixture');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: 'completed',
        output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
      }));
    }
    return;
  }
  const messages = payload.messages.map(({ content }) => content).join('\n');
  let reply;
  if (payload.response_format?.type !== 'json_object') {
    reply = greeting;
  } else if (messages.includes('草稿：')) {
    reviewCalls++;
    reply = review;
  } else {
    draftCalls++;
    reply = draft(rejectEvidence ? '甲公司；正式工作' : claims);
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
});

async function runMcpRound(profileDir, generate, exportButton) {
  const child = spawn(registration.command, registration.args, {
    cwd: resolve(packageRoot, '..'),
    env: { ...process.env, ...registration.env, BOSSCLAW_EXE: executablePath, BOSSCLAW_USERDATA: profileDir },
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const replies = createInterface({ input: child.stdout });
  const pending = new Map();
  let sequence = 0;
  replies.on('line', (raw) => {
    const response = JSON.parse(raw);
    pending.get(response.id)?.(response);
  });
  function rpc(method, params) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP timed out: ${method}`));
      }, 10000);
      pending.set(id, (response) => {
        clearTimeout(timer);
        pending.delete(id);
        if (response.error) reject(new Error(response.error.message));
        else resolve(response.result);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async function call(name, args = {}) {
    const response = await rpc('tools/call', { name, arguments: args });
    assert.ok(!response.isError, response.content?.[0]?.text);
    return response.structuredContent;
  }
  try {
    const server = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bossdot-local-qa', version: '1' } });
    assert.equal(server.serverInfo.name, 'bossclaw-mcp');
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    assert.equal((await rpc('tools/list', {})).tools.length, 9);
    const state = await call('bossclaw_app_state');
    assert.equal(state.app.bossLoggedIn, false);
    const status = await call('bossclaw_app_status');
    assert.equal(status.running, true);
    assert.equal(Object.hasOwn(status.bridge, 'token'), false);
    const profile = (await call('bossclaw_app_action', { action: 'browserReadBossProfile' })).next;
    assert.deepEqual(profile.intents, [
      { jobTitle: 'AI产品经理', employmentType: '全职', salary: '20-40K', cities: ['上海', '广州'] },
      { jobTitle: '海外运营', employmentType: '全职', salary: '18-30K', cities: ['上海', '深圳'] },
    ]);
    assert.equal(profile.workExperience, '甲公司：整理跨平台营销数据');
    assert.equal(profile.projectExperience, '协作工具原型');
    assert.doesNotMatch(JSON.stringify(profile), /13800000000|外部区域/);
    assert.equal((await call('bossclaw_app_action', { action: 'navigate', params: { route: 'assistant' } })).applied, true);
    assert.equal((await call('bossclaw_agent_tasks', { includeMessages: false })).online, true);
    await generate.click();
    let agentDrafts = 0;
    let agentReviews = 0;
    for (let attempt = 0; attempt < 12 && !(await exportButton.isVisible()); attempt++) {
      const { tasks } = await call('bossclaw_agent_tasks', { waitMs: 1800 });
      for (const task of tasks) {
        const messages = task.messages.map(({ content }) => content).join('\n');
        let content = greeting;
        if (task.jsonMode) {
          if (messages.includes('草稿：')) {
            agentReviews++;
            content = review;
          } else {
            assert.match(messages, /【AI 技能 · 岗位定制简历】/);
            assert.doesNotMatch(messages, /【AI 技能 · JD 拆解方法/);
            agentDrafts++;
            content = draft();
          }
        }
        assert.equal((await call('bossclaw_agent_submit', { id: task.id, content })).applied, true);
      }
    }
    await exportButton.waitFor({ timeout: 12000 });
    assert.ok(agentDrafts > 0 && agentReviews > 0);
    return { agentDrafts, agentReviews, mcpTools: 9, signedIn: state.app.bossLoggedIn };
  } finally {
    child.stdin.end();
    replies.close();
  }
}

async function run() {
  const outputRoot = join(__dirname, 'electron-output');
  await mkdir(outputRoot, { recursive: true });
  const output = await mkdtemp(join(outputRoot, 'run-'));
  await new Promise((done) => model.listen(0, '127.0.0.1', done));
  const profileDir = await mkdtemp(join(tmpdir(), 'bossdot-native-qa-'));
  const launch = () => _electron.launch({
    executablePath,
    args: [`--user-data-dir=${profileDir}`, '--disable-gpu', '--disable-backgrounding-occluded-windows', '--proxy-server=http://127.0.0.1:9'],
    env: { ...process.env, BOSSCLAW_CONTROL: '1', BOSSCLAW_DEBUG: '0' },
    timeout: 20000,
  });
  const app = await launch();
  let agentResult;
  try {
    await app.evaluate(({ dialog }, directory) => {
      dialog.showSaveDialog = async (_window, options) => ({
        canceled: false,
        filePath: directory + '\\' + options.defaultPath.split(/[\\/]/).at(-1),
      });
    }, output);
    const page = await app.firstWindow({ timeout: 12000 });
    const nav = page.getByRole('navigation', { name: '主导航' });
    const home = page.getByRole('heading', { name: '今天的求职工作' });
    const openWorkbench = page.locator('.hero-actions').getByRole('button', { name: '打开工作台' });
    const screenshot = (name) => page.screenshot({ path: join(output, name + '.png'), animations: 'disabled' });
    await home.waitFor();
    await page.locator('.ant-notification-notice')
      .filter({ hasText: '未配置大模型 API Key' }).locator('.ant-notification-notice-close').click();
    const runtime = await app.evaluate(({ app, BrowserWindow, nativeImage }, iconName) => ({
      name: app.getName(),
      title: BrowserWindow.getAllWindows()[0].getTitle(),
      profile: app.getPath('userData'),
      icon: !nativeImage.createFromPath(process.resourcesPath + '/app.asar.unpacked/resources/' + iconName).isEmpty(),
      engineAdapter: process.getBuiltinModule('node:fs').existsSync(process.resourcesPath + '/app.asar.unpacked/electron/preload/liepin-im.cjs'),
    }), 'bossdot.ico');
    assert.deepEqual(runtime, { name: 'BossDot', title: 'BossDot', profile: profileDir, icon: true, engineAdapter: true });
    assert.equal(await page.title(), 'BossDot');
    assert.deepEqual(await windowHitTest(app, page), [2, 2, 1, 1]);
    assert.ok((await stat(join(profileDir, 'engines', 'camoufox-token'))).size > 0);

    const setWindowSize = (width, height) =>
      app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await page.getByRole('button', { name: '浅色' }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    const palette = await page.evaluate(() => ({
      brand: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim(),
      windowPattern: getComputedStyle(document.querySelector('.app-shell')).backgroundImage,
      blurredSurfaces: ['.title-bar', '.side-rail', '.home-page .hero'].map((selector) =>
        getComputedStyle(document.querySelector(selector)).backdropFilter),
      cardSurfaces: Array.from(document.querySelectorAll('.home-page .hero, .home-metrics .metric-card'),
        (card) => getComputedStyle(card).backgroundColor),
    }));
    assert.equal(palette.brand, '#0D9488');
    assert.match(palette.windowPattern, /radial-gradient/);
    for (const filter of palette.blurredSurfaces) assert.match(filter, /blur\(16px\)/);
    assert.equal(new Set(palette.cardSurfaces).size, 4);
    await screenshot('home-light');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
    });
    const reducedTransparency = await page.locator('.home-page .hero').evaluate((hero) => ({
      filter: getComputedStyle(hero).backdropFilter,
      opacity: getComputedStyle(hero).getPropertyValue('--glass-opacity').trim(),
    }));
    assert.deepEqual(reducedTransparency, { filter: 'none', opacity: '1' });
    await screenshot('home-reduced-transparency');
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    await cdp.detach();
    await page.getByRole('button', { name: '深色' }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await screenshot('home-dark');
    await setWindowSize(960, 720);
    await nav.locator('.is-active[aria-current="page"]').waitFor();
    await page.waitForFunction(() => document.querySelector('.side-rail.is-collapsed'));
    assert.equal(await openWorkbench.isVisible(), true);
    await screenshot('home-960');
    await setWindowSize(1440, 900);
    await page.getByRole('button', { name: '浅色' }).click();
    await openWorkbench.click();
    await page.getByText('岗位进度', { exact: true }).waitFor();
    assert.deepEqual(await windowHitTest(app, page), [2, 2, 1, 1]);
    const sampleUrl = 'https://www.zhipin.com/bossdot-qa-zoom';
    const readGuestZoom = async (expected) => {
      await page.waitForFunction((factor) => {
        const guest = document.querySelector('.workbench-host.is-active .browser-pane.is-active webview');
        try { return Math.abs(guest.getZoomFactor() - factor) < 0.005; } catch { return false; }
      }, expected, { timeout: 8000 });
      return app.evaluate(async ({ webContents }, { address, expectedDpr }) => {
        const guest = webContents.getAllWebContents().find((item) => item.getType() === 'webview' && item.getURL() === address);
        if (!guest) throw new Error('Missing zoom sample webview');
        for (let attempt = 0; attempt < 40; attempt++) {
          const metrics = await guest.executeJavaScript('({ width: innerWidth, dpr: devicePixelRatio })');
          if (Math.abs(metrics.dpr - expectedDpr) < 0.02) return metrics.width;
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        throw new Error('Guest viewport did not receive the requested zoom');
      }, { address: sampleUrl, expectedDpr: expected * hostZoom });
    };
    await app.evaluate(({ webContents }, { address, profileUrl, profileHtml }) => {
      const guest = webContents.getAllWebContents().find((item) => item.getType() === 'webview');
      if (!guest) throw new Error('Missing workbench webview');
      const route = guest.session.protocol.interceptStringProtocol('https', (request, respond) => {
        const url = new URL(request.url);
        if (url.pathname === '/wapi/zpgeek/search/joblist.json' && url.searchParams.get('city') === '101020100') {
          const data = url.searchParams.get('query') === '离线拦截样本'
            ? { code: 37, message: '环境异常（离线样本）' }
            : { code: 0, zpData: { jobList: [{ jobName: '测试岗位' }] } };
          return respond({ mimeType: 'application/json', charset: 'utf-8', data: JSON.stringify(data) });
        }
        if (request.url !== address && request.url !== profileUrl) return respond({ error: -2 });
        respond({
          mimeType: 'text/html',
          charset: 'utf-8',
          data: request.url === profileUrl
            ? '<!doctype html><meta charset="utf-8"><title>BOSS 在线简历</title>' + profileHtml
            : '<!doctype html><meta charset="utf-8"><title>网页缩放验收</title><main style="width:100%;font-size:24px">内置网页缩放样本</main>',
        });
      });
      if (!route) throw new Error('Cannot install offline zoom fixture');
    }, { address: sampleUrl, profileUrl: onlineResumeUrl, profileHtml: onlineResumeFixture });
    const addressBar = page.getByPlaceholder('输入网址后回车');
    await addressBar.fill(sampleUrl);
    await addressBar.press('Enter');
    await page.waitForFunction(() => {
      const guest = document.querySelector('.workbench-host.is-active .browser-pane.is-active webview');
      try { return guest.getTitle() === '网页缩放验收'; } catch { return false; }
    }, null, { timeout: 10_000 });
    const zoomGroup = page.getByRole('group', { name: '网页缩放' });
    const hostZoom = await page.evaluate(() => window.devicePixelRatio);
    const initial = await readGuestZoom(0.9);
    await zoomGroup.getByRole('button', { name: '缩小网页' }).click();
    const reduced = await readGuestZoom(0.8);
    assert.ok(reduced > initial);
    await zoomGroup.getByRole('button', { name: /恢复 100%/ }).click();
    const reset = await readGuestZoom(1);
    assert.ok(reset < initial);
    await zoomGroup.getByRole('button', { name: '放大网页' }).click();
    await readGuestZoom(1.1);
    assert.equal(await page.evaluate(() => window.devicePixelRatio), hostZoom);
    await screenshot('workbench-webview-zoom');
    await screenshot('workbench-offline');
    await page.getByRole('button', { name: '读取 BOSS 资料' }).click();
    const onlineProfile = page.getByRole('dialog', { name: 'BOSS 线上资料' });
    await onlineProfile.getByText('AI产品经理', { exact: true }).waitFor();
    await onlineProfile.getByText('全职 · 20-40K · 上海、广州', { exact: true }).waitFor();
    await onlineProfile.getByText('工作经历', { exact: true }).click();
    await onlineProfile.getByText('甲公司：整理跨平台营销数据', { exact: true }).waitFor();
    await screenshot('boss-online-profile');
    await onlineProfile.locator('.ant-modal-close').click();
    assert.equal(await addressBar.inputValue(), sampleUrl);
    await addressBar.fill(onlineResumeUrl);
    await addressBar.press('Enter');
    await page.waitForFunction((url) => {
      const guest = document.querySelector('.browser-pane.is-active webview');
      try { return !guest.isLoading() && guest.getURL() === url && guest.getTitle() === 'BOSS 在线简历'; } catch { return false; }
    }, onlineResumeUrl);
    await page.locator('.browser-pane.is-active webview').evaluate((guest) => {
      const navigation = new Event('did-start-navigation');
      Object.defineProperty(navigation, 'isMainFrame', { value: true });
      guest.dispatchEvent(navigation);
    });
    await page.getByRole('button', { name: '读取 BOSS 资料' }).click();
    await onlineProfile.getByText('AI产品经理', { exact: true }).waitFor();
    await onlineProfile.locator('.ant-modal-close').click();
    await addressBar.fill(sampleUrl);
    await addressBar.press('Enter');
    await page.waitForFunction((url) => {
      const guest = document.querySelector('.browser-pane.is-active webview');
      try { return !guest.isLoading() && guest.getURL() === url && guest.getTitle() === '网页缩放验收'; } catch { return false; }
    }, sampleUrl);
    const navigation = await app.evaluate(({ BrowserWindow, shell }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const originalOpen = shell.openExternal;
      const opened = [];
      let prevented = 0;
      shell.openExternal = async (url) => { opened.push(url); };
      try {
        const event = { preventDefault() { prevented++; } };
        contents.emit('will-navigate', event, 'chrome-error://chromewebdata/');
        contents.emit('will-navigate', event, 'https://example.invalid/');
        return { prevented, opened };
      } finally { shell.openExternal = originalOpen; }
    });
    assert.deepEqual(navigation, { prevented: 2, opened: ['https://example.invalid/'] });
    const dispatch = (action, params) => page.evaluate(({ action, params }) =>
      window.__bossclawControl.dispatch({ action, params }), { action, params });
    const search = await dispatch('browserSearch', { query: '离线搜索样本', city: '上海', recordTask: true });
    assert.equal(search.applied, true, JSON.stringify(search));
    const restricted = await dispatch('browserSearch', { query: '离线拦截样本', city: '上海', recordTask: true });
    assert.equal(restricted.applied, false);
    const runs = (await dispatch('appDataFull', { sections: ['taskRuns'] })).next.sections.taskRuns.items;
    assert.equal(runs.find((item) => item.id === search.taskId).discovered, 1);
    assert.equal(runs.find((item) => item.id === restricted.taskId).status, 'failed');
    await nav.getByRole('button', { name: '设置' }).click();
    await page.getByRole('tab', { name: 'AI / LLM 配置' }).click();
    const skills = page.locator('.settings-section-card').filter({ hasText: 'AI 技能（Skills 层）' });
    const toggles = skills.getByRole('switch');
    await toggles.last().waitFor();
    assert.equal(await toggles.count(), 9);
    const jdReading = skills.getByRole('switch', { name: 'JD 拆解方法（读 JD 再定制）' });
    const toggleStates = () => toggles.evaluateAll((items) => items.map((item) => item.getAttribute('aria-checked')));
    const defaults = await toggleStates();
    assert.equal(await jdReading.getAttribute('aria-checked'), 'false');
    await jdReading.click();
    assert.equal(await jdReading.getAttribute('aria-checked'), 'true');
    assert.equal((await toggleStates()).filter((state, i) => state !== defaults[i]).length, 1);
    await jdReading.click();
    assert.deepEqual(await toggleStates(), defaults);
    await screenshot('skills');
    await page.locator('.main-stage').evaluate((stage) => stage.scrollTo({ top: 0, behavior: 'instant' }));
    const apiCard = page.locator('.settings-section-card').filter({ hasText: '大模型服务商与 API 接入' });
    const providerPicker = apiCard.locator('.ant-select-selector').first();
    const providerOption = (name) => page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content')
      .filter({ hasText: new RegExp(`^${name}$`) }).first();
    await providerPicker.click();
    await providerOption('OpenAI').click();
    await apiCard.getByText('https://api.openai.com/v1/responses', { exact: true }).waitFor();
    assert.equal(await apiCard.getByRole('textbox', { name: '模型上下文长度' }).isDisabled(), true);
    assert.equal(await apiCard.getByText('本地输入用量').isVisible(), false);
    await apiCard.getByPlaceholder('https://api.openai.com/v1').fill(`http://127.0.0.1:${model.address().port}/v1/responses`);
    const openAIKey = apiCard.getByPlaceholder('输入 OpenAI 的 API Key');
    await openAIKey.fill('local-openai-fixture');
    assert.equal(await openAIKey.inputValue(), 'local-openai-fixture');
    const openAIConfig = (await dispatch('state', {})).next.settings.config.model;
    assert.match(openAIConfig.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1\/responses$/);
    assert.ok(openAIConfig.apiKey);
    const catalogPicker = apiCard.locator('.llm-keyrow .ant-select-selector');
    await catalogPicker.click();
    await apiCard.getByText('接口返回 2 个模型', { exact: true }).waitFor();
    await apiCard.getByRole('combobox', { name: '模型 ID' }).fill('qa-catalog-only');
    await providerOption('qa-catalog-only').click();
    assert.equal(await apiCard.locator('.ant-select-selection-item[title="qa-catalog-only"]').count(), 1);
    await catalogPicker.click();
    await providerOption('gpt-6-luna').click();
    await apiCard.getByRole('button', { name: '测试连接' }).click();
    await apiCard.getByText('模型已返回有效 JSON').waitFor();
    await openAIKey.fill('local-quota-fixture');
    const quota = await dispatch('modelTestConnection', {});
    assert.equal(quota.next.details.providerCode, 'insufficient_quota');
    assert.equal(quota.next.details.requestId, 'req-offline-quota');
    assert.doesNotMatch(quota.message, /local-quota-fixture/);
    await providerPicker.click();
    await providerOption('DeepSeek').click();
    assert.equal(await apiCard.getByPlaceholder('输入 DeepSeek 的 API Key').inputValue(), '');
    await providerPicker.click();
    await providerOption('OpenAI').click();
    assert.equal(await openAIKey.inputValue(), 'local-quota-fixture');
    await openAIKey.fill('');
    await apiCard.getByRole('button', { name: '应用官方预设' }).click();
    await providerPicker.click();
    await providerOption('DeepSeek').click();
    await screenshot('settings-light');

    await page.evaluate(() => window.electron.send('jc:bridge-control', 'start'));
    await page.waitForFunction(async (port) => {
      try {
        const token = await window.electron.bridgeToken();
        const res = await fetch('http://127.0.0.1:' + port + '/status', { headers: { 'X-Bossclaw-Token': token } });
        return res.ok;
      } catch {
        return false;
      }
    }, identity.bridgePort, { timeout: 8000 });
    assert.ok((await stat(join(profileDir, 'engines', 'bridge-token'))).size > 0);
    await page.evaluate(() => window.electron.send('jc:bridge-control', 'stop'));
    await page.getByPlaceholder('https://api.deepseek.com').fill(`http://127.0.0.1:${model.address().port}`);
    await page.getByPlaceholder('输入 DeepSeek 的 API Key').fill('local-fixture');
    assert.equal((await dispatch('dataSetResume', { text: original, fileName: 'qa-fixture.md' })).applied, true);
    assert.equal((await dispatch('dataSetProfile', { profile: { facts: { experiences: ['甲公司；正式工作'] } } })).applied, true);
    assert.equal((await dispatch('navigate', { route: 'assistant' })).applied, true);
    const title = page.getByPlaceholder('如：前端开发工程师（实习）');
    await title.waitFor();
    await screenshot('resume-tailor');
    const jd = page.getByPlaceholder('选择工作台岗位后自动填入，也可手动补充岗位职责与任职要求…');
    const generate = page.getByRole('button', { name: 'AI 生成定制简历' });
    const exportButton = page.getByRole('button', { name: '导出定制简历 PDF' });
    await title.fill('AI方案顾问');
    await jd.fill('业务应用场景梳理，协助测试工具输出并整理使用说明。');
    await generate.click();
    await exportButton.waitFor({ timeout: 12000 });
    assert.ok(draftCalls > 0 && reviewCalls > 0, JSON.stringify({
      reason: 'The test model must see drafting and review',
      draftCalls, reviewCalls,
      alerts: await page.locator('.ant-alert-message,.ant-message-notice-content').allTextContents(),
    }));
    for (const format of ['DOCX', 'PDF']) {
      await exportButton.click();
      const modal = page.getByRole('dialog', { name: '导出定制简历' });
      if (format === 'DOCX') {
        const modalFilter = await modal.locator('.ant-modal-content').evaluate((content) =>
          getComputedStyle(content).backdropFilter);
        assert.match(modalFilter, /blur\(16px\)/);
        await page.waitForFunction(() => {
          const panel = document.querySelector('.resume-export-modal');
          if (!panel) return false;
          const style = getComputedStyle(panel);
          return style.opacity === '1' && style.transform === 'none';
        });
        await screenshot('resume-export-dialog');
      }
      await modal.getByText(format, { exact: true }).first().click();
      await modal.getByRole('button', { name: '生成并保存' }).click();
      const expectedExt = format.toLowerCase();
      await page.getByText(new RegExp('已保存：.*\\.' + expectedExt + '$')).waitFor();
      const files = (await readdir(output)).filter((file) => file.endsWith('.' + expectedExt));
      assert.equal(files.length, 1);
      const bytes = await readFile(join(output, files[0]));
      if (format === 'PDF') assert.ok(bytes.subarray(0, 5).equals(Buffer.from('%PDF-')));
      else assert.match((await mammoth.extractRawText({ buffer: bytes })).value, /工具输出/);
      await modal.locator('.ant-modal-close').click();
    }
    const databasePath = join(profileDir, 'tailor-checkpoints.sqlite');
    assert.ok((await stat(databasePath)).size > 0);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tailor_checkpoints').get().count, 1);
    database.close();
    rejectEvidence = true;
    await title.fill('错误来源回归');
    await generate.click();
    await exportButton.waitFor({ timeout: 12000 });
    await exportButton.click();
    await page.getByRole('dialog', { name: '导出定制简历' }).getByRole('button', { name: '生成并保存' }).click();
    await page.getByText(/摘录未覆盖完整表述/).waitFor();
    await page.getByRole('dialog', { name: '导出定制简历' }).locator('.ant-modal-close').click();
    await nav.getByRole('button', { name: '设置' }).click();
    await page.getByRole('tab', { name: 'AI / LLM 配置' }).click();
    await page.getByPlaceholder('输入 DeepSeek 的 API Key').fill('');
    await nav.getByRole('button', { name: '定制简历' }).click();
    await title.fill('Agent 定制回归');
    agentResult = await runMcpRound(profileDir, generate, exportButton);
    await exportButton.click();
    const agentExport = page.getByRole('dialog', { name: '导出定制简历' });
    await agentExport.getByText('DOCX', { exact: true }).first().click();
    await agentExport.getByRole('button', { name: '生成并保存' }).click();
    await page.getByText(/已保存：.*Agent.*\.docx/).waitFor();
    await agentExport.locator('.ant-modal-close').click();
    await nav.getByRole('button', { name: '设置' }).click();
    await jdReading.click();
    assert.equal(await jdReading.getAttribute('aria-checked'), 'true');
  } finally {
    await app.close();
  }

  const restarted = await launch();
  try {
    const page = await restarted.firstWindow({ timeout: 12000 });
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '设置' }).click();
    await page.getByRole('tab', { name: 'AI / LLM 配置' }).click();
    const reading = page.getByRole('switch', { name: 'JD 拆解方法（读 JD 再定制）' });
    await reading.waitFor();
    assert.equal(await reading.getAttribute('aria-checked'), 'true');
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '工作台' }).click();
    await page.getByRole('group', { name: '网页缩放' }).getByRole('button', { name: '网页缩放 110%，恢复 100%' }).waitFor();
  } finally {
    await restarted.close();
  }
  console.log(JSON.stringify({ brand: 'BossDot', ...agentResult, nativeWindowDrag: true, onlineProfileUiAndMcp: true, webviewZoomAndPersistence: true, themeAndNarrowWindow: true, skills: 9, independentJdToggle: true, skillPersistsAfterRestart: true, bridgePort: identity.bridgePort, draftCalls, reviewCalls, sqliteWritten: true, docx: true, pdf: true, invalidSourceBlocked: true, chromeErrorBlocked: true, files: output }));
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => model.close());
