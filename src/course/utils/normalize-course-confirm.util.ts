import {
  MAX_REFERENCE_EXTRACTED_CHARS,
  sanitizeTextForJsonStorage,
  type ReferenceChapter,
} from './extract-reference-document.util';

const REFERENCE_TYPES = new Set([
  'ESSENTIAL',
  'SUPPORTIVE',
  'ELECTRONIC',
  'OTHER',
]);

export function normalizeReferenceType(value: unknown): string {
  const raw = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  if (REFERENCE_TYPES.has(raw)) return raw;
  if (raw.includes('ESSENTIAL') || raw.includes('TEXTBOOK') || raw.includes('REQUIRED')) {
    return 'ESSENTIAL';
  }
  if (raw.includes('SUPPORT') || raw.includes('SUPPLEMENT')) return 'SUPPORTIVE';
  if (
    raw.includes('ELECTRON') ||
    raw.includes('ONLINE') ||
    raw.includes('DIGITAL') ||
    raw.includes('WEB')
  ) {
    return 'ELECTRONIC';
  }
  return 'OTHER';
}

function optionalString(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}

function sanitizeReferenceExtractedText(value: unknown): {
  extractedText: string | null;
  truncated: boolean | null;
  characterCount: number | null;
} {
  if (typeof value !== 'string' || !value.trim()) {
    return { extractedText: null, truncated: null, characterCount: null };
  }

  const sanitized = sanitizeTextForJsonStorage(value);
  if (!sanitized) {
    return { extractedText: null, truncated: null, characterCount: null };
  }

  if (sanitized.length <= MAX_REFERENCE_EXTRACTED_CHARS) {
    return {
      extractedText: sanitized,
      truncated: false,
      characterCount: sanitized.length,
    };
  }

  const truncatedText = `${sanitized.slice(0, MAX_REFERENCE_EXTRACTED_CHARS)}\n\n[…truncated for storage limit…]`;
  return {
    extractedText: truncatedText,
    truncated: true,
    characterCount: truncatedText.length,
  };
}

function sanitizeReferenceChapters(value: unknown): {
  chapters: ReferenceChapter[] | null;
  truncated: boolean | null;
  characterCount: number | null;
} {
  if (!Array.isArray(value)) {
    return { chapters: null, truncated: null, characterCount: null };
  }

  let remaining = MAX_REFERENCE_EXTRACTED_CHARS;
  let truncated = false;
  const chapters: ReferenceChapter[] = [];

  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    const row = item as Record<string, unknown>;
    const name =
      String(row.name ?? '').trim() ||
      `Chapter ${chapters.length + 1}`;
    const content = sanitizeTextForJsonStorage(String(row.content ?? ''));
    if (!content) continue;

    if (content.length <= remaining) {
      chapters.push({ name, content });
      remaining -= content.length;
      continue;
    }

    chapters.push({
      name,
      content: `${content.slice(0, remaining)}\n\n[…truncated for storage limit…]`,
    });
    truncated = true;
    remaining = 0;
  }

  if (chapters.length === 0) {
    return { chapters: null, truncated: null, characterCount: null };
  }

  const characterCount = chapters.reduce(
    (total, chapter) => total + chapter.content.length,
    0,
  );

  return { chapters, truncated, characterCount };
}

export function normalizeReferencesForStorage(
  references: unknown,
): Array<Record<string, unknown>> {
  if (!Array.isArray(references)) return [];

  const rows: Array<Record<string, unknown>> = [];

  for (const reference of references) {
    if (!reference || typeof reference !== 'object') continue;

    const row = reference as Record<string, unknown>;
    const title = String(row.title ?? '').trim();
    if (!title) continue;

    const sanitizedChapters = sanitizeReferenceChapters(row.chapters);
    const legacyExtracted = sanitizeReferenceExtractedText(row.extractedText);

    // Chapter text is the AI source of truth. Migrate legacy flat blobs on save.
    let chapters = sanitizedChapters.chapters;
    let truncated = sanitizedChapters.truncated;
    let characterCount = sanitizedChapters.characterCount;

    if (!chapters?.length && legacyExtracted.extractedText) {
      chapters = [
        {
          name: 'Document',
          content: legacyExtracted.extractedText,
        },
      ];
      truncated = legacyExtracted.truncated;
      characterCount = legacyExtracted.characterCount;
    }

    rows.push({
      type: normalizeReferenceType(row.type),
      title,
      authors: optionalString(row.authors),
      publisher: optionalString(row.publisher),
      fileName: optionalString(row.fileName),
      filePath: optionalString(row.filePath),
      mimeType: optionalString(row.mimeType),
      fileSize:
        row.fileSize != null && Number.isFinite(Number(row.fileSize))
          ? Math.max(0, Math.round(Number(row.fileSize)))
          : null,
      extractedText: null,
      chapters,
      characterCount,
      truncated,
      extractionMethod:
        row.extractionMethod === 'pdf' || row.extractionMethod === 'docx'
          ? row.extractionMethod
          : null,
      extractedAt: optionalString(row.extractedAt),
      figures: sanitizeReferenceFigures(row.figures),
    });
  }

  return rows;
}

function sanitizeReferenceFigures(value: unknown) {
  if (!Array.isArray(value)) return null;
  const figures: Array<{
    id: string;
    caption: string;
    pageNumber: number;
    filePath: string;
    mimeType: string;
    width: number | null;
    height: number | null;
  }> = [];

  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = String(row.id ?? '').trim();
    const caption = String(row.caption ?? '').trim();
    const filePath = String(row.filePath ?? '')
      .replace(/\\/g, '/')
      .trim();
    const mimeType = String(row.mimeType ?? 'image/jpeg').trim();
    const pageNumber = Number(row.pageNumber);
    if (!id || !caption || !filePath || !Number.isFinite(pageNumber)) continue;
    figures.push({
      id,
      caption: caption.slice(0, 220),
      pageNumber: Math.max(1, Math.round(pageNumber)),
      filePath,
      mimeType,
      width:
        row.width != null && Number.isFinite(Number(row.width))
          ? Math.max(1, Math.round(Number(row.width)))
          : null,
      height:
        row.height != null && Number.isFinite(Number(row.height))
          ? Math.max(1, Math.round(Number(row.height)))
          : null,
    });
    if (figures.length >= 48) break;
  }

  return figures.length > 0 ? figures : null;
}
