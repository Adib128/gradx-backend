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
  const provenance =
    language === 'ar' ? 'شكل أصلي من الكتاب' : 'original textbook figure';
  const source = `${language === 'ar' ? 'المصدر' : 'Source'}: ${shortTitle(figure.referenceTitle)}, ${page} — ${provenance}`;
  return caption ? `${caption} · ${source}` : source;
}

export type StudioReferenceEntry = {
  /** Full citation as typed by the instructor, cleaned. */
  title: string;
  /** Chapters this lecture drew on. */
  chapters: string[];
};

const MAX_REFERENCES = 8;

/** References in course order with every chapter the deck drew on. */
function usedReferences(context: StudioContext | null): Array<{ title: string; chapters: string[] }> {
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
  return [...byReference.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, entry]) => ({ title: cleanCitation(entry.title), chapters: entry.chapters }))
    .filter((entry) => entry.title)
    .slice(0, MAX_REFERENCES);
}

/** The references the deck drew on, for the references list on the slide. */
export function referenceEntries(context: StudioContext | null): StudioReferenceEntry[] {
  return usedReferences(context).map((entry) => ({
    title: entry.title,
    chapters: entry.chapters.slice(0, MAX_CHAPTERS_LISTED),
  }));
}

/** One line per reference the deck drew on, with the chapters used. */
export function referenceSources(context: StudioContext | null, language: StudioLanguage): string[] {
  const chaptersLabel = language === 'ar' ? 'الفصول' : 'Chapters';
  return usedReferences(context).map((entry) => {
    if (!entry.chapters.length) return entry.title;
    const listed = entry.chapters.slice(0, MAX_CHAPTERS_LISTED).join('; ');
    const more = entry.chapters.length > MAX_CHAPTERS_LISTED ? '; …' : '';
    const line = `${entry.title} — ${chaptersLabel}: ${listed}${more}`;
    return line.length > MAX_SOURCE_CHARS ? `${line.slice(0, MAX_SOURCE_CHARS - 1).trimEnd()}…` : line;
  });
}

function figureProvenanceLine(slides: StudioSlide[], language: StudioLanguage): string | null {
  const textbook: string[] = [];
  let ai = 0;
  for (const slide of slides) {
    const image = (slide as { image?: { caption?: string } }).image;
    const caption = String(image?.caption ?? '').trim();
    if (/textbook/i.test(caption) || /شكل أصلي من الكتاب/.test(caption)) {
      const named = caption.match(/Fig(?:ure)?\.?\s*[\d.]+/i)?.[0] || caption.split('·')[0]?.trim();
      if (named && !textbook.includes(named)) textbook.push(named.slice(0, 80));
    } else if (String(slide.diagram?.mermaid ?? '').trim()) {
      ai += 1;
    }
  }
  if (!textbook.length && !ai) return null;
  if (language === 'ar') {
    const figs = textbook.length ? `الأشكال الأصلية من الكتاب: ${textbook.join('؛ ')}.` : '';
    const generated = ai ? `${ai} رسم توضيحي مولّد بالذكاء الاصطناعي.` : '';
    return [figs, generated].filter(Boolean).join(' ');
  }
  const figs = textbook.length ? `Original textbook figures: ${textbook.join('; ')}.` : '';
  const generated = ai
    ? `${ai} AI-generated educational illustration${ai === 1 ? '' : 's'}.`
    : '';
  return [figs, generated].filter(Boolean).join(' ');
}

/** Notes the visual source so AI diagrams are never implied to be textbook figures. */
export function stampVisualProvenance(slide: StudioSlide, language: StudioLanguage): StudioSlide {
  const notes = String(slide.speakerNotes ?? '').trim();
  const image = (slide as { image?: { caption?: string } }).image;
  const textbook = /textbook/i.test(String(image?.caption ?? '')) || /شكل أصلي من الكتاب/.test(String(image?.caption ?? ''));
  const mermaid = Boolean(String(slide.diagram?.mermaid ?? '').trim());
  if (textbook && !/textbook figure|شكل أصلي من الكتاب/i.test(notes)) {
    const line =
      language === 'ar'
        ? 'مصدر الشكل: شكل أصلي من الكتاب، يُعرض دون تعديل.'
        : 'Figure source: original textbook figure, shown unchanged.';
    return { ...slide, speakerNotes: notes ? `${notes} ${line}` : line };
  }
  if (mermaid && !/AI-generated|مولّد بالذكاء الاصطناعي/i.test(notes)) {
    const line =
      language === 'ar'
        ? 'مصدر الشكل: رسم توضيحي تعليمي مولّد بالذكاء الاصطناعي، وليس شكلاً من الكتاب.'
        : 'Figure source: AI-generated educational illustration, not a textbook figure.';
    return { ...slide, speakerNotes: notes ? `${notes} ${line}` : line };
  }
  return slide;
}

/**
 * Fills the REFERENCES slide with the real course references (models never
 * write citations). Always keeps a closing References slide.
 */
export function withReferencesSlide(
  slides: StudioSlide[],
  context: StudioContext | null,
  language: StudioLanguage,
): StudioSlide[] {
  const sources = referenceSources(context, language);
  const provenance = figureProvenanceLine(slides, language);
  const bullets = [
    ...(sources.length
      ? sources
      : [
          language === 'ar'
            ? 'لم تُرفَق مراجع فصل لهذه المحاضرة. أضف مراجع المقرر قبل النشر.'
            : 'No chapter bibliography was attached to this lecture. Add course references before publishing.',
        ]),
    ...(provenance ? [provenance] : []),
  ];
  const index = slides.findIndex((slide) => String(slide.type ?? '').toUpperCase() === 'REFERENCES');
  const slide: StudioSlide = {
    ...(index >= 0 ? slides[index] : {}),
    type: 'REFERENCES',
    layout: 'BULLETS',
    title: language === 'ar' ? 'المراجع' : 'References',
    subtitle: language === 'ar' ? 'المصادر ومصدر الأشكال' : 'Bibliography and figure provenance',
    bullets,
    references: referenceEntries(context),
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
        ? 'هذه هي المراجع المعتمدة في هذه المحاضرة ومصدر كل شكل. شجّع الطلاب على قراءة الفصول المذكورة قبل المحاضرة القادمة.'
        : 'These are the course references this lecture draws on, plus which figures are original vs AI-generated. Encourage students to read the listed chapters before the next session.',
  };
  if (index >= 0) return slides.map((current, i) => (i === index ? { ...slide, slideNumber: current.slideNumber } : current));
  return [...slides, { ...slide, slideNumber: slides.length + 1 }];
}
