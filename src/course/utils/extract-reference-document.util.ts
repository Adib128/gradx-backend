import { inflateRawSync } from 'zlib';
import { extractPdfText } from 'src/topic-content/utils/extract-pdf-text.util';

/** Persist up to this many characters of body text per reference (MVP). */
export const MAX_REFERENCE_EXTRACTED_CHARS = 100_000;

/** Soft cap when injecting reference bodies into generation prompts. */
export const MAX_REFERENCE_PROMPT_CHARS_TOTAL = 24_000;

/** Per-reference share of the prompt budget. */
export const MAX_REFERENCE_PROMPT_CHARS_EACH = 8_000;

export const MAX_REFERENCE_UPLOAD_BYTES = 20 * 1024 * 1024;

export type ReferenceDocumentExtraction = {
  fileName: string;
  mimeType: string;
  size: number;
  extractedText: string;
  characterCount: number;
  truncated: boolean;
  extractionMethod: 'pdf' | 'docx';
};

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

  const { text, truncated } = truncateText(
    rawText,
    MAX_REFERENCE_EXTRACTED_CHARS,
  );

  return {
    fileName,
    mimeType: options.mimeType || (isPdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    size: options.buffer.length,
    extractedText: text,
    characterCount: text.length,
    truncated,
    extractionMethod,
  };
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
    const extracted = String(ref.extractedText || '').trim();
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
