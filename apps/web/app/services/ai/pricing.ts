/**
 * Model prices in one place, USD per million tokens. Used to estimate cost at
 * read time from `ai_usage` token counts (cost is never stored, so changing a
 * price here re-prices history). Client-safe: no server imports.
 *
 * Keep in step with OpenAI's pricing page. Unknown models price at null so the
 * admin page shows "—" rather than a wrong number.
 */

export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Default text model for both the pipeline and the web app.
  // TODO(owner): confirm against the current OpenAI price sheet.
  // Third-party-reported list price (Oct 2026); confirm against OpenAI pricing.
  "gpt-6-luna": { inputPerM: 0.1, outputPerM: 0.5 },
  // Staff page checks (REVIEW_AI_MODEL). OpenAI's launch post, Oct 26 2026: $1 in / $5 out
  // ($0.05 cached input; prompts over 272K tokens cost more, which a page check never reaches).
  "gpt-6.1-terra": { inputPerM: 1, outputPerM: 5 },
  "text-embedding-3-small": { inputPerM: 0.02, outputPerM: 0 },
};

/** The Decisions API (pipeline `ai.decide`) bills input tokens only, whatever the model. */
export const DECISIONS_PRICE: ModelPrice = { inputPerM: 0.1, outputPerM: 0 };

export function priceFor(model: string, operation?: string | null): ModelPrice | null {
  if (operation === "decide") return DECISIONS_PRICE;
  return MODEL_PRICES[model] ?? null;
}

/** Estimated USD for a token count, or null when the model has no price. */
export function estimateCostUsd(
  model: string,
  operation: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = priceFor(model, operation);
  if (!price) return null;
  return (inputTokens * price.inputPerM + outputTokens * price.outputPerM) / 1_000_000;
}
