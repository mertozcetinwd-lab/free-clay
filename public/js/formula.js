/**
 * The formula language, hand-written: a tokenizer, a precedence-climbing parser and a tree
 * walker. No eval and no new Function: Cloudflare Workers refuse both (code generation from
 * strings is disallowed in the Workers runtime), and a parser we own cannot run anything a
 * formula did not spell out. Shared by the Worker (run conditions, export) and the browser (grid).
 *
 *   IF(LEN({{email}}) > 0, "has email", "missing")
 *   DOMAIN({{website}}) & " / " & UPPER({{city}})
 *   ROUND({{revenue}} / {{employees}}, 0)
 *
 * Column references are {{key}}. Strings use "double" or 'single' quotes. Operators, lowest
 * binding first: OR, AND, = != <> < <= > >=, &, + -, * / %, unary - and NOT.
 * Errors never throw out of evaluate(): a bad cell shows #ERROR with the reason, like a sheet.
 */

import { isEmpty, toNumber, toDate } from './types.js';

export class FormulaError extends Error {}

/* ---------------------------------------------------------------- tokenizer */

export function tokenize(src) {
  const s = String(src ?? ''); const out = []; let i = 0;
  if (s.length > 2000) throw new FormulaError('Formula is longer than 2,000 characters');
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '{' && s[i + 1] === '{') {
      const end = s.indexOf('}}', i);
      if (end < 0) throw new FormulaError('A {{column}} is not closed');
      const key = s.slice(i + 2, end).trim();
      if (!/^[A-Za-z0-9_]+$/.test(key)) throw new FormulaError(`Bad column reference {{${key}}}`);
      out.push({ t: 'ref', v: key }); i = end + 2; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1; let str = '';
      while (j < s.length && s[j] !== c) { if (s[j] === '\\' && j + 1 < s.length) { str += s[j + 1]; j += 2; } else str += s[j++]; }
      if (j >= s.length) throw new FormulaError('A string is not closed');
      out.push({ t: 'str', v: str }); i = j + 1; continue;
    }
    const num = s.slice(i).match(/^\d+(\.\d+)?([eE][+-]?\d+)?|^\.\d+/);
    if (num) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const word = s.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (word) { out.push({ t: 'word', v: word[0].toUpperCase() }); i += word[0].length; continue; }
    const op = s.slice(i).match(/^(<=|>=|!=|<>|==|&&|\|\||[-+*/%&=<>(),!])/);
    if (op) { out.push({ t: 'op', v: op[0] }); i += op[0].length; continue; }
    throw new FormulaError(`Unexpected character "${c}"`);
  }
  return out;
}

/* ---------------------------------------------------------------- parser */

const BINARY = [
  [['OR', '||'], 'or'], [['AND', '&&'], 'and'],
  [['=', '==', '!=', '<>', '<', '<=', '>', '>='], 'cmp'], [['&'], 'cat'],
  [['+', '-'], 'add'], [['*', '/', '%'], 'mul'],
];

