import { createHash } from 'node:crypto';
import { referenceChapterList } from 'src/assessment/utils/assessment-source.util';

/** Bump when chunking changes so every document is re-embedded on next sync. */
export const CHUNKER_VERSION = 1;
export const EMBED_CHUNK_CHARS = 1600;
export const EMBED_CHUNK_OVERLAP = 200;
/** ~5M characters per document; anything beyond is not indexed. */
export const MAX_CHUNKS_PER_DOCUMENT = 3000;

export type ReferenceIndexEntry = {
  documentKey: string;
  referenceIndex: number;
  title: string | null;
  fileName: string | null;
  filePath: string | null;
  chapters: { name: string; content: string }[];
  contentHash: string;
};

export type EmbeddingChunk = {
  chapterIndex: number;
  chapterName: string;
  chunkIndex: number;
  content: string;
  /** Content prefixed with the document/chapter heading to sharpen retrieval. */
  embedText: string;
  tokenCount: number;
};

const textOf = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

/**
 * One entry per `Course.references` item that has extracted text. Entries
 * sharing a file keep the first occurrence so `documentKey` stays unique.
 */
export function buildReferenceEntries(
  references: unknown,
  embeddingModel: string,
): ReferenceIndexEntry[] {
  const list = Array.isArray(references)
    ? (references as Record<string, unknown>[])
    : [];
  const entries: ReferenceIndexEntry[] = [];
  const seen = new Set<string>();

  list.forEach((reference, referenceIndex) => {
    if (!reference || typeof reference !== 'object') return;
    // Keep empty chapters so indices match the assessment chapter picker.
    const chapters = referenceChapterList(reference);
    if (!chapters.some((chapter) => chapter.content.trim())) return;

    const filePath = textOf(reference.filePath) || null;
    const documentKey = filePath ?? `index:${referenceIndex}`;
    if (seen.has(documentKey)) return;
    seen.add(documentKey);

    entries.push({
      documentKey,
      referenceIndex,
      title: textOf(reference.title) || null,
      fileName: textOf(reference.fileName) || null,
      filePath,
      chapters,
      contentHash: createHash('sha256')
        .update(JSON.stringify({ v: CHUNKER_VERSION, model: embeddingModel, chapters }))
        .digest('hex'),
    });
  });

  return entries;
}

/** Hard-split text that has no paragraph or sentence break within `size`. */
function splitLong(text: string, size: number): string[] {
  const sentences = text.split(/(?<=[.!?؟。])\s+/);
  const pieces: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > size) {
      if (current) pieces.push(current);
      current = '';
      for (let i = 0; i < sentence.length; i += size) {
        pieces.push(sentence.slice(i, i + size));
      }
      continue;
    }
    if (current && current.length + sentence.length + 1 > size) {
      pieces.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/** Paragraph-aware windows of ~`size` chars, each starting with the tail of the previous one. */
export function chunkText(
  text: string,
  size = EMBED_CHUNK_CHARS,
  overlap = EMBED_CHUNK_OVERLAP,
): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .flatMap((paragraph) =>
      paragraph.length > size ? splitLong(paragraph, size - overlap) : [paragraph],
    );

  const chunks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > size) {
      chunks.push(current);
      const tail = current.slice(-overlap);
      const boundary = tail.search(/\s/);
      current = `${boundary >= 0 ? tail.slice(boundary + 1) : tail}\n\n${paragraph}`;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

export function chunkReferenceEntry(entry: ReferenceIndexEntry): EmbeddingChunk[] {
  const chunks: EmbeddingChunk[] = [];
  const heading = entry.title || entry.fileName || 'Reference';

  entry.chapters.forEach((chapter, chapterIndex) => {
    chunkText(chapter.content).forEach((content, chunkIndex) => {
      if (chunks.length >= MAX_CHUNKS_PER_DOCUMENT) return;
      chunks.push({
        chapterIndex,
        chapterName: chapter.name,
        chunkIndex,
        content,
        embedText: `${heading} — ${chapter.name}\n\n${content}`,
        tokenCount: Math.ceil(content.length / 4),
      });
    });
  });

  return chunks;
}
