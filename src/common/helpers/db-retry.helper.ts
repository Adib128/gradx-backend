/**
 * Neon runs behind a connection pooler that drops idle connections, so a query
 * issued on a stale socket fails with a connection-level error before it ever
 * reaches the database. Those attempts are safe to replay.
 */

const RETRYABLE_CODES = new Set([
  // Prisma connection lifecycle
  'P1001', // can't reach database server
  'P1002', // database server reached but timed out
  'P1008', // operation timed out
  'P1017', // server has closed the connection
  'P2024', // timed out fetching a connection from the pool
  // Node socket errors surfaced through the pg adapter
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ENOTFOUND',
]);

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 150;

export function isRetryableDbError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && RETRYABLE_CODES.has(code)) return true;

  const name = (error as { name?: unknown } | null)?.name;
  return name === 'PrismaClientInitializationError';
}

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a database operation, replaying it when the failure was a dropped or
 * timed-out connection rather than a rejected query.
 */
export async function withDbRetry<T>(
  operation: () => Promise<T>,
  attempts = MAX_ATTEMPTS,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryableDbError(error)) throw error;
      await sleep(BASE_DELAY_MS * attempt);
    }
  }

  throw lastError;
}
