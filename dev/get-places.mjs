/**
 * Build the open-data tiles the Find leads page searches (public/js/open-places.js says why tiles).
 *
 *   node dev/get-places.mjs                  every state, downloaded from the public data repo
 *   node dev/get-places.mjs --states FL,GA   only these states
 *   node dev/get-places.mjs --from <dir>     use a copy of the repo's data/ folder already on disk
 *
 * Downloads go to dev/.places-cache (gitignored) and are reused on the next run. The build reads
 * each file twice, streaming: once to count places per map cell, once to write every place into
 * its tile, so memory stays small even for all ~14M US places. Output: public/data/places/
 * index.json and public/data/places/t/<level>_<y>_<x>.json (gitignored). `npx wrangler deploy`
 * then uploads the tiles as static assets, which is free.
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, statSync, renameSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseCsv } from '../src/csv.js';
import { tileName, leafFinder, TILE_COLUMNS, MAX_LEVEL, TILE_MAX_ROWS } from '../public/js/open-places.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DATA_REPO = 'https://raw.githubusercontent.com/mertozcetinwd-lab/loam-open-places/main/data/';
const CACHE = join(ROOT, 'dev', '.places-cache');
const OUT = join(ROOT, 'public', 'data', 'places');
const MAX_FILES = 19_000;               // Workers free plan: 20,000 static files per version, app files included
const MAX_TILE_BYTES = 24 * 1024 * 1024; // 25 MiB per file

/** The columns a tile keeps, read from a CSV row by header name. */
function reader(headLine) {
  const head = parseCsv(headLine)[0];
  const at = Object.fromEntries(head.map((h, i) => [h, i]));
  for (const need of ['id', 'name', 'category', 'alt_categories', 'phone', 'website', 'email', 'address', 'city', 'state', 'zip', 'lat', 'lon']) {
    if (!(need in at)) throw new Error(`The data file has no ${need} column`);
  }
  const num = (v) => (v && v.trim() ? Number(v) : NaN);   // Number('') is 0, a point off Africa
  return (line) => {
    const f = parseCsv(line)[0];   // the data repo strips newlines inside fields, so one line is one row
    if (!f) return null;
    const id = f[at.id]; const name = (f[at.name] || '').trim();
    const lat = num(f[at.lat]); const lon = num(f[at.lon]);
    if (!id || !name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return [id, name, f[at.category] || f[at.basic_category] || '', f[at.alt_categories] || '', f[at.phone] || '', f[at.website] || '',
      f[at.email] || '', f[at.address] || '', f[at.city] || '', f[at.zip] || '', lat, lon, f[at.state] || ''];
  };
}

/** Every row of a .csv.gz file, streamed. */
async function* rowsOf(path) {
  const lines = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  let read = null;
  for await (const line of lines) {
    if (!read) { read = reader(line); continue; }
    if (line) { const r = read(line); if (r) yield r; }
  }
}

/**
 * Build tiles from files. Pass 1 counts rows per cell at every level; pass 2 writes each row to
 * its leaf tile, one JSON row per line (see parseTile), buffered and appended. The data repo has
 * one row per id already (build/extract.py dedupes), so no id set is kept: for the whole US it
 * would hold ~14M strings, more memory than a laptop's Node gives by default.
 */
export async function buildTiles(files, out = OUT, { maxRows = TILE_MAX_ROWS, meta = {} } = {}) {
  const counts = new Map();
  for (const f of files) {
    for await (const r of rowsOf(f)) {
      for (let L = 0; L <= MAX_LEVEL; L++) { const t = tileName(r[10], r[11], L); counts.set(t, (counts.get(t) || 0) + 1); }
    }
  }
  const leafOf = leafFinder(counts, maxRows);
  if (existsSync(out)) rmSync(out, { recursive: true });
  mkdirSync(join(out, 't'), { recursive: true });
  const buf = new Map(); const perTile = new Map(); let rows = 0; let pending = 0;
  const flush = () => { for (const [t, lines] of buf) appendFileSync(join(out, 't', `${t}.json`), lines.join('')); buf.clear(); pending = 0; };
  for (const f of files) {
    for await (const r of rowsOf(f)) {
      rows++;
      const t = leafOf(r[10], r[11]);
      if (!buf.has(t)) buf.set(t, []);
      buf.get(t).push(JSON.stringify(r) + ',\n');
      perTile.set(t, (perTile.get(t) || 0) + 1);
      if (++pending >= 200_000) flush();
    }
  }
  flush();
  const tiles = [...perTile.keys()].sort();
  if (tiles.length > MAX_FILES) throw new Error(`${tiles.length} tiles is over the ${MAX_FILES} file limit. Raise TILE_MAX_ROWS.`);
  for (const t of tiles) {
    const size = statSync(join(out, 't', `${t}.json`)).size;
    if (size > MAX_TILE_BYTES) throw new Error(`Tile ${t} is ${(size / 1e6).toFixed(1)} MB, over Cloudflare's 25 MiB per file.`);
  }
  const index = { region: 'the US', rows, columns: TILE_COLUMNS, tiles, ...meta,
    attribution: 'Overture Maps Foundation, Overture Places (CDLA Permissive 2.0; some records Apache 2.0 or CC0)' };
  writeFileSync(join(out, 'index.json'), JSON.stringify(index));
  return index;
}

async function download(url, path) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(path + '.part'));
  renameSync(path + '.part', path);
}

async function main() {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const from = arg('--from');
  const only = arg('--states') ? new Set(arg('--states').toUpperCase().split(',').map((s) => s.trim())) : null;
  let manifest;
  if (from) manifest = JSON.parse(readFileSync(join(from, 'manifest.json'), 'utf8'));
  else {
    const res = await fetch(DATA_REPO + 'manifest.json');
    if (!res.ok) throw new Error(`The data repo answered ${res.status} for manifest.json`);
    manifest = await res.json();
  }
  const states = Object.keys(manifest.states).filter((s) => !only || only.has(s));
  if (!states.length) throw new Error(`No such states in the data: ${[...only].join(', ')}`);
  mkdirSync(CACHE, { recursive: true });
  const files = [];
  for (const st of states) {
    for (const part of manifest.states[st].files) {
      const src = from ? join(from, part.path) : join(CACHE, part.path.replace(/\//g, '_'));
      if (!from && !(existsSync(src) && statSync(src).size === part.bytes)) {
        process.stdout.write(`Downloading ${part.path} (${(part.bytes / 1e6).toFixed(0)} MB)… `);
        await download(DATA_REPO + part.path, src);
        console.log('done');
      }
      files.push(src);
    }
  }
  console.log(`\nBuilding tiles for ${states.length} state${states.length > 1 ? 's' : ''} (two passes; a few minutes for the whole US)…`);
  const index = await buildTiles(files, OUT, { meta: { release: manifest.release, states } });
  console.log(`\nDone: ${index.rows.toLocaleString('en-US')} places in ${index.tiles.length.toLocaleString('en-US')} tiles, in public/data/places.`);
  console.log('Now run: npx wrangler deploy');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e.message); process.exit(1); });
