import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { openTailorCheckpoints } from '../electron/tailor-checkpoints.cjs';

const projectRequire = createRequire(import.meta.url);
const built = await build({
  stdin: {
    contents: [
      'jobAssistant', 'resumeContact', 'resumeDocx', 'resumePdf', 'tailorWorkflow',
    ].map((module) => `export * from './${module}'`).join(';\n'),
    resolveDir: resolve('src/lib/bossclaw'),
  },
  bundle: true, format: 'cjs', platform: 'node', tsconfig: 'tsconfig.json', packages: 'external', write: false,
  logLevel: 'error',
});

const requestLog = [];
let nextDraft;
let failReview = false;
const storage = new Map();
globalThis.document = new EventTarget();
globalThis.window = Object.assign(new EventTarget(), {
  electron: {
    async llmProxy(_url, payload) {
      const prompt = payload.messages.map((entry) => entry.content).join('\n');
      const isReview = prompt.includes('草稿：');
      requestLog.push({ isReview, prompt });
      if (isReview && failReview) return { ok: false, error: 'fixture failure', status: 503 };
      const reply = { choices: [{ message: { content: JSON.stringify(isReview ? { reviewPassed: true, reviewNote: '模拟复检通过' } : nextDraft) } }] };
      return { ok: true, status: 200, text: JSON.stringify(reply) };
    },
  },
});
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key),
} });
const exportsObject = { exports: {} };
new Function('module', 'exports', 'require', built.outputFiles[0].text)(exportsObject, exportsObject.exports, projectRequire);
const {
  buildResumeDocData, buildResumeDocx, buildResumeHtml, EMPTY_TAILOR_DOC,
  hasUnexportableTailorContent, runTailorWorkflow, tailorForJob, tailorRunId,
} = exportsObject.exports;

const args = process.argv.slice(2);
const fixture = await readFile(args[0], 'utf8');
const material = await readFile(args[1], 'utf8');
const output = args[2] && resolve(args[2]);
if (output) await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'bossclaw-tailor-qa-'));
const databasePath = join(scratch, 'checkpoints.sqlite');
const model = { apiKey: 'local-fixture', baseUrl: 'http://127.0.0.1:1', model: 'local-fixture', provider: 'openai' };
const profile = { facts: { education: [], experiences: [], skills: [] }, summary: '' };
const greeting = '您好，我想应聘贵公司的AI应用方案与用户赋能顾问。我关注岗位里需要把业务需求转成工具使用方案的部分。过去参与工具测试、应用演示和使用指导，能够用具体的业务步骤说明工具适用的场景。我希望进一步了解团队当前服务的业务部门和推进方式，也愿意在交流中说明我做过的实际工作。感谢您阅读。';

try {
  const text = material.match(/- 原文：“(直接对接[^\r\n]+)”/)?.[1];
  assert.ok(text);
  nextDraft = {
    tailoredSummary: 'AI 应用场景测试和使用支持',
    coverLetter: greeting,
    resume: {
      ...EMPTY_TAILOR_DOC,
      works: [{ heading: '示例运营团队', meta: '2023.07—2024.01', bullets: [] }],
      projects: [{ heading: '示例工具应用项目', meta: '2024.02—2024.04', bullets: [{ text, source: text }] }],
    },
    jdPoints: [{ point: '应用演示', layer: 'duty', verdict: 'covered', evidence: '应用演示与使用指导' }],
    matchScore: { before: 60, after: 68 },
  };
  const job = { title: 'AI 应用方案与用户赋能顾问', company: '模拟岗位', description: fixture };
  const source = '【补充材料：02_素材包.md】\n' + material;
  const generate = () => tailorForJob(job, '简历测试材料', profile, model, undefined, source);
  const runId = await tailorRunId({ fixture: 'original simulated JD' });
  let database = openTailorCheckpoints(databasePath);
  const store = {
    read: async (id) => database.read(id),
    write: async (id, snapshot) => database.write(id, snapshot),
  };
  await assert.rejects(runTailorWorkflow(store, runId, async () => { throw new Error('模拟生成中断'); }), /模拟生成中断/);
  assert.ok(database.read(runId), '中断前已保存检查点');
  database.close();
  database = openTailorCheckpoints(databasePath);
  const result = await runTailorWorkflow(store, runId, generate);
  assert.equal(result.method, 'ai', result.warning);
  assert.equal(result.reviewCompleted, true, result.warning);
  assert.equal(hasUnexportableTailorContent(result), false, JSON.stringify(result.evidence?.filter((item) => item.issue)));
  assert.ok(result.evidence.every((item) => item.source.material === '02_素材包.md'));
  assert.equal(requestLog.filter((item) => item.isReview).length, 1);
  assert.ok(!requestLog[0].prompt.includes('JD 拆解方法（读 JD 再定制）'));
  database.close();
  database = openTailorCheckpoints(databasePath);
  const restored = await runTailorWorkflow(store, runId, () => { throw new Error('恢复时不应再次生成'); }, true);
  assert.deepEqual(restored.doc, result.doc);
  assert.deepEqual(restored.evidence, result.evidence);
  database.close();

  const chinese = buildResumeDocData('', null, result, {
    name: '本地模拟样例', targetTitle: job.title, email: 'fixture@example.test',
  });
  const english = buildResumeDocData('', null, {
    ...result,
    language: 'en',
    doc: { ...EMPTY_TAILOR_DOC, works: [{ heading: 'Sample company', meta: '2024.02–2024.08', bullets: [{ text: 'Reviewed product usage.', source: 'Reviewed product usage.' }] }] },
  }, { name: 'Local test fixture', targetTitle: 'AI Applications Associate', email: 'fixture@example.test' });
  for (const [name, data, expected] of [['sample-zh', chinese, '示例工具应用项目'], ['sample-en', english, 'Professional experience']]) {
    const bytes = Buffer.from(await buildResumeDocx(data));
    const archive = await JSZip.loadAsync(bytes);
    assert.ok(archive.file('[Content_Types].xml'));
    assert.ok(archive.file('_rels/.rels'));
    const decoded = await mammoth.extractRawText({ buffer: bytes });
    assert.ok(decoded.value.includes(expected), `${name} 的正文不可读`);
    const html = buildResumeHtml(data);
    assert.ok(html.includes(expected), `${name} 的 PDF 渲染输入缺少正文`);
    if (output) {
      await writeFile(join(output, name + '.docx'), bytes);
      await writeFile(join(output, name + '.html'), html);
    }
  }
  if (output) await writeFile(join(output, 'sample-zh-evidence.json'), JSON.stringify(result.evidence, null, 2));

  failReview = true;
  const failed = await tailorForJob({ ...job, title: '模拟复检失败' }, '简历测试材料', profile, model, undefined, source);
  assert.equal(failed.reviewCompleted, false);
  assert.equal(hasUnexportableTailorContent(failed), true);
  console.log('PASS: 原模拟 JD、原文映射、模型复检失败阻断、LangGraph SQLite 中断恢复、双语 DOCX 解包与文字提取');
} finally {
  await rm(databasePath, { force: true });
  await rmdir(scratch);
}
