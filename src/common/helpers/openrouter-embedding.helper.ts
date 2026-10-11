import type OpenAI from 'openai';
import {
  getAiContext,
  recordAiUsage,
  type ChatCompletionContext,
} from './openrouter-chat.helper';

export const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small';
/** Must match the `vector(N)` column in `reference_chunks`. */
export const EMBEDDING_DIMENSIONS = 1536;
export const EMBEDDING_BATCH_SIZE = 64;

/**
 * Embeds `inputs` in order, batching requests and logging token usage for the
 * admin console. Throws when the provider returns vectors of the wrong size.
 */
export async function createEmbeddings(
  client: OpenAI,
  model: string,
  inputs: string[],
  context?: ChatCompletionContext,
): Promise<number[][]> {
  const stored = getAiContext();
  const merged: ChatCompletionContext = {
    ...stored,
    ...context,
    purpose: context?.purpose || stored?.purpose || 'embedding',
  };
  const vectors: number[][] = [];

  for (let offset = 0; offset < inputs.length; offset += EMBEDDING_BATCH_SIZE) {
    const batch = inputs.slice(offset, offset + EMBEDDING_BATCH_SIZE);
    const startedAt = new Date();
    try {
      const response = await client.embeddings.create({
        model,
        input: batch,
        dimensions: EMBEDDING_DIMENSIONS,
        encoding_format: 'float',
      });
      const ordered = [...response.data].sort((a, b) => a.index - b.index);
      if (ordered.length !== batch.length) {
        throw new Error(
          `EMBEDDING_COUNT_MISMATCH: expected ${batch.length}, got ${ordered.length}`,
        );
      }
      for (const item of ordered) {
        if (item.embedding.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(
            `EMBEDDING_DIMENSION_MISMATCH: expected ${EMBEDDING_DIMENSIONS}, got ${item.embedding.length}`,
          );
        }
        vectors.push(item.embedding);
      }
      await recordAiUsage({
        userId: merged.userId ?? null,
        tenantId: merged.tenantId ?? null,
        purpose: merged.purpose,
        model,
        requestPreview: `${batch.length} input(s)`,
        promptTokens: response.usage?.prompt_tokens ?? null,
        completionTokens: 0,
        totalTokens: response.usage?.total_tokens ?? null,
        success: true,
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
      });
    } catch (error) {
      await recordAiUsage({
        userId: merged.userId ?? null,
        tenantId: merged.tenantId ?? null,
        purpose: merged.purpose,
        model,
        requestPreview: `${batch.length} input(s)`,
        success: false,
        errorMessage:
          error instanceof Error ? error.message : String(error ?? 'AI_ERROR'),
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
      });
      throw error;
    }
  }

  return vectors;
}

/** pgvector text literal, e.g. `[0.1,0.2]`, for `$1::vector` parameters. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((value) => (Number.isFinite(value) ? value : 0)).join(',')}]`;
}
