import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { PDFParse } from 'pdf-parse';
import sharp from 'sharp';
import { normalizeExtractedText } from 'src/topic-content/utils/normalize-pdf-text.util';
import { resolveReferenceDocumentDir } from './reference-document-storage.util';

export type ReferenceFigureAsset = {
  id: string;
  caption: string;
  pageNumber: number;
  filePath: string;
  mimeType: string;
  width: number;
  height: number;
};

const FIGURE_CAPTION_PATTERN =
  /(?:Figure|Fig\.?|FIGURE|FIG\.?)\s+(\d+(?:\.\d+)*)\s*[:.\-–—]?\s*([^\n]{0,180})/g;

const MAX_FIGURES_PER_DOCUMENT = 24;
const SCREENSHOT_SCALE = 1.35;
const MAX_IMAGE_WIDTH = 1100;
const JPEG_QUALITY = 72;
/** Skip tiny icons / bullets when pulling embedded images. */
const MIN_EMBEDDED_IMAGE_EDGE = 80;

function extractCaptionsFromPageText(
  pageNumber: number,
  pageText: string,
): Array<{ caption: string; pageNumber: number }> {
  const normalized = normalizeExtractedText(pageText);
  if (!normalized) return [];

  const found: Array<{ caption: string; pageNumber: number }> = [];
  const seen = new Set<string>();

  for (const match of normalized.matchAll(FIGURE_CAPTION_PATTERN)) {
    const number = match[1]?.trim();
    const title = String(match[2] || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[.\s]+$/, '');
    if (!number) continue;
    const key = number.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const caption = title
      ? `Figure ${number}: ${title}`
      : `Figure ${number}`;
    found.push({ caption: caption.slice(0, 220), pageNumber });
  }

  return found;
}

async function compressFigureBuffer(raw: Buffer): Promise<{
  data: Buffer;
  width: number;
  height: number;
}> {
  const compressed = await sharp(raw)
    .rotate()
    .resize({
      width: MAX_IMAGE_WIDTH,
      withoutEnlargement: true,
    })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  return {
    data: compressed.data,
    width: compressed.info.width,
    height: compressed.info.height,
  };
}

/**
 * Extract figure assets for a PDF:
 * - Parse captions from the text layer
 * - Prefer large embedded images on those pages
 * - Fall back to a full-page raster when no suitable embedded image exists
 */
