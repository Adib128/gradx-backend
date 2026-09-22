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

const FIGURE_CAPTION_LINE_PATTERN =
  /^(?:Figure|Fig\.?|FIGURE|FIG\.?)\s+(\d+(?:\.\d+)*)\s*[:.\-–—]?\s*(.*)$/i;

const MAX_FIGURES_PER_DOCUMENT = 80;
const MAX_IMAGE_WIDTH = 1100;
const JPEG_QUALITY = 78;
/** Skip tiny icons / bullets when pulling embedded images. */
const MIN_EMBEDDED_IMAGE_EDGE = 80;
/** Screenshot scale for vector-diagram fallback crops. */
const SCREENSHOT_SCALE = 1.5;
const SCREENSHOT_BATCH_SIZE = 6;

type CaptionHit = {
  caption: string;
  figureNumber: string;
  pageNumber: number;
};

function extractCaptionsFromPageText(
  pageNumber: number,
  pageText: string,
): CaptionHit[] {
  const normalized = normalizeExtractedText(pageText);
  if (!normalized) return [];

  const found: CaptionHit[] = [];
  const seen = new Set<string>();

  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const match = line.match(FIGURE_CAPTION_LINE_PATTERN);
    if (!match?.[1]) continue;
    const number = match[1].trim();
    const key = number.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const title = String(match[2] || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[.\s]+$/, '');
    // Ignore TOC-like junk / bare numbers with no real title when title is huge body wrap.
    if (title.length > 160) continue;
    if (/^(?:and|or|the|of|in|to|for|with|by)\b/i.test(title)) continue;

    const caption = title ? `Figure ${number}: ${title}` : `Figure ${number}`;
    found.push({
      caption: caption.slice(0, 220),
      figureNumber: number,
      pageNumber,
    });
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

type PageTextGeometry = {
  pageHeight: number;
  pageWidth: number;
  /** Caption baseline Y in PDF coords (origin bottom-left). */
  captionYs: Map<string, number>;
  textItems: Array<{ y: number; x: number; str: string }>;
};

async function loadPageTextGeometry(
  buffer: Buffer,
  pageNumbers: number[],
): Promise<Map<number, PageTextGeometry>> {
  const geometry = new Map<number, PageTextGeometry>();
  if (pageNumbers.length === 0) return geometry;

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;

  try {
    for (const pageNumber of pageNumbers) {
      if (pageNumber < 1 || pageNumber > doc.numPages) continue;
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const captionYs = new Map<string, number>();
      const textItems: Array<{ y: number; x: number; str: string }> = [];

      for (const item of textContent.items) {
        if (!('str' in item) || !('transform' in item)) continue;
        const str = String(item.str || '').trim();
        if (!str) continue;
        const y = Number(item.transform[5]);
        const x = Number(item.transform[4]);
        if (!Number.isFinite(y) || !Number.isFinite(x)) continue;
        textItems.push({ y, x, str });

        const match = str.match(
          /^(?:Figure|Fig\.?|FIGURE|FIG\.?)\s*(\d+(?:\.\d+)*)\b/i,
        );
        if (!match?.[1]) continue;
        const key = match[1].toLowerCase();
        // Prefer the lowest Y (true caption under the diagram) when duplicates exist.
        const existing = captionYs.get(key);
        if (existing == null || y < existing) captionYs.set(key, y);
      }

      geometry.set(pageNumber, {
        pageHeight: viewport.height,
        pageWidth: viewport.width,
        captionYs,
        textItems,
      });
    }
  } finally {
    await doc.destroy();
  }

  return geometry;
}

function resolveFigureCropBox(options: {
  pageHeight: number;
  pageWidth: number;
  imageWidth: number;
  imageHeight: number;
  captionY: number | null;
  textItems: Array<{ y: number; x: number; str: string }>;
}): { left: number; top: number; width: number; height: number } | null {
  const {
    pageHeight,
    pageWidth,
    imageWidth,
    imageHeight,
    captionY,
    textItems,
  } = options;

  if (captionY == null || !(pageHeight > 0) || !(imageHeight > 0)) {
    return null;
  }

  const scaleY = imageHeight / pageHeight;
  const scaleX = imageWidth / pageWidth;
  const leftMargin = pageWidth * 0.22;

  // First substantial body-text line above the caption → bottom of text / top of figure.
  let bodyBottomY: number | null = null;
  for (const item of textItems) {
    if (item.y <= captionY + 36) continue;
    if (item.str.length < 40) continue;
    if (item.x > leftMargin) continue;
    if (bodyBottomY == null || item.y < bodyBottomY) bodyBottomY = item.y;
  }

  const figureTopY =
    bodyBottomY != null
      ? bodyBottomY
      : Math.min(pageHeight * 0.92, captionY + pageHeight * 0.42);

  const sidePad = Math.round(imageWidth * 0.05);
  const top = Math.max(
    0,
    Math.round((pageHeight - figureTopY) * scaleY) + Math.round(6 * scaleY),
  );
  const bottom = Math.min(
    imageHeight,
    Math.round((pageHeight - (captionY - 8)) * scaleY),
  );
  const height = bottom - top;
  if (height < 48) return null;

  return {
    left: sidePad,
    top,
    width: Math.max(40, imageWidth - sidePad * 2),
    height,
  };
}

async function cropFigureFromScreenshot(options: {
  screenshot: Buffer;
  imageWidth: number;
  imageHeight: number;
  pageHeight: number;
  pageWidth: number;
  captionY: number | null;
  textItems: Array<{ y: number; x: number; str: string }>;
}): Promise<Buffer | null> {
  const box = resolveFigureCropBox(options);
  if (!box) {
    // Last resort: keep a centered band of the page (still better than nothing).
    const bandTop = Math.round(options.imageHeight * 0.18);
    const bandHeight = Math.round(options.imageHeight * 0.62);
    try {
      const { data } = await sharp(options.screenshot)
        .extract({
          left: Math.round(options.imageWidth * 0.05),
          top: bandTop,
          width: Math.round(options.imageWidth * 0.9),
          height: bandHeight,
        })
        .toBuffer({ resolveWithObject: true });
      return data;
    } catch {
      return options.screenshot;
    }
  }

  try {
    const { data } = await sharp(options.screenshot)
      .extract(box)
      .toBuffer({ resolveWithObject: true });
    return data;
  } catch {
    return null;
  }
}

/**
 * Extract figure assets for a PDF:
 * - Parse captions from the text layer (labels only)
 * - Prefer large embedded raster images
 * - Fall back to cropped page screenshots for vector diagrams (common in textbooks)
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

    const captionHits: CaptionHit[] = [];
    const seenNumbers = new Set<string>();
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const pageText =
        textResult.getPageText(pageNumber) ??
        textResult.pages.find((page) => page.num === pageNumber)?.text ??
        '';
      for (const hit of extractCaptionsFromPageText(pageNumber, pageText)) {
        const key = hit.figureNumber.toLowerCase();
        if (seenNumbers.has(key)) continue;
        seenNumbers.add(key);
        captionHits.push(hit);
        if (captionHits.length >= MAX_FIGURES_PER_DOCUMENT) break;
      }
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
        buffers.sort((a, b) => b.length - a.length);
        if (buffers.length) {
          embeddedByPage.set(page.pageNumber, buffers);
        }
      }
    } catch {
      // Embedded image extraction is best-effort.
    }

    const needsScreenshot = pageNumbers.filter(
      (pageNumber) => (embeddedByPage.get(pageNumber)?.length ?? 0) === 0,
    );

    const screenshotsByPage = new Map<
      number,
      { data: Buffer; width: number; height: number }
    >();
    for (let i = 0; i < needsScreenshot.length; i += SCREENSHOT_BATCH_SIZE) {
      const batch = needsScreenshot.slice(i, i + SCREENSHOT_BATCH_SIZE);
      try {
        const shot = await parser.getScreenshot({
          partial: batch,
          scale: SCREENSHOT_SCALE,
          imageBuffer: true,
          imageDataUrl: false,
        });
        for (const page of shot.pages ?? []) {
          if (!page?.data?.length) continue;
          screenshotsByPage.set(page.pageNumber, {
            data: Buffer.from(page.data),
            width: page.width,
            height: page.height,
          });
        }
      } catch {
        // Screenshot fallback is best-effort per batch.
      }
    }

    const geometryByPage = await loadPageTextGeometry(
      options.buffer,
      needsScreenshot,
    );

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
      let raw: Buffer | undefined;

      const embeddedList = embeddedByPage.get(hit.pageNumber) ?? [];
      const nextEmbedded = usedEmbeddedIndex.get(hit.pageNumber) ?? 0;
      if (embeddedList[nextEmbedded]?.length) {
        raw = embeddedList[nextEmbedded];
        usedEmbeddedIndex.set(hit.pageNumber, nextEmbedded + 1);
      } else {
        const shot = screenshotsByPage.get(hit.pageNumber);
        const geometry = geometryByPage.get(hit.pageNumber);
        if (shot && geometry) {
          const captionY =
            geometry.captionYs.get(hit.figureNumber.toLowerCase()) ?? null;
          const cropped = await cropFigureFromScreenshot({
            screenshot: shot.data,
            imageWidth: shot.width,
            imageHeight: shot.height,
            pageHeight: geometry.pageHeight,
            pageWidth: geometry.pageWidth,
            captionY,
            textItems: geometry.textItems,
          });
          if (cropped?.length) raw = cropped;
        } else if (shot) {
          raw = shot.data;
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

/** Page numbers covered by a chapter (markers and/or explicit start/end). */
export function pagesInChapterContent(
  content: string,
  options?: { startPage?: number | null; endPage?: number | null },
): Set<number> {
  const pages = new Set<number>();
  const start = Number(options?.startPage);
  const end = Number(options?.endPage);
  if (Number.isFinite(start) && start > 0 && Number.isFinite(end) && end >= start) {
    for (let page = Math.round(start); page <= Math.round(end); page += 1) {
      pages.add(page);
    }
  }
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
  chapters:
    | Array<{
        content?: string | null;
        startPage?: number | null;
        endPage?: number | null;
      }>
    | null
    | undefined,
): T[] {
  if (!Array.isArray(figures) || figures.length === 0) return [];
  if (!Array.isArray(chapters) || chapters.length === 0) return [];

  const pages = new Set<number>();
  for (const chapter of chapters) {
    for (const page of pagesInChapterContent(String(chapter.content || ''), {
      startPage: chapter.startPage,
      endPage: chapter.endPage,
    })) {
      pages.add(page);
    }
  }

  if (pages.size === 0) {
    return figures;
  }

  return figures.filter((figure) => pages.has(figure.pageNumber));
}
