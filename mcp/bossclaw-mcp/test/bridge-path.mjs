import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function runBridgePath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bossdot-bridge-path-'));
  const explicit = path.join(directory, 'explicit.json');
  const settings = path.join(directory, 'control-bridge.json');
  const program = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { CONTROL_BRIDGE_FILES, CONTROL_BRIDGE_FILE, readControlBridgeInfo, bridgeHint } from ${JSON.stringify(new URL('../src/context.mjs', import.meta.url).href)};
    const explicit = process.env.BOSSCLAW_CONTROL_BRIDGE_FILE;
    const settings = ${JSON.stringify(settings)};
    assert.deepEqual(CONTROL_BRIDGE_FILES, [explicit, settings]);
    assert.equal(CONTROL_BRIDGE_FILE, explicit);
    assert.equal(await readControlBridgeInfo(), null);
    fs.writeFileSync(explicit, JSON.stringify({ port: 17698 }));
    fs.writeFileSync(settings, JSON.stringify({ port: 17699, token: 'fixture', pid: process.pid }));
    assert.equal((await readControlBridgeInfo()).infoFile, settings);
    fs.writeFileSync(explicit, JSON.stringify({ port: 17698, token: 'fixture', pid: process.pid }));
    assert.equal((await readControlBridgeInfo()).infoFile, explicit);
    assert.ok(bridgeHint().includes(settings));
  `;
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', program], {
      env: { ...process.env, BOSSCLAW_USERDATA: directory, BOSSCLAW_CONTROL_BRIDGE_FILE: explicit },
      stdio: 'pipe',
      windowsHide: true,
    });
    return 0;
  } catch (error) {
    console.error(error.stderr?.toString() || error.message);
    return 1;
  } finally {
    fs.rmSync(explicit, { force: true });
    fs.rmSync(settings, { force: true });
    fs.rmdirSync(directory);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runBridgePath();
  if (!process.exitCode) console.log('PASS: 显式桥路径优先，隔离配置作为回退');
}
