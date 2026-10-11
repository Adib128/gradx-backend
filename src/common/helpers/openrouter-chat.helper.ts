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

export async function recordAiUsage(entry: AiUsageLogEntry) {
  if (!aiUsageLogger) return;
  await aiUsageLogger(entry);
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

/** Anthropic rejects thinking budgets below this, so smaller ones are dropped. */
const MIN_REASONING_TOKENS = 1024;

/**
 * Caps the request at `maxTokens`. A reasoning budget shrinks in proportion,
 * otherwise thinking could consume the whole reduced ceiling and leave no answer.
 */
function withTokenBudget<P extends object>(
  params: P,
  maxTokens: number,
  requested: number,
): P & { max_tokens: number } {
  const { reasoning } = params as { reasoning?: { max_tokens?: unknown } };
  if (
    maxTokens >= requested ||
    typeof reasoning?.max_tokens !== 'number' ||
    !reasoning.max_tokens
  ) {
    return { ...params, max_tokens: maxTokens };
  }
  const budget = Math.floor((reasoning.max_tokens * maxTokens) / requested);
  if (budget < MIN_REASONING_TOKENS) {
    const rest = { ...params } as P & { reasoning?: unknown };
    delete rest.reasoning;
    return { ...rest, max_tokens: maxTokens };
  }
  return {
    ...params,
    max_tokens: maxTokens,
    reasoning: { ...reasoning, max_tokens: budget },
  };
}

/**
 * OpenRouter only says which budget ran out (account credits vs. the key's own
 * spending limit) in `error.metadata.limit_source`; copy it into the message so
 * string-based error classification can tell them apart.
 */
function tagLimitSource(error: unknown): unknown {
  const source = (
    error as { error?: { metadata?: { limit_source?: unknown } } }
  )?.error?.metadata?.limit_source;
  if (
    typeof source === 'string' &&
    error instanceof Error &&
    !error.message.includes('limit_source:')
  ) {
    error.message = `${error.message} [limit_source: ${source}]`;
  }
  return error;
}

export type OpenRouterBalance = {
  /** USD left on the OpenRouter account. */
  account: number | null;
  /** USD left under the API key's spending limit; null when it has none. */
  key: number | null;
};

export async function fetchOpenRouterBalance(
  client: OpenAI,
): Promise<OpenRouterBalance> {
  const base = client.baseURL.replace(/\/+$/, '');
  const get = async (path: string) => {
    const response = await fetch(`${base}${path}`, {
      headers: { Authorization: `Bearer ${client.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    return ((await response.json()) as { data?: Record<string, unknown> })
      .data;
  };
  const [credits, key] = await Promise.all([
    get('/credits').catch(() => null),
    get('/key').catch(() => null),
  ]);
  const total = Number(credits?.total_credits);
  const used = Number(credits?.total_usage);
  const keyLeft = key?.limit_remaining;
  return {
    account:
      credits && Number.isFinite(total) && Number.isFinite(used)
        ? Math.max(0, total - used)
        : null,
    key: typeof keyLeft === 'number' ? Math.max(0, keyLeft) : null,
  };
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
        ...withTokenBudget(params, retryTokens, requested),
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
    tagLimitSource(error);
    await log({
      success: false,
      errorMessage:
        error instanceof Error ? error.message : String(error ?? 'AI_ERROR'),
    });
    throw error;
  }
}

export type ChatStreamOptions = {
  context?: ChatCompletionContext;
  signal?: AbortSignal;
  /** Called for every content delta with the text accumulated so far. */
  onDelta?: (delta: string, text: string) => void;
};

export type ChatStreamResult = {
  text: string;
  finishReason: string | null;
};

/**
 * Streaming counterpart of {@link createChatCompletion}: same credit retry
 * (only possible before the first token) and the same usage logging, taken
 * from the final `include_usage` chunk.
 */
export async function streamChatCompletion(
  client: OpenAI,
  params: Omit<ChatParams, 'stream' | 'max_tokens' | 'stream_options'> & {
    max_tokens?: number;
  },
  options: ChatStreamOptions = {},
): Promise<ChatStreamResult> {
  const requested = params.max_tokens ?? OPENROUTER_MAX_OUTPUT_TOKENS;
  const startedAt = new Date();
  const started = startedAt.getTime();
  const model =
    typeof (params as { model?: string }).model === 'string'
      ? (params as { model?: string }).model
      : null;
  const stored = aiContextStorage.getStore();
  const merged: ChatCompletionContext = {
    ...stored,
    ...options.context,
    purpose: options.context?.purpose || stored?.purpose || 'other',
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
      requestPreview: previewText((params as { messages?: unknown }).messages),
      startedAt,
      durationMs: Date.now() - started,
      ...partial,
    });
  };

  const open = (maxTokens: number) =>
    client.chat.completions.create(
      {
        ...withTokenBudget(params, maxTokens, requested),
        stream: true,
        stream_options: { include_usage: true },
      } as ChatParams & { stream: true },
      { signal: options.signal },
    );

  let text = '';
  try {
    let stream: Awaited<ReturnType<typeof open>>;
    try {
      stream = await open(requested);
    } catch (error) {
      const affordable = affordableTokensFromError(error);
      if (affordable === null) throw error;
      const retryTokens = Math.floor(
        affordable * AFFORDABLE_TOKENS_SAFETY_RATIO,
      );
      if (retryTokens < MIN_USABLE_OUTPUT_TOKENS || retryTokens >= requested) {
        throw error;
      }
      stream = await open(retryTokens);
    }

    let finishReason: string | null = null;
    let usage: ChatCompletion['usage'] | undefined;
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) {
        text += delta;
        options.onDelta?.(delta, text);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }

    await log({
      success: true,
      responsePreview: previewText(text),
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? null,
      totalTokens: usage?.total_tokens ?? null,
    });
    return { text, finishReason };
  } catch (error) {
    tagLimitSource(error);
    await log({
      success: false,
      responsePreview: previewText(text),
      errorMessage:
        error instanceof Error ? error.message : String(error ?? 'AI_ERROR'),
    });
    throw error;
  }
}