export function parse(src) {
  const toks = tokenize(src);
  if (!toks.length) throw new FormulaError('The formula is empty');
  let p = 0; let depth = 0;
  const peek = () => toks[p];
  const isOp = (tok, list) => tok && ((tok.t === 'op' && list.includes(tok.v)) || (tok.t === 'word' && list.includes(tok.v)));
  const expect = (v) => { const tok = toks[p++]; if (!tok || tok.v !== v) throw new FormulaError(`Expected "${v}"`); };

  const level = (i) => {
    if (i >= BINARY.length) return unary();
    let left = level(i + 1);
    while (isOp(peek(), BINARY[i][0])) {
      const op = toks[p++].v;
      left = { k: 'bin', op, a: left, b: level(i + 1) };
    }
    return left;
  };
  const unary = () => {
    if (isOp(peek(), ['-'])) { p++; return { k: 'neg', a: unary() }; }
    if (isOp(peek(), ['+'])) { p++; return unary(); }
    if (isOp(peek(), ['!', 'NOT']) && !(peek().t === 'word' && toks[p + 1]?.v === '(')) { p++; return { k: 'not', a: unary() }; }
    return primary();
  };
  const primary = () => {
    const tok = toks[p++];
    if (!tok) throw new FormulaError('The formula ends too early');
    if (++depth > 60) throw new FormulaError('The formula is nested too deeply');
    try {
      if (tok.t === 'num') return { k: 'lit', v: tok.v };
      if (tok.t === 'str') return { k: 'lit', v: tok.v };
      if (tok.t === 'ref') return { k: 'ref', v: tok.v };
      if (tok.t === 'op' && tok.v === '(') { const e = level(0); expect(')'); return e; }
      if (tok.t === 'word') {
        if (tok.v === 'TRUE') return { k: 'lit', v: true };
        if (tok.v === 'FALSE') return { k: 'lit', v: false };
        if (peek()?.v !== '(') throw new FormulaError(`Unknown name ${tok.v}. Columns are written {{column}}.`);
        if (!FUNCS[tok.v]) throw new FormulaError(`Unknown function ${tok.v}`);
        p++;
        const args = [];
        if (peek()?.v !== ')') { args.push(level(0)); while (peek()?.v === ',') { p++; args.push(level(0)); } }
        expect(')');
        const [min, max] = FUNCS[tok.v].n;
        if (args.length < min || args.length > max) throw new FormulaError(`${tok.v} takes ${min === max ? min : `${min} to ${max === Infinity ? 'any number of' : max}`} argument${max === 1 ? '' : 's'}`);
        return { k: 'call', f: tok.v, args };
      }
      throw new FormulaError(`Unexpected "${tok.v}"`);
    } finally { depth--; }
  };
  const tree = level(0);
  if (p < toks.length) throw new FormulaError(`Unexpected "${toks[p].v}"`);
  return tree;
}

/** Column keys a formula uses (for ordering formulas and the "uses" line in the panel). */
export function formulaRefs(tree, out = new Set()) {
  if (!tree) return out;
  if (tree.k === 'ref') out.add(tree.v);
  for (const x of [tree.a, tree.b, ...(tree.args || [])]) if (x) formulaRefs(x, out);
  return out;
}

/** null when the formula parses, else the reason. */
export function checkFormula(src) {
  try { parse(src); return null; } catch (e) { return e.message; }
}

/* ---------------------------------------------------------------- values */

const text = (v) => (isEmpty(v) ? '' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));
const num = (v, fn) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isEmpty(v)) return 0;
  const n = toNumber(v);
  if (n === null) throw new FormulaError(`${fn || 'Math'} needs a number, got "${text(v).slice(0, 30)}"`);
  return n;
};
const truthy = (v) => !(isEmpty(v) || v === false || v === 0 || v === 'FALSE' || v === 'false');
const dateMs = (v) => { const d = toDate(v); if (!d) throw new FormulaError(`Not a date: "${text(v).slice(0, 30)}"`); return Date.parse(d + 'T00:00:00Z'); };
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

