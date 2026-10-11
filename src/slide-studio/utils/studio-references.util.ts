import type { StudioContext, StudioFigure, StudioLanguage, StudioSlide } from '../slide-studio.types';

const MAX_CHAPTERS_LISTED = 4;
const MAX_SOURCE_CHARS = 240;

/** Reference titles are stored as typed by the instructor: curly quotes, line breaks, trailing commas. */
export function cleanCitation(title: string): string {
  return title
    .replace(/[“”„"«»]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/[,;\s]+$/, '')
    .trim();
}

/** "Operating System Concepts" out of a full citation line. */
function shortTitle(title: string): string {
  const clean = cleanCitation(title);
  return clean.split(',')[0]?.trim() || clean;
}

/** Figure captions name their textbook and page, as a professor's slide would. */
export function figureCaption(figure: StudioFigure, language: StudioLanguage): string {
  const caption = figure.caption.replace(/\s+/g, ' ').trim();
  const page = language === 'ar' ? `ص. ${figure.pageNumber}` : `p. ${figure.pageNumber}`;
  const source = `${language === 'ar' ? 'المصدر' : 'Source'}: ${shortTitle(figure.referenceTitle)}, ${page}`;
  return caption ? `${caption} · ${source}` : source;
}

/** One line per reference the deck drew on, with the chapters used. */
export function referenceSources(context: StudioContext | null, language: StudioLanguage): string[] {
  if (!context || context.mode === 'none') return [];
  const byReference = new Map<number, { title: string; chapters: string[] }>();
  const add = (referenceIndex: number, title: string, chapter: string | null) => {
    const entry = byReference.get(referenceIndex) ?? { title, chapters: [] };
    if (chapter && !entry.chapters.includes(chapter)) entry.chapters.push(chapter);
    byReference.set(referenceIndex, entry);
  };
  for (const chapter of context.chapters) {
    add(chapter.referenceIndex, chapter.referenceTitle, chapter.chapterName?.trim() || null);
  }
  for (const excerpt of context.excerpts) {
    add(excerpt.referenceIndex, excerpt.referenceTitle, excerpt.chapterName?.trim() || null);
  }
  const chaptersLabel = language === 'ar' ? 'الفصول' : 'Chapters';
  return [...byReference.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, entry]) => {
      const title = cleanCitation(entry.title);
      if (!entry.chapters.length) return title;
      const listed = entry.chapters.slice(0, MAX_CHAPTERS_LISTED).join('; ');
      const more = entry.chapters.length > MAX_CHAPTERS_LISTED ? '; …' : '';
      const line = `${title} — ${chaptersLabel}: ${listed}${more}`;
      return line.length > MAX_SOURCE_CHARS ? `${line.slice(0, MAX_SOURCE_CHARS - 1).trimEnd()}…` : line;
    })
    .filter(Boolean);
}

/**
 * Fills the REFERENCES slide with the real course references (models never
 * write citations), appending one when the deck used references but has none.
 */
export function withReferencesSlide(
  slides: StudioSlide[],
  context: StudioContext | null,
  language: StudioLanguage,
): StudioSlide[] {
  const sources = referenceSources(context, language);
  const index = slides.findIndex((slide) => String(slide.type ?? '').toUpperCase() === 'REFERENCES');
  if (!sources.length) {
    return index >= 0 && !slides[index].bullets?.length ? slides.filter((_, i) => i !== index) : slides;
  }
  const slide: StudioSlide = {
    ...(index >= 0 ? slides[index] : {}),
    type: 'REFERENCES',
    layout: 'BULLETS',
    title: language === 'ar' ? 'المراجع' : 'References',
    subtitle: null,
    bullets: sources,
    leftColumn: null,
    rightColumn: null,
    callout: null,
    example: null,
    formula: null,
    table: null,
    diagram: null,
    image: null,
    cloCode: null,
    bloomLevel: null,
    speakerNotes:
      language === 'ar'
        ? 'هذه هي المراجع المعتمدة في هذه المحاضرة. شجّع الطلاب على قراءة الفصول المذكورة قبل المحاضرة القادمة، ففيها الشرح الكامل والأمثلة الإضافية.'
        : 'These are the course references this lecture draws on. Encourage students to read the listed chapters before the next session: they contain the full explanations, extra examples and practice exercises.',
  };
  if (index >= 0) return slides.map((current, i) => (i === index ? { ...slide, slideNumber: current.slideNumber } : current));
  return [...slides, { ...slide, slideNumber: slides.length + 1 }];
}
