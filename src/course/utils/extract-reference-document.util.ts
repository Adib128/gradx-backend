import { inflateRawSync } from 'zlib';
import { extractPdfText } from 'src/topic-content/utils/extract-pdf-text.util';

/**
 * Soft cap for stored extracted text (JSON-safe).
 * Keep full chapter bodies (titles, captions, schema labels) whenever possible —
 * do not equal-split a small budget across chapters.
 */
export const MAX_REFERENCE_EXTRACTED_CHARS = 2_000_000;

/** Soft cap when injecting reference bodies into generation prompts. */
export const MAX_REFERENCE_PROMPT_CHARS_TOTAL = 24_000;

/** Per-reference share of the prompt budget. */
export const MAX_REFERENCE_PROMPT_CHARS_EACH = 8_000;

export const MAX_REFERENCE_UPLOAD_BYTES = 20 * 1024 * 1024;

export type ReferenceChapter = {
  name: string;
  content: string;
};

export type ReferenceDocumentExtraction = {
  fileName: string;
  mimeType: string;
  size: number;
  extractedText: string | null;
  chapters: ReferenceChapter[];
  characterCount: number;
  truncated: boolean;
  extractionMethod: 'pdf' | 'docx';
};

/** Prefer real textbook chapter headings; avoid TOC / ALL-CAPS noise. */
const CHAPTER_HEADER_PATTERN =
  /^(?:chapter|ch\.|part|unit)\s*\d+(?:\s*[:\.\-–—]?\s*.*)?$/i;

/** Absolute floor so tiny TOC fragments never become chapters. */
const MIN_CHAPTER_CONTENT_CHARS = 800;

/** Relative floor vs median chapter size (drops leftover TOC stubs). */
const MIN_CHAPTER_CONTENT_RATIO = 0.12;

function normalizeChapterName(rawHeader: string, fallbackIndex: number): string {
  const trimmed = rawHeader.trim().replace(/\s+/g, ' ');
  if (!trimmed) return `Chapter ${fallbackIndex}`;

  const chapterMatch = trimmed.match(
    /^(chapter\s+\d+|ch\.\s*\d+|part\s+\d+|unit\s+\d+)\s*[:\.\-–—]?\s*(.*)$/i,
  );
  if (chapterMatch) {
    const rawPrefix = chapterMatch[1];
    const suffix = chapterMatch[2]?.trim();
    // Only expand "Ch. N" — never rewrite "Chapter" (avoids "Chapter apter").
    const prefix = /^ch\.\s*\d/i.test(rawPrefix)
      ? rawPrefix.replace(/^ch\.\s*/i, 'Chapter ')
      : rawPrefix.replace(/\s+/g, ' ');
    const titleCasePrefix = prefix
      .replace(/^chapter\b/i, 'Chapter')
      .replace(/^part\b/i, 'Part')
      .replace(/^unit\b/i, 'Unit');
    return suffix ? `${titleCasePrefix}: ${suffix}` : titleCasePrefix;
  }

  return trimmed;
}

