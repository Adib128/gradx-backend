import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { BadRequestException } from '@nestjs/common';
import {
  fetchOpenRouterBalance,
  streamChatCompletion,
  type OpenRouterBalance,
} from 'src/common/helpers/openrouter-chat.helper';
import { ErrorMessageKey } from 'src/common/constants/error-message';
import type { PromptPair } from './prompts/studio.prompts';
import { NdjsonStreamParser, parseJsonObject } from './utils/ndjson-stream.util';
import type { StudioAgent } from './slide-studio.types';

type ModelRole = Exclude<StudioAgent, 'researcher' | 'publisher'>;

/**
 * Cost-efficient defaults: Claude Haiku 5.5 writes and rewrites the slides (the
 * bulk of the tokens) and Gemini 3.8 Flash takes the once-per-deck reasoning
 * steps, so the judge comes from another family than the author and does not
 * share its blind spots. Each is overridable with SLIDES_<ROLE>_MODEL, e.g.
 * anthropic/claude-opus-5.5 for a premium (far pricier) writer.
 */
const DEFAULT_MODELS: Record<ModelRole, string> = {
  analyst: 'google/gemini-3.8-flash',
  planner: 'google/gemini-3.8-flash',
  designer: 'anthropic/claude-haiku-5.5',
  outliner: 'google/gemini-3.8-flash',
  writer: 'anthropic/claude-haiku-5.5',
  illustrator: 'anthropic/claude-haiku-5.5',
  inspector: 'google/gemini-3.8-flash',
  optimizer: 'anthropic/claude-haiku-5.5',
  reviewer: 'google/gemini-3.8-flash',
};

/**
 * OpenRouter tries these in order when the primary model errors or is
 * unavailable; kept in the same price tier so a fallback never multiplies cost.
 */
const FALLBACK_MODELS: Record<ModelRole, string[]> = {
  analyst: ['anthropic/claude-haiku-5.5'],
  planner: ['anthropic/claude-haiku-5.5'],
  designer: ['google/gemini-3.8-flash'],
  outliner: ['anthropic/claude-haiku-5.5'],
  writer: ['openai/gpt-6-luna'],
  illustrator: ['google/gemini-3.8-flash'],
  inspector: ['openai/gpt-6-luna'],
  optimizer: ['openai/gpt-6-luna'],
  reviewer: ['openai/gpt-6-luna'],
};

/** Visible answer budget (reasoning tokens are added on top). */
const MAX_TOKENS: Record<ModelRole, number> = {
  analyst: 1500,
  planner: 4000,
  designer: 800,
  outliner: 6000,
  writer: 8000,
  illustrator: 3000,
  inspector: 3500,
  optimizer: 8000,
  reviewer: 2000,
};

/**
 * Thinking budget per role: deep for decisions that shape the whole deck
 * (plan, outline, audit), light for per-slide writing. Overridable with
 * SLIDES_<ROLE>_REASONING (tokens, 0 disables).
 */
const REASONING_TOKENS: Record<ModelRole, number> = {
  analyst: 0,
  planner: 6000,
  designer: 0,
  outliner: 4000,
  writer: 2000,
  illustrator: 1000,
  inspector: 6000,
  optimizer: 2000,
  reviewer: 2000,
};

@Injectable()
export class SlideStudioLlm {
  private readonly client: OpenAI;
  readonly models: Record<ModelRole, string>;
  private readonly reasoning: Record<ModelRole, number>;

  constructor(config: ConfigService) {
    this.client = new OpenAI({
      apiKey: config.get<string>('OPENROUTER_API_KEY'),
      baseURL: config.get<string>('OPENROUTER_BASE_URL'),
      timeout: 300_000,
      maxRetries: 1,
    });
    const roles = Object.keys(DEFAULT_MODELS) as ModelRole[];
    this.models = Object.fromEntries(
      roles.map((role) => [
        role,
        config.get<string>(`SLIDES_${role.toUpperCase()}_MODEL`)?.trim() ||
          DEFAULT_MODELS[role],
      ]),
    ) as Record<ModelRole, string>;
    this.reasoning = Object.fromEntries(
      roles.map((role) => {
        const raw = config.get<string>(`SLIDES_${role.toUpperCase()}_REASONING`)?.trim();
        const value = raw ? Number(raw) : NaN;
        return [role, Number.isFinite(value) && value >= 0 ? Math.round(value) : REASONING_TOKENS[role]];
      }),
    ) as Record<ModelRole, number>;
  }

  balance(): Promise<OpenRouterBalance> {
    return fetchOpenRouterBalance(this.client);
  }

  async text(
    role: ModelRole,
    prompt: PromptPair,
    options: {
      signal?: AbortSignal;
      onDelta?: (delta: string, text: string) => void;
      temperature?: number;
    } = {},
  ): Promise<string> {
    const model = this.models[role];
    const reasoning = this.reasoning[role];
    const fallbacks = FALLBACK_MODELS[role].filter((candidate) => candidate !== model);
    const { text } = await streamChatCompletion(
      this.client,
      {
        model,
        ...(fallbacks.length ? { models: [model, ...fallbacks] } : {}),
        // Reasoning models ignore temperature; thinking replaces sampling noise.
        ...(reasoning
          ? { reasoning: { max_tokens: reasoning, exclude: true } }
          : { temperature: options.temperature ?? 0.4 }),
        max_tokens: MAX_TOKENS[role] + reasoning,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
      },
      {
        context: { purpose: `slide_studio_${role}` },
        signal: options.signal,
        onDelta: options.onDelta,
      },
    );
    return text;
  }

  async json(
    role: ModelRole,
    prompt: PromptPair,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const text = await this.text(role, prompt, { signal, temperature: 0.3 });
    const parsed = parseJsonObject(text);
    if (!parsed) {
      throw new BadRequestException(ErrorMessageKey.GENERATION_AI_INVALID_JSON);
    }
    return parsed;
  }

  /** Streams an NDJSON answer, invoking `onObject` as soon as each line parses. */
  async ndjson(
    role: ModelRole,
    prompt: PromptPair,
    onObject: (value: Record<string, unknown>) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const parser = new NdjsonStreamParser(onObject);
    await this.text(role, prompt, {
      signal,
      onDelta: (delta) => parser.push(delta),
    });
    parser.end();
  }
}
