import { UnauthorizedException } from '@nestjs/common';

/** Reject missing/invalid JWT tenant ids so Prisma never drops the filter. */
export function requireTenantId(tenantId: unknown): number {
  const id = typeof tenantId === 'number' ? tenantId : Number(tenantId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new UnauthorizedException('TENANT_REQUIRED');
  }
  return id;
}