function extractChapterNumber(header: string): number | null {
  const match = header.trim().match(/^(?:chapter|ch\.|part|unit)\s*(\d+)/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function chapterTitleScore(header: string): number {
  const match = header.trim().match(
    /^(?:chapter|ch\.|part|unit)\s*\d+\s*[:\.\-–—]?\s*(.*)$/i,
  );
  const suffix = match?.[1]?.trim() || '';
  // Prefer "Chapter 1: Introduction" over bare "Chapter 1".
  return suffix.length;
}

function isPageFooterChapterLine(line: string): boolean {
  const trimmed = line.trim();
  // Running headers like "4 Chapter 1 Introduction" or "56 Chapter 2 Operating-System Structures"
  return /^\d+\s+Chapter\s+\d+/i.test(trimmed);
}

function looksLikeBodyChapterReference(header: string): boolean {
  const suffix = header
    .trim()
    .replace(/^(?:chapter|ch\.)\s*\d+\s*[:\.\-–—]?\s*/i, '')
    .trim();
  if (!suffix) return false;
  if (/^[a-z(,]/.test(suffix)) return true;
  if (/^(discussed|examples|see|as we|in chapter|also|which|that|involves|provides|presents|replication)\b/i.test(suffix)) {
    return true;
  }
  if (suffix.length > 90) return true;
  if (/[.!?]$/.test(suffix)) return true;
  return false;
}

function isChapterHeaderLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 160 || trimmed.endsWith('.')) return false;
  if (isPageFooterChapterLine(trimmed)) return false;
  // Ignore TOC-style dotted leaders: "Chapter 1 .......... 12"
  if (/\.{3,}|…/.test(trimmed)) return false;
  if (/\d+\s*$/.test(trimmed) && /chapter\s+\d+/i.test(trimmed) && trimmed.length < 40) {
    // Short "Chapter N   12" TOC rows
    if (/\s{2,}\d+\s*$/.test(trimmed)) return false;
  }
  // Trailing page number without leaders: "Chapter 1 Introduction 17"
  if (
    /^(?:chapter|ch\.|part|unit)\s*\d+/i.test(trimmed) &&
    /\s\d{1,4}$/.test(trimmed) &&
    trimmed.length < 80
  ) {
    return false;
  }
  if (!CHAPTER_HEADER_PATTERN.test(trimmed)) return false;
  if (looksLikeBodyChapterReference(trimmed)) return false;
  return true;
}

type WileyChapterMarker = {
  lineIndex: number;
  chapterNumber: number;
  inlineTitle: string;
};

/** Wiley PDFs often use "1CHAPTER", "10 CHAPTER", or "2CHAPTER Operating -" markers. */
function parseWileyChapterMarkerLine(line: string): Omit<WileyChapterMarker, 'lineIndex'> | null {
  const trimmed = line.trim();
  if (!trimmed || isPageFooterChapterLine(trimmed)) return null;

  const glued = trimmed.match(/^(\d{1,2})CHAPTER(?:\s+(.*))?$/i);
  if (glued) {
    return {
      chapterNumber: Number(glued[1]),
      inlineTitle: glued[2]?.trim() || '',
    };
  }

  const spaced = trimmed.match(/^(\d{1,2})\s+CHAPTER(?:\s+(.*))?$/i);
  if (spaced) {
    return {
      chapterNumber: Number(spaced[1]),
      inlineTitle: spaced[2]?.trim() || '',
    };
  }

  return null;
}

function looksLikeBodyParagraphLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.length > 48) return true;
  if (/^(An?|The|In|Early|CPU|By|Now|Some|Most|For|When|If|As|This|These|Operating|Virtual|File|Process|Updated|A)\s/i.test(trimmed)) {
    return true;
  }
  const wordCount = trimmed.split(/\s+/).length;
  return wordCount >= 8;
}

function collectWileyTitleLines(
  lines: string[],
  startIndex: number,
): { titleParts: string[]; bodyStartIndex: number } {
  const titleParts: string[] = [];
  let index = startIndex;

  while (index < lines.length && titleParts.length < 3) {
    const trimmed = lines[index].trim();
    index += 1;
    if (!trimmed) continue;
    if (parseWileyChapterMarkerLine(trimmed)) {
      index -= 1;
      break;
    }
    if (trimmed.startsWith('--- Page ')) continue;
    if (titleParts.length > 0 && looksLikeBodyParagraphLine(trimmed)) break;
    if (trimmed.length > 40) break;
    if (titleParts.length > 0 && /[.!?]$/.test(trimmed)) break;
    titleParts.push(trimmed);
  }

  return { titleParts, bodyStartIndex: index };
}

function formatWileyChapterName(
  chapterNumber: number,
  titleParts: string[],
): string {
  const title = titleParts
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/\s-\s/g, '-')
    .trim();
  return title ? `Chapter ${chapterNumber}: ${title}` : `Chapter ${chapterNumber}`;
}

function splitByWileyChapterMarkers(text: string): RawSection[] {
  const lines = text.split('\n');
  const markers: WileyChapterMarker[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const parsed = parseWileyChapterMarkerLine(lines[lineIndex]);
    if (!parsed) continue;
    markers.push({ lineIndex, ...parsed });
  }

  if (markers.length < 2) return [];

  const sections: RawSection[] = [];

  for (let markerIndex = 0; markerIndex < markers.length; markerIndex++) {
    const marker = markers[markerIndex];
    const nextMarker = markers[markerIndex + 1];
    const titleParts: string[] = [];
    if (marker.inlineTitle) titleParts.push(marker.inlineTitle);

    const { titleParts: extraTitleParts, bodyStartIndex } = collectWileyTitleLines(
      lines,
      marker.lineIndex + 1,
    );
    titleParts.push(...extraTitleParts);

    const bodyEnd = nextMarker?.lineIndex ?? lines.length;
    const bodyLines = lines.slice(bodyStartIndex, bodyEnd);

    sections.push({
      header: formatWileyChapterName(marker.chapterNumber, titleParts),
      lines: bodyLines,
      chapterNumber: marker.chapterNumber,
    });
  }

  return sections;
}