function compare(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const na = toNumber(a); const nb = toNumber(b);
  if (na !== null && nb !== null && !isEmpty(a) && !isEmpty(b)) return na - nb;
  const x = text(a).toLowerCase(); const y = text(b).toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/* ---------------------------------------------------------------- functions */

// Lazy args (IF, AND, OR, IFERROR, COALESCE) get thunks, so the branch not taken never runs.
const FUNCS = {
  IF: { n: [2, 3], lazy: true, f: ([c, a, b]) => (truthy(c()) ? a() : b ? b() : null) },
  AND: { n: [1, Infinity], lazy: true, f: (xs) => xs.every((x) => truthy(x())) },
  OR: { n: [1, Infinity], lazy: true, f: (xs) => xs.some((x) => truthy(x())) },
  NOT: { n: [1, 1], f: ([x]) => !truthy(x) },
  IFERROR: { n: [2, 2], lazy: true, f: ([a, b]) => { try { return a(); } catch { return b(); } } },
  COALESCE: { n: [1, Infinity], lazy: true, f: (xs) => { for (const x of xs) { const v = x(); if (!isEmpty(v)) return v; } return null; } },
  ISBLANK: { n: [1, 1], f: ([x]) => isEmpty(x) || (typeof x === 'string' && !x.trim()) },

  LEN: { n: [1, 1], f: ([x]) => text(x).length },
  UPPER: { n: [1, 1], f: ([x]) => text(x).toUpperCase() },
  LOWER: { n: [1, 1], f: ([x]) => text(x).toLowerCase() },
  PROPER: { n: [1, 1], f: ([x]) => text(x).toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()) },
  TRIM: { n: [1, 1], f: ([x]) => text(x).trim().replace(/\s+/g, ' ') },
  CONCAT: { n: [1, Infinity], f: (xs) => xs.map(text).join('') },
  LEFT: { n: [1, 2], f: ([x, n = 1]) => text(x).slice(0, Math.max(0, num(n, 'LEFT'))) },
  RIGHT: { n: [1, 2], f: ([x, n = 1]) => { const s = text(x); const k = Math.max(0, num(n, 'RIGHT')); return k ? s.slice(-k) : ''; } },
  MID: { n: [3, 3], f: ([x, start, n]) => text(x).substr(Math.max(0, num(start, 'MID') - 1), Math.max(0, num(n, 'MID'))) },
  FIND: { n: [2, 2], f: ([needle, hay]) => text(hay).toLowerCase().indexOf(text(needle).toLowerCase()) + 1 },
  CONTAINS: { n: [2, 2], f: ([hay, needle]) => text(hay).toLowerCase().includes(text(needle).toLowerCase()) },
  STARTSWITH: { n: [2, 2], f: ([x, p]) => text(x).toLowerCase().startsWith(text(p).toLowerCase()) },
  ENDSWITH: { n: [2, 2], f: ([x, p]) => text(x).toLowerCase().endsWith(text(p).toLowerCase()) },
  REPLACE: { n: [3, 3], f: ([x, a, b]) => text(x).split(text(a)).join(text(b)) },
  SPLIT: { n: [3, 3], f: ([x, sep, i]) => text(x).split(text(sep))[num(i, 'SPLIT') - 1]?.trim() ?? null },
  TEXT: { n: [1, 1], f: ([x]) => text(x) },
  FIRSTWORD: { n: [1, 1], f: ([x]) => text(x).trim().split(/\s+/)[0] || null },
  LASTWORD: { n: [1, 1], f: ([x]) => { const w = text(x).trim().split(/\s+/); return w[w.length - 1] || null; } },
  DOMAIN: { n: [1, 1], f: ([x]) => {
    let s = text(x).trim().toLowerCase();
    if (s.includes('@') && !s.includes('/')) s = s.split('@').pop();
    s = s.replace(/^[a-z]+:\/\//, '').split(/[/?#:\s]/)[0].replace(/^www\d?\./, '');
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null;
  } },

  NUMBER: { n: [1, 1], f: ([x]) => (isEmpty(x) ? null : num(x, 'NUMBER')) },
  ROUND: { n: [1, 2], f: ([x, d = 0]) => { const k = 10 ** num(d, 'ROUND'); return Math.round(num(x, 'ROUND') * k) / k; } },
  ABS: { n: [1, 1], f: ([x]) => Math.abs(num(x, 'ABS')) },
  MIN: { n: [1, Infinity], f: (xs) => Math.min(...xs.filter((x) => !isEmpty(x)).map((x) => num(x, 'MIN'))) },
  MAX: { n: [1, Infinity], f: (xs) => Math.max(...xs.filter((x) => !isEmpty(x)).map((x) => num(x, 'MAX'))) },
  SUM: { n: [1, Infinity], f: (xs) => xs.reduce((a, x) => a + num(x, 'SUM'), 0) },

  TODAY: { n: [0, 0], f: (_, ctx) => iso(ctx.now) },
  YEAR: { n: [1, 1], f: ([x]) => new Date(dateMs(x)).getUTCFullYear() },
  MONTH: { n: [1, 1], f: ([x]) => new Date(dateMs(x)).getUTCMonth() + 1 },
  DAY: { n: [1, 1], f: ([x]) => new Date(dateMs(x)).getUTCDate() },
  DATEADD: { n: [2, 2], f: ([x, days]) => iso(dateMs(x) + num(days, 'DATEADD') * 86400000) },
  DATEDIFF: { n: [2, 2], f: ([a, b]) => Math.round((dateMs(b) - dateMs(a)) / 86400000) },
};
export const FUNCTION_NAMES = Object.keys(FUNCS);

/* ---------------------------------------------------------------- evaluate */

export function evaluate(tree, data, ctx = {}) {
  const c = { now: ctx.now ?? Date.now(), steps: 0 };
  const ev = (n) => {
    if (++c.steps > 10_000) throw new FormulaError('The formula does too much work');
    switch (n.k) {
      case 'lit': return n.v;
      case 'ref': return Object.hasOwn(data, n.v) ? data[n.v] ?? null : null;   // never the prototype ({{constructor}})
      case 'neg': return -num(ev(n.a));
      case 'not': return !truthy(ev(n.a));
      case 'call': {
        const fn = FUNCS[n.f];
        const args = fn.lazy ? n.args.map((a) => () => ev(a)) : n.args.map(ev);
        return fn.f(args, c);
      }
      case 'bin': {
        const op = n.op;
        if (op === 'AND' || op === '&&') return truthy(ev(n.a)) && truthy(ev(n.b));
        if (op === 'OR' || op === '||') return truthy(ev(n.a)) || truthy(ev(n.b));
        const a = ev(n.a); const b = ev(n.b);
        switch (op) {
          case '&': return text(a) + text(b);
          case '+': return num(a) + num(b);
          case '-': return num(a) - num(b);
          case '*': return num(a) * num(b);
          case '/': { const d = num(b); if (d === 0) throw new FormulaError('Division by zero'); return num(a) / d; }
          case '%': { const d = num(b); if (d === 0) throw new FormulaError('Division by zero'); return num(a) % d; }
          case '=': case '==': return compare(a, b) === 0;
          case '!=': case '<>': return compare(a, b) !== 0;
          case '<': return compare(a, b) < 0;
          case '<=': return compare(a, b) <= 0;
          case '>': return compare(a, b) > 0;
          case '>=': return compare(a, b) >= 0;
        }
      }
    }
    throw new FormulaError('Bad formula');
  };
  const v = ev(tree);
  if (typeof v === 'number' && !Number.isFinite(v)) throw new FormulaError('The result is not a finite number');
  return v;
}

/**
 * The row with every formula column filled in. Formulas may use other formulas: they are
 * computed in dependency order, and a cycle is an error in each cell that is part of it.
 * Errors come back as {error} objects under row._errors so the grid can show #ERROR.
 */
const cache = new Map();
function compiled(src) {
  if (!cache.has(src)) { if (cache.size > 500) cache.clear(); let t; try { t = parse(src); } catch (e) { t = { error: e.message }; } cache.set(src, t); }
  return cache.get(src);
}

export function computeRow(row, cols, ctx = {}) {
  const formulas = cols.filter((c) => c.kind === 'formula');
  if (!formulas.length) return row.data;
  const data = { ...row.data };
  const errors = {};
  const byKey = new Map(formulas.map((c) => [c.key, c]));
  const state = new Map();   // key -> 'busy' | 'done'
  const run = (col) => {
    if (state.get(col.key) === 'done') return;
    if (state.get(col.key) === 'busy') { errors[col.key] = 'This formula refers to itself'; return; }
    state.set(col.key, 'busy');
    const tree = compiled(col.config.formula || '');
    if (tree.error) errors[col.key] = tree.error;
    else {
      for (const k of formulaRefs(tree)) if (byKey.has(k)) run(byKey.get(k));
      if (!errors[col.key]) {
        try { data[col.key] = evaluate(tree, data, ctx); } catch (e) { errors[col.key] = e.message; data[col.key] = null; }
      }
    }
    state.set(col.key, 'done');
  };
  formulas.forEach(run);
  if (Object.keys(errors).length) Object.defineProperty(data, '_errors', { value: errors, enumerable: false });
  return data;
}

/** A run condition: true when the formula is truthy. A broken condition is false (never spends). */
export function conditionTrue(src, data, ctx) {
  const tree = compiled(src);
  if (tree.error) return false;
  try { return truthy(evaluate(tree, data, ctx)); } catch { return false; }
}
