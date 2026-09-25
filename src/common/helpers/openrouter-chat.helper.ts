import { AsyncLocalStorage } from 'async_hooks';
import type OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import { OPENROUTER_MAX_OUTPUT_TOKENS } from '../constants/openrouter';

/** Below this ceiling a completion is too short to carry a usable payload, so
 * retrying is pointless and the caller should see the credits error instead. */
const MIN_USABLE_OUTPUT_TOKENS = 700;

/** Leave headroom so the retry is not rejected by a concurrent spend. */
const AFFORDABLE_TOKENS_SAFETY_RATIO = 0.9;

type ChatParams = Parameters<OpenAI['chat']['completions']['create']>[0];

export type AiUsageLogEntry = {
  userId?: number | null;
  tenantId?: number | null;
  purpose?: string;
  model?: string | null;
  requestPreview?: string | null;
  responsePreview?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  success: boolean;
  errorMessage?: string | null;
  durationMs?: number | null;
  startedAt?: Date | null;
};

type AiUsageLogger = (entry: AiUsageLogEntry) => Promise<void>;

let aiUsageLogger: AiUsageLogger | null = null;

export function setAiUsageLogger(logger: AiUsageLogger | null) {
  aiUsageLogger = logger;
}

export type ChatCompletionContext = {
  userId?: number | null;
  tenantId?: number | null;
  purpose?: string;
};

const aiContextStorage = new AsyncLocalStorage<ChatCompletionContext>();

/** Run work with default LLM audit context (user/tenant/purpose). */
export function runWithAiContext<T>(
  context: ChatCompletionContext,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = aiContextStorage.getStore();
  return aiContextStorage.run({ ...parent, ...context }, fn);
}

export function getAiContext(): ChatCompletionContext | undefined {
  return aiContextStorage.getStore();
}

function previewText(value: unknown, max = 4000): string | null {
  try {
    const text =
      typeof value === 'string' ? value : JSON.stringify(value ?? null);
    if (!text) return null;
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return null;
  }
}

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
 * OpenRouter credit can cover. Always logs usage for the admin console.
 */
export async function createChatCompletion(
  client: OpenAI,
  params: Omit<ChatParams, 'stream' | 'max_tokens'> & { max_tokens?: number },
  context?: ChatCompletionContext,
): Promise<ChatCompletion> {
  const requested = params.max_tokens ?? OPENROUTER_MAX_OUTPUT_TOKENS;
  const startedAt = new Date();
  const started = startedAt.getTime();
  const model =
    typeof (params as { model?: string }).model === 'string'
      ? (params as { model?: string }).model
      : null;
  const requestPreview = previewText(
    (params as { messages?: unknown }).messages,
  );
  const stored = aiContextStorage.getStore();
  const merged: ChatCompletionContext = {
    ...stored,
    ...context,
    purpose: context?.purpose || stored?.purpose || 'other',
  };

  const log = async (
    partial: Partial<AiUsageLogEntry> & { success: boolean },
  ) => {
    if (!aiUsageLogger) return;
    await aiUsageLogger({
      userId: merged.userId ?? null,
      tenantId: merged.tenantId ?? null,
      purpose: merged.purpose || 'other',
      model,
      requestPreview,
      startedAt,
      durationMs: Date.now() - started,
      ...partial,
    });
  };

  try {
    let result: ChatCompletion;
    try {
      result = (await client.chat.completions.create({
        ...params,
        max_tokens: requested,
        stream: false,
      } as ChatParams)) as ChatCompletion;
    } catch (error) {
      const affordable = affordableTokensFromError(error);
      if (affordable === null) throw error;

      const retryTokens = Math.floor(
        affordable * AFFORDABLE_TOKENS_SAFETY_RATIO,
      );
      if (retryTokens < MIN_USABLE_OUTPUT_TOKENS || retryTokens >= requested) {
        throw error;
      }

      result = (await client.chat.completions.create({
        ...params,
        max_tokens: retryTokens,
        stream: false,
      } as ChatParams)) as ChatCompletion;
    }

    const usage = result.usage;
    await log({
      success: true,
      responsePreview: previewText(result.choices?.[0]?.message?.content),
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? null,
      totalTokens: usage?.total_tokens ?? null,
    });
    return result;
  } catch (error) {
    await log({
      success: false,
      errorMessage:
        error instanceof Error ? error.message : String(error ?? 'AI_ERROR'),
    });
    throw error;
  }
}
