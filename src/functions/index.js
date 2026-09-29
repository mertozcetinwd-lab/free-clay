/**
 * The function registry: every enrichment a column can run. Free functions ship in free.js;
 * functions that need your key live in byok.js, and treg.js holds the ones that go through one treg
 * token (treg.to). Adding one = adding an object to any of the lists.
 */

import { FREE } from './free.js';
import { BYOK } from './byok.js';
import { TREG } from './treg.js';
import { SEND } from './send.js';

const LIST = [...FREE, ...BYOK, ...TREG, ...SEND];
export const FUNCTIONS = new Map(LIST.map((f) => [f.id, f]));

export const getFunction = (id) => FUNCTIONS.get(id) || null;

/** Cost per call in micro-dollars: your own override from Settings, else the function's estimate. */
export const costOf = (fn, overrides = {}) => (Number.isInteger(overrides?.[fn.id]) ? overrides[fn.id] : fn.costMicros || 0);

/**
 * Where the Tools catalog files a function (LOAM-PLAN.md phase 5, Clay's Enrich tab). The provider
 * is the name before the colon ("Hunter: find work email"); functions with no key are Free Clay's own.
 */
export const CATEGORIES = { email: 'Email', contact: 'Contact info', company: 'Company', web: 'Web and search', export: 'Send and export' };
const providerOf = (f) => f.provider || (f.secret ? f.name.split(':')[0].trim() : 'Free Clay');

/** What the browser needs to build the picker and the cost chips (never the run code). */
export function catalog() {
  return LIST.map(({ id, name, blurb, inputs, outputs, primary, type, subrequests, costMicros, costSource, secret, validates, group, category, provider }) =>
    ({ id, name, blurb, inputs, outputs, primary, type, subrequests, costMicros, costSource: costSource || null, secret: secret || null, validates: validates || null,
      group: group || (secret ? 'Your key' : 'Free'), category: category || 'web', provider: providerOf({ name, secret, provider }) }));
}

/** Registers more functions (byok.js and later kinds call this at import time). */
export function register(...fns) {
  for (const f of fns) { LIST.push(f); FUNCTIONS.set(f.id, f); }
}
