/**
 * Formula column and run conditions. Formula values are computed on read and never stored:
 * the grid computes them in the browser, the Worker computes them for exports, run inputs and
 * run conditions (all through the same public/js/formula.js).
 */

import { fail } from '../util.js';
import { CONFIG_CHECKS, hooks } from '../tables.js';
import { conditions } from './enrich.js';
import { checkFormula, computeRow, conditionTrue } from '../../public/js/formula.js';

CONFIG_CHECKS.formula = (cfg) => {
  const err = checkFormula(cfg.formula);
  if (err) fail(400, `Formula: ${err}`);
};

hooks.computeRow = (row, cols) => computeRow(row, cols);
conditions.test = (expr, data) => conditionTrue(expr, data);
conditions.check = (expr) => checkFormula(expr);
