import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from 'prisma/prisma.service';
import type { SaveSlideTemplateDto } from './dto/slide-studio.dto';
import {
  allTemplates,
  customTemplateDbId,
  customTemplateFromRow,
  type SlideTemplate,
} from './slide-studio.templates';

const MAX_ASSET_BYTES = 6 * 1024 * 1024;
const MAX_TEMPLATES_PER_TENANT = 30;
const ASSET_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

const TEMPLATE_COLUMNS = {
  id: true,
  name: true,
  description: true,
  source: true,
  theme: true,
  createdById: true,
  createdAt: true,
} as const;

/** Institution slide templates: stored per tenant, assets under `public/slide-images/templates`. */
@Injectable()
export class SlideTemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  private assetDir(tenantId: number) {
    return join('slide-images', 'templates', String(tenantId));
  }

  async customTemplates(tenantId: number): Promise<SlideTemplate[]> {
    const rows = await this.prisma.slideTemplate.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      select: TEMPLATE_COLUMNS,
    });
    return rows.map(customTemplateFromRow);
  }

  async list(tenantId: number) {
    return allTemplates(await this.customTemplates(tenantId));
  }

  async findCustom(tenantId: number, templateId: string): Promise<SlideTemplate | null> {
    const dbId = customTemplateDbId(templateId);
    if (!dbId) return null;
    const row = await this.prisma.slideTemplate.findFirst({
      where: { id: dbId, tenantId },
      select: TEMPLATE_COLUMNS,
    });
    return row ? customTemplateFromRow(row) : null;
  }

  /** Brand images must be assets this tenant uploaded, never arbitrary URLs. */
  private assertOwnAssets(tenantId: number, theme: Record<string, unknown>) {
    const prefix = `/${this.assetDir(tenantId).replaceAll('\\', '/')}/`;
    const urls: string[] = [];
    const collect = (value: unknown, key = '') => {
      if (typeof value === 'string') {
        if (key === 'image' || key === 'logo') urls.push(value);
        return;
      }
      if (Array.isArray(value)) value.forEach((item) => collect(item));
      else if (value && typeof value === 'object') {
        for (const [childKey, child] of Object.entries(value)) collect(child, childKey);
      }
    };
    collect(theme.brand);
    const foreign = urls.find((url) => url && !url.startsWith(prefix));
    if (foreign) throw new BadRequestException('Template images must be uploaded first.');
    return urls.some(Boolean);
  }

  /**
   * Uploaded logos, artwork and imported PowerPoint files may be third-party
   * work, so saving them requires the uploader's rights confirmation, which is
   * kept with the template.
   */
  private themeWithRights(
    tenantId: number,
    userId: number | null,
    dto: SaveSlideTemplateDto,
    previous?: Record<string, unknown> | null,
  ): Record<string, unknown> {
    const theme = { ...dto.theme };
    delete theme.rights;
    const hasUploads = this.assertOwnAssets(tenantId, theme);
    if (!hasUploads && dto.source !== 'pptx') return theme;
    if (!dto.rightsConfirmed) {
      throw new BadRequestException(
        'Confirm that your institution owns or is licensed to use this template before saving it.',
      );
    }
    const kept = previous?.rights;
    return {
      ...theme,
      rights:
        kept && typeof kept === 'object' && !Array.isArray(kept)
          ? kept
          : { confirmedById: userId, confirmedAt: new Date().toISOString() },
    };
  }

  async create(tenantId: number, userId: number | null, dto: SaveSlideTemplateDto) {
    const count = await this.prisma.slideTemplate.count({ where: { tenantId } });
    if (count >= MAX_TEMPLATES_PER_TENANT) {
      throw new BadRequestException(
        `An institution can keep at most ${MAX_TEMPLATES_PER_TENANT} templates.`,
      );
    }
    const theme = this.themeWithRights(tenantId, userId, dto);
    const row = await this.prisma.slideTemplate.create({
      data: {
        tenantId,
        createdById: userId,
        name: dto.name,
        description: dto.description ?? null,
        source: dto.source,
        theme: theme as never,
      },
      select: TEMPLATE_COLUMNS,
    });
    return customTemplateFromRow(row);
  }

  async update(
    tenantId: number,
    userId: number | null,
    templateId: string,
    dto: SaveSlideTemplateDto,
  ) {
    const existing = await this.findCustom(tenantId, templateId);
    if (!existing?.custom) throw new NotFoundException('Template not found.');
    const theme = this.themeWithRights(tenantId, userId, dto, existing.theme);
    const row = await this.prisma.slideTemplate.update({
      where: { id: existing.custom.dbId },
      data: {
        name: dto.name,
        description: dto.description ?? null,
        source: dto.source,
        theme: theme as never,
      },
      select: TEMPLATE_COLUMNS,
    });
    return customTemplateFromRow(row);
  }

  /** Saved decks embed the theme in `deckMeta`, so assets stay on disk after deletion. */
  async remove(tenantId: number, templateId: string) {
    const existing = await this.findCustom(tenantId, templateId);
    if (!existing?.custom) throw new NotFoundException('Template not found.');
    await this.prisma.slideTemplate.delete({ where: { id: existing.custom.dbId } });
    return { id: templateId, deleted: true };
  }

  async uploadAsset(tenantId: number, file: Express.Multer.File | undefined) {
    if (!file) throw new BadRequestException('Image file is required.');
    const extension = ASSET_EXTENSIONS[file.mimetype?.toLowerCase() ?? ''];
    if (!extension) throw new BadRequestException('Image must be PNG, JPEG, WebP or SVG.');
    if (file.size > MAX_ASSET_BYTES) {
      throw new BadRequestException('Image must be smaller than 6 MB.');
    }
    const relativeDir = this.assetDir(tenantId);
    await mkdir(join(process.cwd(), 'public', relativeDir), { recursive: true });
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${extension}`;
    await writeFile(join(process.cwd(), 'public', relativeDir, fileName), file.buffer);
    return { url: `/${relativeDir.replaceAll('\\', '/')}/${fileName}` };
  }
}
