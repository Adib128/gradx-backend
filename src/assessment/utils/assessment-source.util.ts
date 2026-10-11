import { readFile } from 'fs/promises';
import { join } from 'path';
import { readZipTextEntries } from 'src/course/utils/extract-reference-document.util';
import type { ReferenceChapterSelection } from '../dto/generate-assessment.dto';

/** Each generated question sees one window of the source so questions spread across it. */
export const SOURCE_CHUNK_CHARS = 6000;
export const MAX_SOURCE_CHARS = 150_000;

const SLIDE_TEXT_SKIP_KEYS = new Set([
  'id',
  'type',
  'layout',
  'theme',
  'color',
  'colors',
  'palette',
  'image',
  'images',
  'url',
  'src',
  'icon',
  'mermaid',
  'diagram',
  'titleFontSize',
  'bodyFontSize',
  'cloCode',
  'bloomLevel',
]);

const decodeXml = (value: string) =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&amp;/g, '&');

const stripHtml = (value: string) =>
  value
    .replace(/<[^>]+>/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Plain paragraphs of one DrawingML part (slide or notes XML). */
function drawingParagraphs(xml: string): string[] {
  return xml
    .split(/<\/a:p>/)
    .map((paragraph) =>
      decodeXml(
        Array.from(paragraph.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g))
          .map((match) => match[1])
          .join(''),
      ).trim(),
    )
    .filter(Boolean);
}

const slideNumberOf = (name: string) => Number(/(\d+)\.xml(?:\.rels)?$/.exec(name)?.[1] ?? 0);

/** Text per slide (with speaker notes) from a .pptx, in presentation order. */
export function extractPptxSlidesText(buffer: Buffer): string[] {
  const entries = readZipTextEntries(
    buffer,
    (name) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(name) ||
      /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name) ||
      /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name) ||
      name === 'ppt/presentation.xml' ||
      name === 'ppt/_rels/presentation.xml.rels',
  );
  const byName = new Map(entries.map((entry) => [entry.name, entry.text]));

  const presentation = byName.get('ppt/presentation.xml') ?? '';
  const presentationRels = byName.get('ppt/_rels/presentation.xml.rels') ?? '';
  const relTargets = new Map(
    Array.from(
      presentationRels.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g),
    ).map((match) => [match[1], match[2]]),
  );
  const ordered = Array.from(
    presentation.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g),
  )
    .map((match) => relTargets.get(match[1]))
    .filter((target): target is string => Boolean(target))
    .map((target) => `ppt/${target.replace(/^\/?(ppt\/)?/, '')}`);

  const slideNames =
    ordered.length > 0
      ? ordered.filter((name) => byName.has(name))
      : [...byName.keys()]
          .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
          .sort((a, b) => slideNumberOf(a) - slideNumberOf(b));

  return slideNames
    .map((slideName) => {
      const lines = drawingParagraphs(byName.get(slideName) ?? '');
      const rels = byName.get(slideName.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels') ?? '';
      const notesTarget = /Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/.exec(rels)?.[1];
      const notes = notesTarget
        ? drawingParagraphs(byName.get(`ppt/notesSlides/${notesTarget}`) ?? '').filter(
            (line) => !/^\d+$/.test(line),
          )
        : [];
      return [...lines, ...(notes.length ? [`Notes: ${notes.join(' ')}`] : [])].join('\n');
    })
    .filter((text) => text.trim().length > 0);
}

export function extractGeneratedSlidesArray(content: unknown): unknown[] {
  if (!content) return [];
  let payload: unknown =
    typeof content === 'object' && content !== null && 'content' in content
      ? (content as Record<string, unknown>).content
      : content;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return [];
    }
  }
  const data = (payload ?? {}) as Record<string, any>;
  const slides =
    data.slides ?? data.presentation?.slides ?? data.slideDeck?.slides ?? data.data?.slides;
  return Array.isArray(slides) ? slides : [];
}