function sectionsToChapters(sections: RawSection[]): ReferenceChapter[] {
  const merged = mergeDuplicateChapterSections(sections);
  const meaningful = filterMeaningfulSections(merged);
  if (meaningful.length === 0) return [];

  return meaningful.map((section, index) => ({
    name: normalizeChapterName(section.header, index + 1),
    content: sanitizeTextForJsonStorage(section.lines.join('\n')),
  }));
}

function splitByStandardChapterHeaders(text: string): RawSection[] {
  const lines = text.split('\n');
  const sections: RawSection[] = [];
  let currentHeader = '';
  let currentLines: string[] = [];

  const pushSection = () => {
    const body = currentLines.join('\n').trim();
    if (!body && !currentHeader) return;
    const header = currentHeader || `Chapter ${sections.length + 1}`;
    sections.push({
      header,
      lines: body ? [...currentLines] : [],
      chapterNumber: extractChapterNumber(header),
    });
    currentLines = [];
  };

  for (const line of lines) {
    if (isChapterHeaderLine(line)) {
      const trimmed = line.trim();
      if (currentLines.length > 0 || currentHeader) {
        pushSection();
      }
      currentHeader = trimmed;
      continue;
    }
    currentLines.push(line);
  }

  pushSection();
  return sections;
}

type RawSection = {
  header: string;
  lines: string[];
  chapterNumber: number | null;
};

/**
 * Merge duplicate chapter numbers (e.g. "Chapter 1" then "Chapter 1: Introduction")
 * into a single section, keeping the more descriptive title.
 */
function mergeDuplicateChapterSections(sections: RawSection[]): RawSection[] {
  const merged: RawSection[] = [];

  for (const section of sections) {
    const previous = merged[merged.length - 1];
    const sameNumber =
      previous &&
      section.chapterNumber != null &&
      previous.chapterNumber != null &&
      previous.chapterNumber === section.chapterNumber;

    if (!sameNumber) {
      merged.push({
        header: section.header,
        lines: [...section.lines],
        chapterNumber: section.chapterNumber,
      });
      continue;
    }

    // Prefer the titled header ("Chapter 1: Introduction" over "Chapter 1").
    if (chapterTitleScore(section.header) > chapterTitleScore(previous.header)) {
      previous.header = section.header;
    }
    previous.lines.push(...section.lines);
  }

  return merged;
}

function filterMeaningfulSections(sections: RawSection[]): RawSection[] {
  const withBody = sections
    .map((section) => ({
      ...section,
      bodyLength: section.lines.join('\n').trim().length,
    }))
    .filter((section) => section.bodyLength >= MIN_CHAPTER_CONTENT_CHARS);

  if (withBody.length <= 1) return withBody;

  const lengths = withBody.map((section) => section.bodyLength).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)] || 0;
  const relativeFloor = Math.max(
    MIN_CHAPTER_CONTENT_CHARS,
    Math.floor(median * MIN_CHAPTER_CONTENT_RATIO),
  );

  const filtered = withBody.filter((section) => section.bodyLength >= relativeFloor);
  return filtered.length > 0 ? filtered : withBody;
}

export function splitReferenceIntoChapters(text: string): ReferenceChapter[] {
  const normalized = sanitizeTextForJsonStorage(text);
  if (!normalized) return [];

  const wileySections = splitByWileyChapterMarkers(normalized);
  const wileyChapters = sectionsToChapters(wileySections);
  if (wileyChapters.length >= 2) {
    return wileyChapters;
  }

  const standardSections = splitByStandardChapterHeaders(normalized);
  const standardChapters = sectionsToChapters(standardSections);
  if (standardChapters.length >= 2) {
    return standardChapters;
  }

  if (standardChapters.length === 1) {
    return standardChapters;
  }

  return [
    {
      name: 'Full document',
      content: normalized,
    },
  ];
}

