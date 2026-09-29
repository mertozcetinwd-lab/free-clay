import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// The browser modules are never imported by the Worker tests, so a syntax error in one page
// (a broken string, a stray bracket) would pass every test and blank the whole app. This parses
// every file under public/js, the way the browser will.
const ROOT = fileURLToPath(new URL('../public/js/', import.meta.url));
const files = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : p.endsWith('.js') ? [p] : []; });

test('every browser module parses', () => {
  const bad = [];
  for (const f of files(ROOT)) {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
    catch (e) { bad.push(`${f.slice(ROOT.length)}: ${String(e.stderr).split('\n').find((l) => /Error/.test(l)) || 'parse error'}`); }
  }
  assert.deepEqual(bad, []);
});
