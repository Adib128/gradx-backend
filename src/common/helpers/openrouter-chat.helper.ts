import type OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import { OPENROUTER_MAX_OUTPUT_TOKENS } from '../constants/openrouter';

/** Below this ceiling a completion is too short to carry a usable payload, so
 * retrying is pointless and the caller should see the credits error instead. */
const MIN_USABLE_OUTPUT_TOKENS = 700;

/** Leave headroom so the retry is not rejected by a concurrent spend. */
const AFFORDABLE_TOKENS_SAFETY_RATIO = 0.9;

type ChatParams = Parameters<OpenAI['chat']['completions']['create']>[0];

/**
 * OpenRouter rejects a request outright when `max_tokens` exceeds what the
 * remaining credit could cover, even if the real completion would be far
 * smaller. The rejection reports the affordable ceiling, e.g.
 * "You requested up to 8192 tokens, but can only afford 2829".
 */
function affordableTokensFromError(error: unknown): number | null {
  const parts = [
    (error as { message?: unknown })?.message,
    (error as { error?: { message?: unknown } })?.error?.message,
  ];

  for (const part of parts) {
    if (typeof part !== 'string') continue;
    const match = /can only afford\s+(\d+)/i.exec(part);
    if (match) {
      const affordable = Number(match[1]);
      if (Number.isFinite(affordable) && affordable > 0) return affordable;
    }
  }

  return null;
}

/**
 * Creates a chat completion, transparently retrying once with a smaller
 * `max_tokens` when the configured ceiling is more than the remaining
 * OpenRouter credit can cover.
 */
export async function createChatCompletion(
  client: OpenAI,
  params: Omit<ChatParams, 'stream' | 'max_tokens'> & { max_tokens?: number },
): Promise<ChatCompletion> {
  const requested = params.max_tokens ?? OPENROUTER_MAX_OUTPUT_TOKENS;

  try {
    return (await client.chat.completions.create({
      ...params,
      max_tokens: requested,
      stream: false,
    } as ChatParams)) as ChatCompletion;
  } catch (error) {
    const affordable = affordableTokensFromError(error);
    if (affordable === null) throw error;

    const retryTokens = Math.floor(affordable * AFFORDABLE_TOKENS_SAFETY_RATIO);
    if (retryTokens < MIN_USABLE_OUTPUT_TOKENS || retryTokens >= requested) {
      throw error;
    }

    return (await client.chat.completions.create({
      ...params,
      max_tokens: retryTokens,
      stream: false,
    } as ChatParams)) as ChatCompletion;
  }
}
