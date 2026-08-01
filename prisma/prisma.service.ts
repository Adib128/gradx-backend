import { PrismaClient, Prisma } from '../generated/prisma/client';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  public readonly extended = this.$extends({
    model: {
      $allModels: {
        // 1. Mutate hard deletes into soft delete updates
        async delete<T, A>(
          this: T,
          args: Prisma.Exact<A, Prisma.Args<T, 'delete'>>,
        ): Promise<Prisma.Result<T, A, 'update'>> {
          const ctx = Prisma.getExtensionContext(this);
          // Cast args as any to ensure TS safely allows reading the 'where' criteria
          const rawArgs = args as any;
          return (ctx as any).update({
            where: rawArgs?.where,
            data: { deletedAt: new Date() },
          });
        },

        async deleteMany<T, A>(
          this: T,
          args: Prisma.Exact<A, Prisma.Args<T, 'deleteMany'>>,
        ): Promise<Prisma.Result<T, A, 'updateMany'>> {
          const ctx = Prisma.getExtensionContext(this);
          const rawArgs = args as any;
          return (ctx as any).updateMany({
            where: rawArgs?.where,
            data: { deletedAt: new Date() },
          });
        },
      },
    },
    query: {
      $allModels: {
        // 2. Automatically inject { deletedAt: null } filter into reads
        async findMany({ args, query }) {
          args.where = args.where || {};
          const where = args.where as any;
          if (where.deletedAt === undefined) {
            where.deletedAt = null;
          }
          return query(args);
        },

        async findFirst({ args, query }) {
          args.where = args.where || {};
          const where = args.where as any;
          if (where.deletedAt === undefined) {
            where.deletedAt = null;
          }
          return query(args);
        },

        async findUnique({ args, query }) {
          args.where = args.where || {};
          const where = args.where as any;
          if (where.deletedAt === undefined) {
            where.deletedAt = null;
          }
          return this.findFirst(args);
        },

        async count({ args, query }) {
          args.where = args.where || {};
          const where = args.where as any;
          if (where.deletedAt === undefined) {
            where.deletedAt = null;
          }
          return query(args);
        },
      },
    },
  });

  constructor() {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DATABASE_POOL_MAX) || 10,
      // Neon's pooler closes idle connections; recycle ours first so queries
      // are never issued on a socket the server already dropped.
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
    });
    // An idle client error is emitted on the pool, and would be an unhandled
    // rejection that takes the process down.
    pool.on('error', (error) => {
      console.error('Postgres pool error:', error.message);
    });
    const adapter = new PrismaPg(pool);
    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