function truncateChaptersForStorage(
  chapters: ReferenceChapter[],
  maxChars: number,
): { chapters: ReferenceChapter[]; truncated: boolean } {
  const sanitized = chapters
    .map((chapter) => ({
      name: chapter.name,
      content: sanitizeTextForJsonStorage(chapter.content),
    }))
    .filter((chapter) => chapter.content.length > 0);

  if (sanitized.length === 0) {
    return { chapters: [], truncated: false };
  }

  const totalContent = sanitized.reduce(
    (sum, chapter) => sum + chapter.content.length,
    0,
  );
  if (totalContent <= maxChars) {
    return { chapters: sanitized, truncated: false };
  }

  // Prefer complete chapters (headings, figure captions, schema labels intact).
  // Only drop or trim from the end once the budget is exhausted.
  const kept: ReferenceChapter[] = [];
  let used = 0;
  let truncated = false;

  for (const chapter of sanitized) {
    const remaining = maxChars - used;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (chapter.content.length <= remaining) {
      kept.push(chapter);
      used += chapter.content.length;
      continue;
    }
    truncated = true;
    kept.push({
      name: chapter.name,
      content: `${chapter.content.slice(0, Math.max(0, remaining - 40))}\n\n[…truncated for storage limit…]`,
    });
    break;
  }

  return { chapters: kept, truncated };
}

