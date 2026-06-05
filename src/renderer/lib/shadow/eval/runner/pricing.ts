/**
 * Token → USD. The repo has no pricing anywhere (only the Anthropic Agent SDK
 * reports cost natively); these are APPROXIMATE DeepSeek rates — edit to your real
 * contract. The FC judge requests a non-deepseek model id (FC_MODEL='gemini-3.5-flash')
 * that the provider substitutes to its default, so any non-`deepseek-` id is priced
 * as the deepseek default.
 */
const DEEPSEEK_DEFAULT = 'deepseek-v4-flash';

// USD per 1,000,000 tokens.
const PRICING: Record<string, { input: number; output: number }> = {
  'deepseek-v4-flash': { input: 0.28, output: 0.42 },
  'deepseek-chat': { input: 0.27, output: 1.1 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
};
const FALLBACK = { input: 0.3, output: 1.0 };

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const key = model.startsWith('deepseek-') ? model : DEEPSEEK_DEFAULT;
  const p = PRICING[key] ?? FALLBACK;
  return (inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output;
}
