import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
const script = new URL('../setup.mjs', import.meta.url);

test('reports missing entries in a partial env without changing existing credentials', () => {
  const directory = mkdtempSync(join(tmpdir(), 'velio-env-'));
  const original = '# Keep these\nPOSTGRES_PASSWORD=existing-secret\nPORT=3101\n';
  try {
    writeFileSync(join(directory, '.env'), original);
    const result = spawnSync(process.execPath, [script.pathname], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DATABASE_URL/);
    assert.match(result.stderr, /preserve existing/i);
    assert.ok(!result.stderr.includes('existing-secret'));
    assert.equal(readFileSync(join(directory, '.env'), 'utf8'), original);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