/** Strip chars PostgreSQL JSON/JSONB rejects (null bytes, lone surrogates). */
export function sanitizeTextForJsonStorage(text: string): string {
  return text
    .replace(/\u0000/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .trim();
}

function truncateText(text: string, maxChars: number): {
  text: string;
  truncated: boolean;
} {
  const normalized = sanitizeTextForJsonStorage(text);
  if (normalized.length <= maxChars) {
    return { text: normalized, truncated: false };
  }
  return {
    text: `${normalized.slice(0, maxChars)}\n\n[…truncated for storage limit…]`,
    truncated: true,
  };
}

function extractTextFromWordXml(xml: string): string {
  return xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  for (let offset = buffer.length - 22; offset >= 0; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  return -1;
}

function readZipEntryData(
  buffer: Buffer,
  localHeaderOffset: number,
  compressedSize: number,
  compressionMethod: number,
): Buffer {
  if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
    throw new Error('INVALID_DOCX');
  }

  const fileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const extraFieldLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataOffset = localHeaderOffset + 30 + fileNameLength + extraFieldLength;
  const compressedData = buffer.subarray(
    dataOffset,
    dataOffset + compressedSize,
  );

  if (compressionMethod === 0) return compressedData;
  if (compressionMethod === 8) return inflateRawSync(compressedData);
  throw new Error('UNSUPPORTED_DOCX_COMPRESSION');
}

function readZipTextFile(buffer: Buffer, filename: string): string {
  const endOfCentralDirectoryOffset = findEndOfCentralDirectory(buffer);
  if (endOfCentralDirectoryOffset < 0) {
    throw new Error('INVALID_DOCX');
  }

  const totalEntries = buffer.readUInt16LE(endOfCentralDirectoryOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(
    endOfCentralDirectoryOffset + 16,
  );

  let cursor = centralDirectoryOffset;

  for (let index = 0; index < totalEntries; index++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      break;
    }

    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraFieldLength = buffer.readUInt16LE(cursor + 30);
    const fileCommentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const entryName = buffer
      .subarray(cursor + 46, cursor + 46 + fileNameLength)
      .toString('utf8');

    if (entryName === filename) {
      return readZipEntryData(
        buffer,
        localHeaderOffset,
        compressedSize,
        compressionMethod,
      ).toString('utf8');
    }

    cursor += 46 + fileNameLength + extraFieldLength + fileCommentLength;
  }

  throw new Error('INVALID_DOCX');
}

export async function extractDocxPlainText(buffer: Buffer): Promise<string> {
  const documentXml = readZipTextFile(buffer, 'word/document.xml');
  return extractTextFromWordXml(documentXml);
}

export async function extractReferenceDocumentText(options: {
  buffer: Buffer;
  fileName: string;
  mimeType?: string;
}): Promise<ReferenceDocumentExtraction> {
  const fileName = options.fileName || 'document';
  const mimeType = (options.mimeType || '').toLowerCase();
  const lowerName = fileName.toLowerCase();

  const isPdf =
    mimeType.includes('pdf') || lowerName.endsWith('.pdf');
  const isDocx =
    mimeType.includes(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ) ||
    mimeType.includes('application/msword') ||
    lowerName.endsWith('.docx');

  let rawText = '';
  let extractionMethod: 'pdf' | 'docx';

  if (isPdf) {
    rawText = await extractPdfText(options.buffer);
    extractionMethod = 'pdf';
  } else if (isDocx) {
    rawText = await extractDocxPlainText(options.buffer);
    extractionMethod = 'docx';
  } else {
    throw new Error('UNSUPPORTED_FILE');
  }

  if (!rawText.trim()) {
    throw new Error('EMPTY_DOCUMENT');
  }

  const rawChapters = splitReferenceIntoChapters(rawText);
  const { chapters, truncated } = truncateChaptersForStorage(
    rawChapters,
    MAX_REFERENCE_EXTRACTED_CHARS,
  );
  const characterCount = chapters.reduce(
    (total, chapter) => total + chapter.content.length,
    0,
  );

  return {
    fileName,
    mimeType: options.mimeType || (isPdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    size: options.buffer.length,
    extractedText: null,
    chapters,
    characterCount,
    truncated,
    extractionMethod,
  };
}

/** Join stored chapters into prompt-ready plain text. */
export function joinReferenceChapters(
  chapters: ReferenceChapter[] | null | undefined,
): string {
  if (!Array.isArray(chapters) || chapters.length === 0) return '';
  return chapters
    .map((chapter) => `${chapter.name}\n\n${chapter.content}`.trim())
    .filter(Boolean)
    .join('\n\n---\n\n');
}

export function resolveReferenceBodyText(reference: {
  extractedText?: string | null;
  chapters?: ReferenceChapter[] | null;
  /** @deprecated Prefer chapterIndices for multi-select. */
  chapterIndex?: number | null;
  /**
   * Explicit chapter picks. When provided as an array (even empty), only those
   * chapters are used — empty means none. When omitted/null, all chapters
   * (legacy / full document) are used.
   */
  chapterIndices?: number[] | null;
}): string {
  const chapters = Array.isArray(reference.chapters) ? reference.chapters : [];

  if (Array.isArray(reference.chapterIndices)) {
    const indices = [
      ...new Set(
        reference.chapterIndices.filter(
          (index) =>
            Number.isInteger(index) && index >= 0 && index < chapters.length,
        ),
      ),
    ].sort((a, b) => a - b);

    if (indices.length === 0) return '';

    return indices
      .map((index) => {
        const chapter = chapters[index];
        return `${chapter.name}\n\n${chapter.content}`.trim();
      })
      .filter(Boolean)
      .join('\n\n---\n\n');
  }

  if (
    reference.chapterIndex != null &&
    Number.isInteger(reference.chapterIndex) &&
    chapters[reference.chapterIndex]
  ) {
    const chapter = chapters[reference.chapterIndex];
    return `${chapter.name}\n\n${chapter.content}`.trim();
  }

  const joined = joinReferenceChapters(chapters);
  if (joined) return joined;

  return String(reference.extractedText || '').trim();
}

/**
 * Format bibliographic refs + optional extracted bodies for AI prompts.
 * Bodies are truncated per-ref and overall to protect context limits.
 */
export function formatReferencesWithContentForPrompt(
  references: Array<{
    type?: string | null;
    title?: string | null;
    authors?: string | null;
    publisher?: string | null;
    extractedText?: string | null;
    chapters?: ReferenceChapter[] | null;
    fileName?: string | null;
  }> = [],
): string {
  if (!references.length) {
    return '- (none provided)';
  }

  let remaining = MAX_REFERENCE_PROMPT_CHARS_TOTAL;
  const blocks: string[] = [];

  for (let index = 0; index < references.length; index++) {
    const ref = references[index];
    const citation = [
      ref.authors?.trim(),
      ref.title?.trim(),
      ref.publisher?.trim(),
      ref.type ? `(${ref.type})` : null,
    ]
      .filter(Boolean)
      .join(' — ');

    let body = '';
    const extracted = resolveReferenceBodyText(ref);
    if (extracted && remaining > 400) {
      const allotment = Math.min(
        MAX_REFERENCE_PROMPT_CHARS_EACH,
        remaining,
        extracted.length,
      );
      body = extracted.slice(0, allotment);
      remaining -= body.length;
      if (allotment < extracted.length) {
        body += '\n[…truncated for prompt budget…]';
      }
    }

    const header = `${index + 1}. ${citation || 'Untitled reference'}${
      ref.fileName ? ` [file: ${ref.fileName}]` : ''
    }`;

    if (body) {
      blocks.push(
        `${header}\nSource excerpts (use for accurate, professional content; cite this source when used):\n"""\n${body}\n"""`,
      );
    } else {
      blocks.push(`${header}\n(no attached document text)`);
    }
  }

  return blocks.join('\n\n');
}