export async function extractReferenceFigureAssets(options: {
  buffer: Buffer;
  tenantId: number;
  documentStoredName: string;
}): Promise<ReferenceFigureAsset[]> {
  const parser = new PDFParse({ data: options.buffer });

  try {
    const info = await parser.getInfo();
    const pageCount = Math.max(info.total ?? 0, 1);
    const textResult = await parser.getText({
      parseHyperlinks: true,
      lineEnforce: true,
      pageJoiner: '',
      itemJoiner: ' ',
    });

    const captionHits: Array<{ caption: string; pageNumber: number }> = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const pageText =
        textResult.getPageText(pageNumber) ??
        textResult.pages.find((page) => page.num === pageNumber)?.text ??
        '';
      captionHits.push(...extractCaptionsFromPageText(pageNumber, pageText));
      if (captionHits.length >= MAX_FIGURES_PER_DOCUMENT) break;
    }

    if (captionHits.length === 0) {
      return [];
    }

    const limited = captionHits.slice(0, MAX_FIGURES_PER_DOCUMENT);
    const pageNumbers = [
      ...new Set(limited.map((hit) => hit.pageNumber)),
    ].sort((a, b) => a - b);

    const embeddedByPage = new Map<number, Buffer[]>();
    try {
      const imageResult = await parser.getImage({
        partial: pageNumbers,
        imageThreshold: MIN_EMBEDDED_IMAGE_EDGE,
        imageBuffer: true,
        imageDataUrl: false,
      });
      for (const page of imageResult.pages ?? []) {
        const buffers = (page.images ?? [])
          .map((image) => {
            if (!image?.data) return null;
            return Buffer.from(image.data);
          })
          .filter(Boolean) as Buffer[];
        // Prefer larger embeddings first (diagrams over icons).
        buffers.sort((a, b) => b.length - a.length);
        if (buffers.length) {
          embeddedByPage.set(page.pageNumber, buffers);
        }
      }
    } catch {
      // Embedded image extraction is best-effort; screenshots still work.
    }

    const pagesNeedingScreenshot = pageNumbers.filter(
      (pageNumber) => !embeddedByPage.has(pageNumber),
    );
    const screenshotByPage = new Map<number, Buffer>();
    if (pagesNeedingScreenshot.length > 0) {
      const screenshots = await parser.getScreenshot({
        scale: SCREENSHOT_SCALE,
        partial: pagesNeedingScreenshot,
        imageBuffer: true,
        imageDataUrl: false,
      });
      for (const page of screenshots.pages) {
        if (page.data?.length) {
          screenshotByPage.set(page.pageNumber, Buffer.from(page.data));
        }
      }
    }

    const docKey = basename(options.documentStoredName).replace(
      /[^\w.\-]+/g,
      '_',
    );
    const { absoluteDir, relativeDir } = resolveReferenceDocumentDir(
      options.tenantId,
    );
    const figuresAbsDir = join(absoluteDir, 'figures', docKey);
    const figuresRelDir = join(relativeDir, 'figures', docKey);
    await mkdir(figuresAbsDir, { recursive: true });

    const assets: ReferenceFigureAsset[] = [];
    const usedEmbeddedIndex = new Map<number, number>();
    let figureOrdinal = 0;

    for (const hit of limited) {
      const embeddedList = embeddedByPage.get(hit.pageNumber) ?? [];
      const nextEmbedded = usedEmbeddedIndex.get(hit.pageNumber) ?? 0;
      let raw: Buffer | undefined = embeddedList[nextEmbedded];
      if (raw) {
        usedEmbeddedIndex.set(hit.pageNumber, nextEmbedded + 1);
      } else {
        raw = screenshotByPage.get(hit.pageNumber);
        if (!raw && !screenshotByPage.has(hit.pageNumber)) {
          // Lazy screenshot if we exhausted embeddings for a shared page.
          try {
            const screenshots = await parser.getScreenshot({
              scale: SCREENSHOT_SCALE,
              partial: [hit.pageNumber],
              imageBuffer: true,
              imageDataUrl: false,
            });
            const page = screenshots.pages[0];
            if (page?.data?.length) {
              raw = Buffer.from(page.data);
              screenshotByPage.set(hit.pageNumber, raw);
            }
          } catch {
            raw = undefined;
          }
        }
      }
      if (!raw?.length) continue;

      let compressed: { data: Buffer; width: number; height: number };
      try {
        compressed = await compressFigureBuffer(raw);
      } catch {
        continue;
      }

      figureOrdinal += 1;
      const id = `fig-${figureOrdinal}`;
      const fileName = `${id}.jpg`;
      const absolutePath = join(figuresAbsDir, fileName);
      await writeFile(absolutePath, compressed.data);

      assets.push({
        id,
        caption: hit.caption,
        pageNumber: hit.pageNumber,
        filePath: join(figuresRelDir, fileName),
        mimeType: 'image/jpeg',
        width: compressed.width,
        height: compressed.height,
      });
    }

    return assets;
  } finally {
    await parser.destroy();
  }
}

/** Page numbers mentioned in chapter text (`--- Page N ---`). */
export function pagesInChapterContent(content: string): Set<number> {
  const pages = new Set<number>();
  for (const match of String(content || '').matchAll(
    /---\s*Page\s+(\d+)\s*---/gi,
  )) {
    const page = Number(match[1]);
    if (Number.isFinite(page) && page > 0) pages.add(page);
  }
  return pages;
}

export function filterFiguresForChapters<
  T extends { pageNumber: number },
>(
  figures: T[] | null | undefined,
  chapters: Array<{ content?: string | null }> | null | undefined,
): T[] {
  if (!Array.isArray(figures) || figures.length === 0) return [];
  if (!Array.isArray(chapters) || chapters.length === 0) return [];

  const pages = new Set<number>();
  for (const chapter of chapters) {
    for (const page of pagesInChapterContent(String(chapter.content || ''))) {
      pages.add(page);
    }
  }

  if (pages.size === 0) {
    // No page markers — keep figures when chapters were explicitly selected.
    return figures;
  }

  return figures.filter((figure) => pages.has(figure.pageNumber));
}
