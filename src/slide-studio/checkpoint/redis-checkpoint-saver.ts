import type { RunnableConfig } from '@langchain/core/runnables';
import {
  MemorySaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
} from '@langchain/langgraph-checkpoint';
import type Redis from 'ioredis';

type StoredCheckpoint = [Uint8Array, Uint8Array, string | undefined];
type StoredWrite = [string, string, Uint8Array];

const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const decode = (text: string) => new Uint8Array(Buffer.from(text, 'base64'));

/** Same key format MemorySaver uses for its `writes` map. */
const writesKey = (threadId: string, ns: string, checkpointId: string) =>
  JSON.stringify([threadId, ns, checkpointId]);

const threadOf = (config: RunnableConfig) => {
  const threadId = config.configurable?.thread_id;
  return typeof threadId === 'string' && threadId ? threadId : null;
};

/**
 * LangGraph checkpointer persisted in Redis (plain Redis, no modules).
 *
 * Reuses MemorySaver's tuple/list/merge logic: each operation re-hydrates the
 * thread from Redis, runs MemorySaver, writes the result through, then drops
 * the thread from memory. Operations on one thread are serialized because
 * MemorySaver mutates shared maps across awaits. Only the newest
 * `keepCheckpoints` per thread are kept and threads expire after `ttlSeconds`;
 * the finished deck is persisted elsewhere.
 */
export class RedisCheckpointSaver extends MemorySaver {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly redis: Redis,
    private readonly options: {
      prefix: string;
      ttlSeconds: number;
      keepCheckpoints: number;
    },
  ) {
    super();
  }

  private checkpointsKey(threadId: string) {
    return `${this.options.prefix}:${threadId}:checkpoints`;
  }

  private writesHashKey(threadId: string, ns: string, checkpointId: string) {
    return `${this.options.prefix}:${threadId}:writes:${ns}:${checkpointId}`;
  }

  private withThread<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(threadId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        await this.hydrate(threadId);
        try {
          return await fn();
        } finally {
          this.evict(threadId);
        }
      });
    this.chains.set(threadId, run);
    void run.finally(() => {
      if (this.chains.get(threadId) === run) this.chains.delete(threadId);
    }).catch(() => undefined);
    return run;
  }

  private async hydrate(threadId: string) {
    const raw = await this.redis.hgetall(this.checkpointsKey(threadId));
    const byNs: Record<string, Record<string, StoredCheckpoint>> =
      Object.create(null);
    const writes: Record<string, Record<string, StoredWrite>> =
      Object.create(null);

    await Promise.all(
      Object.entries(raw).map(async ([field, value]) => {
        const [ns, checkpointId] = JSON.parse(field) as [string, string];
        const [checkpoint, metadata, parentId] = JSON.parse(value) as [
          string,
          string,
          string | null,
        ];
        byNs[ns] ??= Object.create(null);
        byNs[ns][checkpointId] = [
          decode(checkpoint),
          decode(metadata),
          parentId ?? undefined,
        ];
        const storedWrites = await this.redis.hgetall(
          this.writesHashKey(threadId, ns, checkpointId),
        );
        const inner: Record<string, StoredWrite> = Object.create(null);
        for (const [innerKey, encoded] of Object.entries(storedWrites)) {
          const [taskId, channel, payload] = JSON.parse(encoded) as [
            string,
            string,
            string,
          ];
          inner[innerKey] = [taskId, channel, decode(payload)];
        }
        if (Object.keys(inner).length) {
          writes[writesKey(threadId, ns, checkpointId)] = inner;
        }
      }),
    );

    this.evict(threadId);
    if (Object.keys(byNs).length) this.storage[threadId] = byNs;
    Object.assign(this.writes, writes);
  }

  private evict(threadId: string) {
    delete this.storage[threadId];
    for (const key of Object.keys(this.writes)) {
      if ((JSON.parse(key) as string[])[0] === threadId) delete this.writes[key];
    }
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = threadOf(config);
    if (!threadId) return undefined;
    return this.withThread(threadId, () => super.getTuple(config));
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = threadOf(config);
    if (!threadId) return;
    const tuples = await this.withThread(threadId, async () => {
      const collected: CheckpointTuple[] = [];
      for await (const tuple of super.list(config, options)) collected.push(tuple);
      return collected;
    });
    yield* tuples;
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const threadId = threadOf(config);
    if (!threadId) return super.put(config, checkpoint, metadata);
    return this.withThread(threadId, async () => {
      const next = await super.put(config, checkpoint, metadata);
      const ns = (next.configurable?.checkpoint_ns as string) ?? '';
      const checkpointId = next.configurable?.checkpoint_id as string;
      const stored = this.storage[threadId]?.[ns]?.[checkpointId] as
        | StoredCheckpoint
        | undefined;
      if (stored) {
        const key = this.checkpointsKey(threadId);
        await this.redis
          .multi()
          .hset(
            key,
            JSON.stringify([ns, checkpointId]),
            JSON.stringify([
              encode(stored[0]),
              encode(stored[1]),
              stored[2] ?? null,
            ]),
          )
          .expire(key, this.options.ttlSeconds)
          .exec();
        await this.prune(threadId, ns);
      }
      return next;
    });
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    const threadId = threadOf(config);
    if (!threadId) return super.putWrites(config, writes, taskId);
    const ns = (config.configurable?.checkpoint_ns as string) ?? '';
    const checkpointId = config.configurable?.checkpoint_id as string;
    await this.withThread(threadId, async () => {
      await super.putWrites(config, writes, taskId);
      const inner = this.writes[writesKey(threadId, ns, checkpointId)] as
        | Record<string, StoredWrite>
        | undefined;
      if (!inner) return;
      const hashKey = this.writesHashKey(threadId, ns, checkpointId);
      const fields: Record<string, string> = {};
      for (const [innerKey, [task, channel, payload]] of Object.entries(inner)) {
        fields[innerKey] = JSON.stringify([task, channel, encode(payload)]);
      }
      await this.redis
        .multi()
        .hset(hashKey, fields)
        .expire(hashKey, this.options.ttlSeconds)
        .exec();
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.withThread(threadId, async () => {
      const keys = await this.scanKeys(`${this.options.prefix}:${threadId}:*`);
      if (keys.length) await this.redis.del(...keys);
    });
  }

  private async prune(threadId: string, ns: string) {
    const checkpoints = this.storage[threadId]?.[ns];
    if (!checkpoints) return;
    // Checkpoint ids are time-ordered (uuid6), so lexical order is age order.
    const ids = Object.keys(checkpoints).sort((a, b) => a.localeCompare(b));
    const stale = ids.slice(
      0,
      Math.max(0, ids.length - this.options.keepCheckpoints),
    );
    if (!stale.length) return;
    const pipeline = this.redis.multi();
    for (const id of stale) {
      pipeline.hdel(this.checkpointsKey(threadId), JSON.stringify([ns, id]));
      pipeline.del(this.writesHashKey(threadId, ns, id));
    }
    await pipeline.exec();
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        200,
      );
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }
}
