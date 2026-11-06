import { AsyncLocalStorage } from 'async_hooks';
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
import type { PlanModelsMap } from 'src/generation-plans/generation-plan.roles';
import type { PromptPair } from './prompts/studio.prompts';
import { NdjsonStreamParser, parseJsonObject } from './utils/ndjson-stream.util';
import type { StudioAgent } from './slide-studio.types';

type ModelRole = Exclude<StudioAgent, 'researcher' | 'publisher'>;

/**
 * Defaults match the Medium generation plan (Claude 3.5 Haiku / GPT-4o) when
 * no plan is selected. Each role is overridable with SLIDES_<ROLE>_MODEL.
 */
const DEFAULT_MODELS: Record<ModelRole, string> = {
  analyst: 'anthropic/claude-3.5-haiku',
  planner: 'anthropic/claude-3.5-haiku',
  designer: 'anthropic/claude-3.5-haiku',
  outliner: 'anthropic/claude-3.5-haiku',
  writer: 'anthropic/claude-3.5-haiku',
  illustrator: 'anthropic/claude-3.5-haiku',
  inspector: 'anthropic/claude-3.5-haiku',
  optimizer: 'anthropic/claude-3.5-haiku',
  reviewer: 'anthropic/claude-3.5-haiku',
};

/**
 * OpenRouter tries these in order when the primary model errors or is
 * unavailable; kept in the same price tier so a fallback never multiplies cost.
 */
const FALLBACK_MODELS: Record<ModelRole, string[]> = {
  analyst: ['openai/gpt-4o'],
  planner: ['openai/gpt-4o'],
  designer: ['openai/gpt-4o'],
  outliner: ['openai/gpt-4o'],
  writer: ['openai/gpt-4o'],
  illustrator: ['openai/gpt-4o'],
  inspector: ['openai/gpt-4o'],
  optimizer: ['openai/gpt-4o'],
  reviewer: ['openai/gpt-4o'],
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

/** Per-request plan model overrides (concurrent sessions must not mutate instance state). */
const planModelsStorage = new AsyncLocalStorage<PlanModelsMap>();

export function runWithPlanModels<T>(models: PlanModelsMap, fn: () => Promise<T>): Promise<T> {
  return planModelsStorage.run(models, fn);
}

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

  /** Effective models for the current ALS plan context (else env/defaults). */
  effectiveModels(): Record<ModelRole, string> {
    const plan = planModelsStorage.getStore();
    if (!plan) return this.models;
    const roles = Object.keys(DEFAULT_MODELS) as ModelRole[];
    return Object.fromEntries(
      roles.map((role) => {
        const override = plan[role] ?? plan.default;
        return [role, override?.model || this.models[role]];
      }),
    ) as Record<ModelRole, string>;
  }

  private resolveRole(role: ModelRole) {
    const plan = planModelsStorage.getStore();
    const override = plan?.[role] ?? plan?.default;
    const model = override?.model || this.models[role];
    const reasoning =
      override?.reasoningTokens != null && Number.isFinite(override.reasoningTokens)
        ? Math.max(0, Math.round(override.reasoningTokens))
        : this.reasoning[role];
    const maxTokens =
      override?.maxTokens != null && Number.isFinite(override.maxTokens)
        ? Math.max(1, Math.round(override.maxTokens))
        : MAX_TOKENS[role];
    const fallbacks = (
      override?.fallbackModels?.length
        ? override.fallbackModels
        : FALLBACK_MODELS[role]
    ).filter((candidate) => candidate !== model);
    return { model, reasoning, maxTokens, fallbacks };
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
    const { model, reasoning, maxTokens, fallbacks } = this.resolveRole(role);
    const { text } = await streamChatCompletion(
      this.client,
      {
        model,
        ...(fallbacks.length ? { models: [model, ...fallbacks] } : {}),
        // Reasoning models ignore temperature; thinking replaces sampling noise.
        ...(reasoning
          ? { reasoning: { max_tokens: reasoning, exclude: true } }
          : { temperature: options.temperature ?? 0.4 }),
        max_tokens: maxTokens + reasoning,
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
