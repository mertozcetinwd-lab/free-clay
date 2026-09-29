/**
 * AI providers, models and prices, shared by the Worker (budget, ledger) and the panel (estimate).
 *
 * $ per 1M tokens, which is also micro-dollars per token. Anthropic list prices from the Claude API
 * reference (cached 2026-06-24): Opus 5 $5/$25, Sonnet 5 $2/$10, Haiku 4.5 $1/$5. Groq's free tier
 * bills nothing (scripts/llm.py). Any other model needs its price typed into the column.
 */

export const PRICES = {
  'claude-opus-5': [5, 25], 'claude-sonnet-5': [2, 10], 'claude-haiku-4-5': [1, 5],
};

export const PROVIDERS = {
  anthropic: { label: 'Anthropic', secret: 'ANTHROPIC_API_KEY', models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'], default: 'claude-opus-5' },
  openai: { label: 'OpenAI', secret: 'OPENAI_API_KEY', models: [], default: '' },
  groq: { label: 'Groq (free tier)', secret: 'GROQ_API_KEY', models: ['qwen/qwen3.8-27b'], default: 'qwen/qwen3.8-27b', free: true },
};

export function priceOf(cfg, model = cfg.model) {
  if (Number.isFinite(cfg.price_in) && Number.isFinite(cfg.price_out)) return [cfg.price_in, cfg.price_out];
  if (PRICES[model]) return PRICES[model];
  if (cfg.provider === 'groq') return [0, 0];
  return null;
}

/** Worst case per row: estimated prompt tokens in, all of max_tokens out. */
export function worstCaseMicros(cfg) {
  const p = priceOf(cfg);
  if (!p) return 0;
  const inTok = Number.isInteger(cfg.est_input_tokens) && cfg.est_input_tokens > 0
    ? cfg.est_input_tokens : Math.ceil(String(cfg.prompt || '').length / 3) + 1000;
  return Math.ceil(inTok * p[0] + (cfg.max_tokens || 1024) * p[1]);
}
