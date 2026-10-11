import type { StudioSlide } from '../slide-studio.types';

type Column = { heading?: string; bullets?: string[] } | null | undefined;
type SlideImage = { src?: string; caption?: string; alt?: string } | null | undefined;

const MAX_BULLETS = 5;
const FALLBACK_BULLETS = 3;
const MAX_FALLBACK_WORDS = 18;
/** Types that do not decide the rendered layout (the `layout` field does). */
const NEUTRAL_TYPES = new Set([
  'CONTENT',
  'DIAGRAM',
  'AGENDA',
  'SUMMARY',
  'LEARNING_OUTCOMES',
  'NEXT_STEPS',
  'REFERENCES',
]);
const NOTE_SKIP_RE =
  /^(next|now|then|so,|let'?s|in the next|answer:|ask |pause|today|we will|we'll|remember|transition|ok)/i;

const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const upper = (value: unknown) => str(value).toUpperCase();
const wordCount = (value: string) => value.split(/\s+/).filter(Boolean).length;

/** Lower-cased, punctuation-free text used to compare blocks. */
export function textKey(value: unknown): string {
  return str(value)
    .replace(/\*\*/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Same text, or one is a near-complete copy of the other. */
export function similarText(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= 20 && long.includes(short) && short.length / long.length >= 0.6;
}

/** Drops `**` when the bold markers are unbalanced, so no raw asterisks reach the slide. */
function cleanText(value: unknown): string {
  const text = str(value);
  const markers = text.match(/\*\*/g)?.length ?? 0;
  return (markers % 2 ? text.replace(/\*\*/g, '') : text).replace(/\*\*\s*\*\*/g, '').trim();
}

function cleanItem(value: unknown): string {
  return cleanText(value)
    .replace(/^(?:[-•▪◦·]|\*(?!\*)|\d{1,2}[.)])\s+/, '')
    .trim();
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const text = cleanItem(item);
    const key = textKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function cleanColumn(column: Column): Column {
  if (!column) return null;
  return { heading: cleanText(column.heading), bullets: cleanList(column.bullets) };
}

export function isStructuralSlide(slide: StudioSlide): boolean {
  const type = upper(slide.type);
  const layout = upper(slide.layout);
  return (
    type === 'TITLE' ||
    type === 'SECTION' ||
    layout === 'TITLE_CENTER' ||
    layout === 'SECTION_DIVIDER'
  );
}

function slideImage(slide: StudioSlide): SlideImage {
  return (slide as { image?: SlideImage }).image;
}

export function hasVisual(slide: StudioSlide): boolean {
  return Boolean(str(slide.diagram?.mermaid) || str(slideImage(slide)?.src));
}

function exampleTexts(slide: StudioSlide): string[] {
  const example = slide.example;
  if (!example) return [];
  return [example.problem, ...(example.steps ?? []), example.solution].map(str).filter(Boolean);
}

function hasExample(slide: StudioSlide): boolean {
  const example = slide.example;
  return Boolean(example && ((example.steps?.length ?? 0) > 0 || (str(example.problem) && str(example.solution))));
}

function hasColumns(slide: StudioSlide): boolean {
  return Boolean(slide.leftColumn?.bullets?.length && slide.rightColumn?.bullets?.length);
}

/** The layout the slide renderers (web, PDF, PPTX) actually draw for this slide. */
export function renderedLayout(slide: StudioSlide): string {
  const type = upper(slide.type);
  const layout = upper(slide.layout);
  if (type === 'TITLE' || layout === 'TITLE_CENTER') return 'TITLE_CENTER';
  if (type === 'SECTION' || layout === 'SECTION_DIVIDER') return 'SECTION_DIVIDER';
  if (type === 'DEFINITION' || layout === 'DEFINITION') return 'DEFINITION';
  if (type === 'FORMULA' || layout === 'FORMULA_FOCUS') return 'FORMULA_FOCUS';
  if (type === 'EXAMPLE' || layout === 'EXAMPLE_STEPS') return 'EXAMPLE_STEPS';
  if (type === 'COMPARISON' || layout === 'TWO_COLUMN') return 'TWO_COLUMN';
  if (type === 'CHECKPOINT' || type === 'ACTIVITY' || layout === 'QUOTE_CALLOUT' || slide.callout) {
    return 'QUOTE_CALLOUT';
  }
  return layout || 'BULLETS';
}

/** Text blocks a student actually sees on the rendered slide (visuals excluded). */
export function visibleTexts(slide: StudioSlide): string[] {
  const layout = renderedLayout(slide);
  const texts: unknown[] = [];
  if (layout === 'TWO_COLUMN') {
    for (const column of [slide.leftColumn, slide.rightColumn]) {
      texts.push(column?.heading, ...(column?.bullets ?? []));
    }
  } else {
    texts.push(...(slide.bullets ?? []));
  }
  if (layout === 'DEFINITION' || layout === 'QUOTE_CALLOUT') texts.push(slide.callout?.text);
  texts.push(slide.formula?.latex, slide.formula?.explanation, ...exampleTexts(slide));
  texts.push(slide.code?.source, slide.code?.output);
  texts.push(...(slide.table?.headers ?? []), ...(slide.table?.rows ?? []).flat());
  return texts.map(str).filter(Boolean);
}

/** Can the rendered layout show its main element with the content the slide has? */
function layoutSatisfied(slide: StudioSlide, layout: string): boolean {
  switch (layout) {
    case 'TWO_COLUMN':
      return hasColumns(slide);
    case 'EXAMPLE_STEPS':
      return hasExample(slide);
    case 'FORMULA_FOCUS':
      return Boolean(str(slide.formula?.latex));
    case 'DEFINITION':
    case 'QUOTE_CALLOUT':
      return Boolean(str(slide.callout?.text) || slide.bullets?.length);
    default:
      return true;
  }
}

function neutralType(slide: StudioSlide): string {
  const type = upper(slide.type);
  if (NEUTRAL_TYPES.has(type)) return type;
  return hasVisual(slide) ? 'DIAGRAM' : 'CONTENT';
}

/** Type/layout pair that shows the slide's strongest content block. */
function layoutForContent(slide: StudioSlide): { type: string; layout: string } {
  if (hasColumns(slide)) return { type: 'COMPARISON', layout: 'TWO_COLUMN' };
  if (str(slide.formula?.latex)) return { type: 'FORMULA', layout: 'FORMULA_FOCUS' };
  if (hasExample(slide)) return { type: 'EXAMPLE', layout: 'EXAMPLE_STEPS' };
  if (str(slide.code?.source)) return { type: 'CODE', layout: 'BULLETS' };
  const type = upper(slide.type);
  if (str(slide.callout?.text) && (type === 'CHECKPOINT' || type === 'ACTIVITY')) {
    return { type, layout: 'QUOTE_CALLOUT' };
  }
  return { type: neutralType(slide), layout: 'BULLETS' };
}

function appendNotes(slide: StudioSlide, lines: string[]) {
  if (!lines.length) return;
  const notes = str(slide.speakerNotes);
  slide.speakerNotes = `${notes}${notes ? '\n' : ''}Also mention: ${lines.join('; ')}.`;
}

/**
 * Deterministic structural repair of one written slide: removes stray markdown
 * and duplicated text, and makes type/layout match the content so that no
 * block is hidden by the renderer. Returns the human-readable fixes applied.
 */
export function repairSlideStructure(input: StudioSlide): { slide: StudioSlide; fixes: string[] } {
  const slide: StudioSlide = { ...input };
  const fixes: string[] = [];
  slide.title = cleanText(slide.title);
  if (slide.subtitle) slide.subtitle = cleanText(slide.subtitle);
  slide.bullets = cleanList(slide.bullets);
  if (isStructuralSlide(slide)) return { slide, fixes };

  slide.leftColumn = cleanColumn(slide.leftColumn);
  slide.rightColumn = cleanColumn(slide.rightColumn);
  slide.callout = str(slide.callout?.text)
    ? { label: cleanText(slide.callout?.label), text: cleanText(slide.callout?.text) }
    : null;
  slide.formula =
    str(slide.formula?.latex) || str(slide.formula?.explanation)
      ? { latex: str(slide.formula?.latex), explanation: cleanText(slide.formula?.explanation) }
      : null;
  if (slide.example) {
    const example = {
      problem: cleanText(slide.example.problem),
      steps: cleanList(slide.example.steps),
      solution: cleanText(slide.example.solution),
    };
    slide.example = example.problem || example.steps.length || example.solution ? example : null;
  }
  if (slide.table && (!slide.table.headers?.length || !slide.table.rows?.length)) slide.table = null;

  const bulletKeys = slide.bullets.map(textKey);
  const exampleKeys = exampleTexts(slide).map(textKey);
  if (
    exampleKeys.length &&
    bulletKeys.length &&
    exampleKeys.every((key) => bulletKeys.some((bullet) => similarText(key, bullet)))
  ) {
    if (upper(slide.type) === 'EXAMPLE') slide.bullets = [];
    else slide.example = null;
    fixes.push('removed a worked example that only repeated the bullets');
  }

  const blockKeys = [
    slide.callout?.text,
    slide.formula?.explanation,
    ...exampleTexts(slide),
    ...(slide.leftColumn?.bullets ?? []),
    ...(slide.rightColumn?.bullets ?? []),
  ].map(textKey);
  const unique = slide.bullets.filter(
    (bullet) => !blockKeys.some((key) => similarText(textKey(bullet), key)),
  );
  if (unique.length < slide.bullets.length) {
    fixes.push('removed bullets that repeated another block of the slide');
    slide.bullets = unique;
  }

  if (!hasColumns(slide) && (slide.leftColumn || slide.rightColumn)) {
    const moved = [slide.leftColumn, slide.rightColumn].flatMap((column) => column?.bullets ?? []);
    if (moved.length) {
      slide.bullets = cleanList([...slide.bullets, ...moved]).slice(0, MAX_BULLETS);
      fixes.push('moved one-sided column content into bullets');
    }
    slide.leftColumn = null;
    slide.rightColumn = null;
  }

  const before = renderedLayout(slide);
  if (!layoutSatisfied(slide, before)) {
    const next = layoutForContent(slide);
    slide.type = next.type;
    slide.layout = next.layout;
    fixes.push(`switched layout ${before} → ${renderedLayout(slide)} so the content is visible`);
  }

  const layout = renderedLayout(slide);
  if (slide.callout && layout !== 'DEFINITION' && layout !== 'QUOTE_CALLOUT') {
    const line = `**${slide.callout.label || 'Note'}:** ${slide.callout.text}`;
    if (layout === 'TWO_COLUMN') appendNotes(slide, [line]);
    else slide.bullets = [...slide.bullets, line];
    slide.callout = null;
    fixes.push('moved a callout the layout could not show');
  }
  if (layout !== 'TWO_COLUMN' && hasColumns(slide)) {
    const columns = [slide.leftColumn, slide.rightColumn];
    slide.bullets = cleanList([
      ...slide.bullets,
      ...columns.flatMap((column) =>
        (column?.bullets ?? []).map((bullet) => (column?.heading ? `**${column.heading}:** ${bullet}` : bullet)),
      ),
    ]);
    slide.leftColumn = null;
    slide.rightColumn = null;
    fixes.push('merged columns the layout could not show into bullets');
  }
  if (layout === 'TWO_COLUMN' && slide.bullets.length) {
    appendNotes(slide, slide.bullets);
    slide.bullets = [];
    fixes.push('moved bullets hidden by the two-column layout into the notes');
  }
  if (layout === 'EXAMPLE_STEPS' && hasExample(slide) && hasVisual(slide) && slide.bullets.length > 1) {
    appendNotes(slide, slide.bullets.slice(1));
    slide.bullets = slide.bullets.slice(0, 1);
    fixes.push('moved extra bullets of an example slide with a visual into the notes');
  }
  const final = renderedLayout(slide);
  if (upper(slide.layout) !== final) {
    // The PPTX export trusts `layout`, the web/PDF views trust `type` first.
    if (slide.layout) fixes.push(`aligned layout ${upper(slide.layout)} with ${final}`);
    slide.layout = final;
  }
  return { slide, fixes };
}

function trimToWords(sentence: string, max: number): string {
  const words = sentence.split(/\s+/).filter(Boolean);
  if (words.length <= max) return sentence.replace(/[.;:]$/, '');
  const head = words.slice(0, max).join(' ');
  const clause = head.search(/[,;:](?=[^,;:]*$)/);
  return clause > head.length / 3 ? head.slice(0, clause) : `${head}…`;
}

/** Short, self-contained bullets taken from the instructor notes. */
function bulletsFromNotes(notes: unknown): string[] {
  const sentences = str(notes)
    .split(/\n+|(?<=[.!?؟])\s+/)
    .map(cleanItem)
    .filter((sentence) => wordCount(sentence) >= 5 && !NOTE_SKIP_RE.test(sentence));
  const fitting = sentences.filter((sentence) => wordCount(sentence) <= MAX_FALLBACK_WORDS);
  return (fitting.length >= 2 ? fitting : sentences)
    .slice(0, FALLBACK_BULLETS)
    .map((sentence) => trimToWords(sentence, MAX_FALLBACK_WORDS));
}

/**
 * Last-resort fix for a content slide that would show no text (e.g. only a
 * figure): adds bullets from the speaker notes or the figure caption.
 */
export function fillEmptySlideBody(slide: StudioSlide): string | null {
  if (isStructuralSlide(slide) || visibleTexts(slide).length) return null;
  const bullets = bulletsFromNotes(slide.speakerNotes);
  const caption = cleanText(slideImage(slide)?.caption || slide.diagram?.title);
  if (!bullets.length && caption) bullets.push(caption);
  if (!bullets.length) return null;
  slide.bullets = bullets;
  if (renderedLayout(slide) === 'TWO_COLUMN' || !layoutSatisfied(slide, renderedLayout(slide))) {
    slide.type = neutralType(slide);
    slide.layout = 'BULLETS';
  }
  return hasVisual(slide)
    ? 'added bullets explaining the figure'
    : 'added bullets to an empty slide';
}
