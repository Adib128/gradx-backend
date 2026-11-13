/** BullMQ queue for course reference vector indexing (pgvector). */
export const REFERENCE_EMBEDDING_QUEUE = 'reference-embedding';

/**
 * Max concurrent reference-embedding jobs on this process.
 * Keeps indexing from stampeding OpenRouter / the DB the way content
 * generation stays serialized on its queue. Override with
 * REFERENCE_EMBEDDING_QUEUE_CONCURRENCY (clamped 1–2). Default 1.
 */
export const REFERENCE_EMBEDDING_QUEUE_CONCURRENCY = Math.max(
  1,
  Math.min(
    2,
    Number(process.env.REFERENCE_EMBEDDING_QUEUE_CONCURRENCY || 1) || 1,
  ),
);

/** Debounce so rapid meta saves coalesce into one sync job. */
export const REFERENCE_EMBEDDING_SYNC_DEBOUNCE_MS = 3000;