/** Text per slide from AI-generated slide JSON. */
export function generatedSlidesText(content: unknown): string[] {
  const collect = (value: unknown, out: string[], key?: string) => {
    if (key && SLIDE_TEXT_SKIP_KEYS.has(key)) return;
    if (typeof value === 'string') {
      const text = stripHtml(value);
      if (text && !/^https?:\/\//.test(text)) out.push(text);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collect(item, out));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) collect(child, out, childKey);
    }
  };

  return extractGeneratedSlidesArray(content)
    .map((slide) => {
      const lines: string[] = [];
      collect(slide, lines);
      return Array.from(new Set(lines)).join('\n');
    })
    .filter(Boolean);
}

export type SlidesFileMeta = { fileName: string; filePath: string };

/** Uploaded or Skywork decks are stored as a file on disk instead of slide JSON. */
export function slidesFileMeta(content: unknown): SlidesFileMeta | null {
  if (!content || typeof content !== 'object') return null;
  const data = content as Record<string, unknown>;
  const candidates = [data, data.metadata, data.content].filter(
    (value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object',
  );
  for (const meta of candidates) {
    if (
      (meta.source === 'upload' || meta.source === 'skywork') &&
      typeof meta.filePath === 'string' &&
      typeof meta.fileName === 'string'
    ) {
      return { fileName: meta.fileName, filePath: meta.filePath };
    }
  }
  return null;
}

/** Slide text for a topic's SLIDES content, whether generated JSON or an uploaded .pptx. */
export async function topicSlidesText(content: unknown): Promise<string[]> {
  const fileMeta = slidesFileMeta(content);
  if (fileMeta) {
    if (!/\.pptx$/i.test(fileMeta.fileName) && !/\.pptx$/i.test(fileMeta.filePath)) return [];
    try {
      const buffer = await readFile(join(process.cwd(), fileMeta.filePath));
      return extractPptxSlidesText(buffer);
    } catch {
      return [];
    }
  }
  return generatedSlidesText(content);
}

type ReferenceLike = {
  title?: unknown;
  authors?: unknown;
  chapters?: Array<{ name?: unknown; content?: unknown }> | null;
  extractedText?: unknown;
};

const textOf = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** References without chapter splits expose their whole text as chapter 0. */
export function referenceChapterList(reference: ReferenceLike) {
  const chapters = Array.isArray(reference.chapters) ? reference.chapters : [];
  if (chapters.length > 0) {
    return chapters.map((chapter, index) => ({
      name: textOf(chapter?.name) || `Chapter ${index + 1}`,
      content: textOf(chapter?.content),
    }));
  }
  const body = textOf(reference.extractedText);
  return body ? [{ name: 'Full document', content: body }] : [];
}

export function referenceChaptersText(
  references: unknown,
  selections: ReferenceChapterSelection[],
): { sections: string[]; labels: string[] } {
  const list = Array.isArray(references) ? (references as ReferenceLike[]) : [];
  const sections: string[] = [];
  const labels: string[] = [];
  for (const selection of selections) {
    const reference = list[selection.referenceIndex];
    if (!reference) continue;
    const chapters = referenceChapterList(reference);
    const title = textOf(reference.title) || `Reference ${selection.referenceIndex + 1}`;
    for (const chapterIndex of Array.from(new Set(selection.chapterIndices))) {
      const chapter = chapters[chapterIndex];
      if (!chapter || !chapter.content.trim()) continue;
      labels.push(`${title} — ${chapter.name}`);
      sections.push(`### ${title} — ${chapter.name}\n${chapter.content.trim()}`);
    }
  }
  return { sections, labels };
}

export function courseSpecificationText(input: {
  course: {
    title?: string | null;
    code?: string | null;
    description?: string | null;
    mainObjective?: string | null;
    level?: string | null;
    references?: unknown;
  };
  topicTitle: string;
  courseTopicTitles: string[];
}): string {
  const { course, topicTitle, courseTopicTitles } = input;
  const bibliography = (Array.isArray(course.references) ? (course.references as ReferenceLike[]) : [])
    .map((reference) =>
      [reference.title, reference.authors].map(textOf).filter(Boolean).join(' — '),
    )
    .filter(Boolean);
  return [
    `Course: ${course.title || ''}${course.code ? ` (${course.code})` : ''}`,
    course.level ? `Level: ${course.level}` : '',
    course.description ? `Course description: ${course.description}` : '',
    course.mainObjective ? `Main objective: ${course.mainObjective}` : '',
    `Topic to assess: ${topicTitle}`,
    courseTopicTitles.length
      ? `Course topics (for scope; assess only the target topic): ${courseTopicTitles.join('; ')}`
      : '',
    bibliography.length ? `Course references: ${bibliography.join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Split source text on paragraph boundaries into prompt-sized windows. */
export function chunkSourceText(parts: string[], size = SOURCE_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = '';
  let total = 0;
  for (const part of parts.flatMap((text) => text.split(/\n{2,}/))) {
    const paragraph = part.trim();
    if (!paragraph) continue;
    if (total >= MAX_SOURCE_CHARS) break;
    const slices =
      paragraph.length > size
        ? Array.from({ length: Math.ceil(paragraph.length / size) }, (_, index) =>
            paragraph.slice(index * size, (index + 1) * size),
          )
        : [paragraph];
    for (const slice of slices) {
      if (current && current.length + slice.length + 2 > size) {
        chunks.push(current);
        current = '';
      }
      current = current ? `${current}\n\n${slice}` : slice;
      total += slice.length;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
