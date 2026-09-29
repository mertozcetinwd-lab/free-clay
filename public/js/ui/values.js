/** How one cell value looks. Values are only ever text nodes, never HTML. */

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { isEmpty, displayText, invalid } from '../types.js';

/** Only http(s) links become clickable, so a cell holding "javascript:..." stays inert text. */
export function safeHref(v) {
  const s = String(v || '').trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s)) return 'https://' + s;
  return null;
}

const HUES = ['blue', 'violet', 'green', 'amber', 'red', 'pink', 'teal', 'gray'];
export function hueFor(text) {
  let n = 0;
  for (const c of String(text || '')) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return HUES[n % HUES.length];
}

export function valueNode(col, v) {
  if (col.type === 'checkbox' && (isEmpty(v) || typeof v === 'boolean')) {
    return h('span', { class: 'check', role: 'img', 'aria-label': v ? 'Yes' : 'No', 'aria-checked': v ? 'true' : 'false' }, v ? icon('check', 12, 2.5) : null);
  }
  if (isEmpty(v)) return null;
  if (invalid(col.type, v)) return h('span', { class: 'bad', title: `Not a valid ${col.type}` }, String(v));
  switch (col.type) {
    case 'select':
      return h('span', { class: 'pill', 'data-c': hueFor(v) }, String(v));
    case 'multi_select':
      return h('span', { class: 'pills' }, (Array.isArray(v) ? v : [v]).map((x) => h('span', { class: 'pill', 'data-c': hueFor(x) }, String(x))));
    case 'url': {
      const href = safeHref(v);
      const text = String(v).replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
      return href ? h('a', { class: 'cell-link', href, target: '_blank', rel: 'noopener noreferrer', title: String(v), onClick: (e) => e.stopPropagation() }, text) : text;
    }
    case 'json':
      return h('span', { class: 'mono' }, typeof v === 'string' ? v : JSON.stringify(v));
    default:
      return displayText(col.type, v);
  }
}

/** The small status mark a computed cell shows beside (or instead of) its value. */
export function statusNode(meta) {
  if (!meta) return null;
  const st = meta.status;
  if (st === 'queued') return h('span', { class: 'st st-queued', title: 'Queued' });
  if (st === 'running') return h('span', { class: 'st st-running', title: 'Running' });
  if (st === 'error') return h('span', { class: 'st st-error', title: meta.error || 'Error' }, icon('alert', 13));
  return null;
}
