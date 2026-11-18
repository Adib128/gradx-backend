import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { extname, join } from 'path';
import { randomBytes } from 'crypto';
import { Prisma } from 'generated/prisma/client';
import { PrismaService } from 'prisma/prisma.service';
import { ErrorMessageKey } from 'src/common/constants/error-message';
import { requireTenantId } from 'src/common/helpers/require-tenant.helper';
import {
  DEFAULT_TENANT_BRANDING,
  normalizeTenantBranding,
  type TenantBranding,
} from './tenant-branding.types';

@Injectable()
export class TenantBrandingService {
  constructor(private readonly prisma: PrismaService) {}

  async get(tenantId: number): Promise<TenantBranding> {
    requireTenantId(tenantId);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { branding: true },
    });
    if (!tenant) throw new NotFoundException('TENANT_NOT_FOUND');
    if (tenant.branding == null) return { ...DEFAULT_TENANT_BRANDING };
    return normalizeTenantBranding(tenant.branding);
  }

  async update(
    tenantId: number,
    body: Partial<TenantBranding>,
  ): Promise<TenantBranding> {
    requireTenantId(tenantId);
    const current = await this.get(tenantId);
    const merged = normalizeTenantBranding({ ...current, ...body });

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { branding: merged as Prisma.InputJsonValue },
    });

    return merged;
  }

  async uploadLogo(
    tenantId: number,
    file: Express.Multer.File,
  ): Promise<TenantBranding> {
    requireTenantId(tenantId);
    if (!file?.buffer?.length) {
      throw new BadRequestException(ErrorMessageKey.VALIDATION_FAILED);
    }

    const allowed = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif'];
    const ext = extname(file.originalname || '').toLowerCase() || '.png';
    if (!allowed.includes(ext)) {
      throw new BadRequestException(ErrorMessageKey.VALIDATION_FAILED);
    }

    const dir = join(process.cwd(), 'public', 'tenant-logos');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const filename = `tenant-${tenantId}${ext}`;
    writeFileSync(join(dir, filename), file.buffer);
    const logoUrl = `/tenant-logos/${filename}?v=${randomBytes(3).toString('hex')}`;

    return this.update(tenantId, { logoUrl });
  }
}
