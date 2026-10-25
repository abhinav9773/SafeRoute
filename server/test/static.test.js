import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';

async function withApp(distDir, check) {
  process.env.FRONTEND_DIST = distDir;
  const { app, manager } = createApp();
  delete process.env.FRONTEND_DIST;
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try { await check(`http://127.0.0.1:${server.address().port}`); }
  finally { manager.shutdown(); await new Promise((r) => server.close(r)); }
}

test('serves the built dashboard at / and keeps API routes', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dist-'));
  writeFileSync(path.join(dir, 'index.html'), '<html>dashboard</html>');
  await withApp(dir, async (base) => {
    assert.match(await (await fetch(`${base}/`)).text(), /dashboard/);
    assert.equal((await fetch(`${base}/topology`)).status, 200);
    assert.equal((await fetch(`${base}/metrics`)).status, 200);
  });
});

test('API still works without a build', async () => {
  await withApp(mkdtempSync(path.join(tmpdir(), 'empty-')), async (base) => {
    assert.equal((await fetch(`${base}/`)).status, 404);
    assert.equal((await fetch(`${base}/topology`)).status, 200);
  });
});
