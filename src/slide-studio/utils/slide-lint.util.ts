import type { StudioLanguage, StudioQaFinding, StudioSlide } from '../slide-studio.types';
import { disciplineFindings, type DisciplineProfile } from './discipline-profile.util';
import { estimateSlideFit, longestCodeLine } from './slide-fit.util';
import { hasVisual, renderedLayout, similarText, textKey, visibleTexts } from './slide-repair.util';

/** Bodies `normalizeOneSlide` invents when the model returned an empty slide. */
const PLACEHOLDER_RE =
  /^(core idea:|state assumptions and when the method applies|note limitations and common pitfalls|discuss: what is the key idea behind|define and interpret:|explain the meaning and use of|worked example:|state known values and objective)/i;
const ARABIC_RE = /[\u0600-\u06FF]/;
const TASK_RE =
  /^(write|explain|describe|compute|calculate|find|identify|list|compare|predict|name|draw|solve|give|show|determine|classify|match|order|sketch|design|justify|estimate|trace|evaluate|discuss|decide|choose|select|complete|apply|convert|rewrite)\b/i;
/** Share of the text area above which a slide looks crammed / below which it looks empty. */
const TIGHT_FILL = 0.92;
const SPARSE_FILL = 0.18;
/** Diagram labels below this (on a 1100 px stage with 16 px body text) are unreadable when projected. */
const MIN_DIAGRAM_LABEL_PX = 10;
const SMALL_DIAGRAM_LABEL_PX = 12;
const MAX_VISUAL_BULLETS = 3;
const MAX_EXAMPLE_STEPS = 4;
const MAX_MERMAID_EDGES = 12;
const MIN_REPEAT_CHARS = 24;
const MAX_TABLE_COLUMNS = 4;
const MAX_TABLE_ROWS = 6;
const MAX_TITLE_WORDS = 12;
/** A content headline this short is a topic label ("Pipes"), not a claim. */
const MAX_LABEL_TITLE_WORDS = 2;
const MIN_NOTES_CHARS = 60;
/** Text-only slides in a row before the deck reads like a wall of bullets. */
const MAX_TEXT_RUN = 2;
/** A SUMMARY this close to the CONCLUSION recaps the same lecture twice. */
const RECAP_DISTANCE = 2;
const FILLER_RE =
  /\b(it is (very )?important to (note|remember|understand)|in this slide|as (we|you) can see|let'?s (look|see|take)|needless to say|basically|at the end of the day)\b/i;
const HYPE_RE = /\p{L}{3,}!\s*$/u;
const EMOJI_RE = /\p{Extended_Pictographic}/u;
/** Ends with exactly one period (not an ellipsis). */
const FINAL_PERIOD_RE = /[^.]\.$/;
const CONTENT_TYPES = new Set([
  'CONTENT',
  'DEFINITION',
  'FORMULA',
  'EXAMPLE',
  'COMPARISON',
  'DIAGRAM',
  'CODE',
]);
/** Projected code stays readable up to ~12 lines of ~60-70 characters. */
const MAX_CODE_LINES = 12;
const MAX_CODE_LINE_CHARS = 70;

const plain = (value: unknown) =>
  typeof value === 'string' ? value.replace(/\*\*/g, '').trim() : '';
const words = (value: unknown) => plain(value).split(/\s+/).filter(Boolean).length;

function bulletLists(slide: StudioSlide): string[][] {
  return [slide.bullets, slide.leftColumn?.bullets, slide.rightColumn?.bullets].filter(
    (list): list is string[] => Array.isArray(list) && list.length > 1,
  );
}

/** Truncated ("…") and question/colon endings say nothing about the list's form. */
const NEUTRAL_END_RE = /(…|\.\.\.|[?؟:!])$/;

function mixedPunctuation(list: string[]) {
  const judged = list.map(plain).filter((item) => item && !NEUTRAL_END_RE.test(item));
  const sentences = judged.filter((item) => FINAL_PERIOD_RE.test(item)).length;
  return sentences > 0 && sentences < judged.length;
}

/** A body slide carried by bullets alone: no visual, table, example, formula or comparison. */
function textOnly(slide: StudioSlide) {
  return (
    CONTENT_TYPES.has(String(slide.type)) &&
    renderedLayout(slide) === 'BULLETS' &&
    !hasVisual(slide) &&
    !slide.table?.headers?.length &&
    !slide.example &&
    !plain(slide.formula?.latex) &&
    !plain(slide.code?.source)
  );
}

function isStructural(slide: StudioSlide) {
  return (
    slide.type === 'TITLE' ||
    slide.type === 'SECTION' ||
    slide.layout === 'TITLE_CENTER' ||
    slide.layout === 'SECTION_DIVIDER'
  );
}

function bodyTexts(slide: StudioSlide): string[] {
  return [
    ...(slide.bullets ?? []),
    ...(slide.leftColumn?.bullets ?? []),
    ...(slide.rightColumn?.bullets ?? []),
    slide.leftColumn?.heading,
    slide.rightColumn?.heading,
    slide.callout?.text,
    slide.formula?.explanation,
    slide.example?.problem,
    ...(slide.example?.steps ?? []),
    slide.example?.solution,
    ...(slide.table?.headers ?? []),
    ...(slide.table?.rows ?? []).flat(),
  ]
    .map(plain)
    .filter(Boolean);
}

/** Deterministic, model-free checks of a normalized slide deck. */
export function lintSlides(
  slides: StudioSlide[],
  language: StudioLanguage,
  profile?: DisciplineProfile,
): StudioQaFinding[] {
  const findings: StudioQaFinding[] = [];
  const add = (
    index: number,
    severity: StudioQaFinding['severity'],
    category: string,
    message: string,
  ) => findings.push({ slide: index + 1, severity, category, message, source: 'auto' });

  const titleCounts = new Map<string, number>();
  for (const slide of slides) {
    const key = plain(slide.title).toLowerCase();
    if (key) titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
  }
  const seenTexts: Array<{ key: string; slide: number }> = [];
  let textRun = 0;

  slides.forEach((slide, index) => {
    const title = plain(slide.title);
    if ((titleCounts.get(title.toLowerCase()) ?? 0) > 1) {
      add(index, 'medium', 'coherence', 'Title duplicates another slide; make it specific to this slide.');
    }
    if (words(title) > MAX_TITLE_WORDS) {
      add(index, 'low', 'clarity', `Title is longer than ${MAX_TITLE_WORDS} words; shorten it.`);
    }
    if (language === 'ar' && title && !ARABIC_RE.test(title) && /[a-z]{4,}/i.test(title)) {
      add(index, 'medium', 'clarity', 'Slide is not written in Arabic like the rest of the deck.');
    }
    textRun = textOnly(slide) ? textRun + 1 : 0;
    if (isStructural(slide)) return;

    if (
      slide.type === 'INTRODUCTION' &&
      (hasVisual(slide) || plain(slide.code?.source) || slide.example || plain(slide.formula?.latex))
    ) {
      add(
        index,
        'medium',
        'pedagogy',
        'Introduction teaches content instead of framing the lecture; drop the visual/code, give a motivating subtitle and 3-4 bullets previewing what the lecture covers.',
      );
    }
    if (CONTENT_TYPES.has(String(slide.type)) && title && words(title) <= MAX_LABEL_TITLE_WORDS) {
      add(index, 'low', 'polish', 'Headline is a topic label; state the slide\'s claim as a 5-10 word sentence.');
    }
    if (textRun > MAX_TEXT_RUN) {
      add(
        index,
        'low',
        'layout',
        `Slide ${textRun} in a row with only bullets; turn this one into a diagram, table, comparison or worked example.`,
      );
    }
    const texts = bodyTexts(slide);
    const styled = [title, ...texts];
    if (styled.some((text) => FILLER_RE.test(text))) {
      add(index, 'low', 'polish', 'Remove filler phrases ("it is important to note", "in this slide", "basically").');
    }
    if (styled.some((text) => HYPE_RE.test(text) || EMOJI_RE.test(text))) {
      add(index, 'low', 'polish', 'Remove exclamation marks and emojis; keep an academic tone.');
    }
    if (bulletLists(slide).some(mixedPunctuation)) {
      add(index, 'low', 'polish', 'Bullets mix full sentences and fragments; make them all one form.');
    }

    const visual = hasVisual(slide);
    const visibleKeys = visibleTexts(slide).map(textKey).filter(Boolean);
    if (!visibleKeys.length) {
      add(
        index,
        'high',
        'pedagogy',
        visual
          ? 'Slide shows only a figure with no text; add 2-3 short bullets on what students should notice in it and why it matters.'
          : 'Slide body is empty; write 3-4 informative bullets from the references.',
      );
    } else if (texts.some((text) => !visibleKeys.includes(textKey(text)))) {
      add(index, 'medium', 'layout', 'Part of the text is hidden by the chosen layout; make type and layout match the content.');
    }
    // Code is built up across slides on purpose, so it never counts as repeated text.
    const codeKeys = new Set([textKey(slide.code?.source), textKey(slide.code?.output)]);
    const repeat = visibleKeys
      .filter((key) => key.length >= MIN_REPEAT_CHARS && !codeKeys.has(key))
      .map((key) => seenTexts.find((seen) => similarText(seen.key, key)))
      .find(Boolean);
    if (repeat) {
      add(index, 'medium', 'coherence', `Repeats text already on slide ${repeat.slide + 1}; say something new or merge the slides.`);
    }
    seenTexts.push(...visibleKeys.filter((key) => !codeKeys.has(key)).map((key) => ({ key, slide: index })));

    if (texts.some((text) => PLACEHOLDER_RE.test(text))) {
      add(index, 'high', 'pedagogy', 'Body is generic placeholder text; write real content from the references.');
    }
    const truncated = [
      ...(slide.bullets ?? []),
      ...(slide.leftColumn?.bullets ?? []),
      ...(slide.rightColumn?.bullets ?? []),
    ].filter((bullet) => plain(bullet).endsWith('…')).length;
    if (truncated) {
      add(index, 'medium', 'layout', `${truncated} bullet(s) were too long and got cut; rewrite each in at most 16 words.`);
    }
    const fit = estimateSlideFit(slide);
    if (fit && fit.fill > 1) {
      add(
        index,
        'medium',
        'layout',
        slide.code?.source
          ? `Code and text overflow the slide by about ${Math.round((fit.fill - 1) * 100)}% and get cut off; drop code lines that do not matter (elide with …) and keep 1-2 short bullets.`
          : `Text overflows the slide by about ${Math.round((fit.fill - 1) * 100)}% and gets cut off; remove about ${Math.max(5, fit.excessWords)} words (tighten bullets, drop the weakest point or move detail to speaker notes).`,
      );
    } else if (fit && fit.fill > TIGHT_FILL) {
      add(index, 'low', 'layout', 'Text fills the whole slide with no breathing room; trim a few words.');
    } else if (fit && fit.arrangement === 'text' && fit.fill < SPARSE_FILL && slide.type === 'CONTENT') {
      add(index, 'low', 'pedagogy', 'Slide looks nearly empty; add a concrete example, a visual or merge it with a neighbour.');
    }
    if (fit?.diagramLabelPx != null && fit.diagramLabelPx < MIN_DIAGRAM_LABEL_PX) {
      add(
        index,
        'medium',
        'layout',
        `Diagram labels would show at about ${fit.diagramLabelPx}px (body text is 16px) and cannot be read in a lecture hall; redraw it with at most 6 nodes and 4 levels, or use flowchart LR for a sequence.`,
      );
    } else if (fit?.diagramLabelPx != null && fit.diagramLabelPx < SMALL_DIAGRAM_LABEL_PX) {
      add(index, 'low', 'layout', 'Diagram labels are small; simplify the diagram slightly.');
    }
    if (visual && (slide.bullets?.length ?? 0) > MAX_VISUAL_BULLETS) {
      add(index, 'medium', 'layout', `Slide has a visual; keep at most ${MAX_VISUAL_BULLETS} short bullets beside it.`);
    }
    const code = slide.code;
    if (String(slide.type).toUpperCase() === 'CODE' && !plain(code?.source)) {
      add(index, 'medium', 'pedagogy', 'Code slide has no code; add a short runnable snippet (≤ 12 lines) with its output.');
    }
    if (code?.source?.trim()) {
      const lines = code.source.split('\n').length;
      if (lines > MAX_CODE_LINES) {
        add(index, 'medium', 'layout', `Code has ${lines} lines; show at most ${MAX_CODE_LINES} (keep the lines that matter, elide the rest with "…" or split the slide).`);
      }
      if (longestCodeLine(slide) > MAX_CODE_LINE_CHARS) {
        add(index, 'low', 'layout', `Code lines longer than ${MAX_CODE_LINE_CHARS} characters wrap on the slide; shorten names or break the statement.`);
      }
      if (visual) {
        add(index, 'medium', 'layout', 'Slide shows code and a figure/diagram at once; keep the code and move the visual to its own slide.');
      }
      if (!slide.bullets?.length) {
        add(index, 'low', 'pedagogy', 'Add 1-3 short bullets explaining what the highlighted code lines do.');
      }
      if (!code.language || code.language === 'text') {
        add(index, 'low', 'clarity', 'Name the code language so it is highlighted correctly.');
      }
    }
    const steps = slide.example?.steps?.length ?? 0;
    if (steps > MAX_EXAMPLE_STEPS) {
      add(index, 'medium', 'layout', `Worked example has ${steps} steps and will be split across slides; keep at most ${MAX_EXAMPLE_STEPS}.`);
    }
    if (slide.example && visual && (slide.bullets?.length ?? 0) > 1) {
      add(index, 'medium', 'layout', 'Slide is overloaded (worked example + visual + bullets); keep the example and at most one bullet.');
    }
    const mermaidEdges = String(slide.diagram?.mermaid ?? '')
      .split('\n')
      .filter((line) => /--|==|-\.|->>/.test(line)).length;
    if (mermaidEdges > MAX_MERMAID_EDGES) {
      add(index, 'medium', 'layout', 'Diagram is too dense to read on a slide; simplify it to 3-6 nodes.');
    }
    const table = slide.table;
    if (table?.headers?.length) {
      if (table.headers.length > MAX_TABLE_COLUMNS || (table.rows?.length ?? 0) > MAX_TABLE_ROWS) {
        add(index, 'medium', 'layout', `Table is too large; use at most ${MAX_TABLE_COLUMNS} columns and ${MAX_TABLE_ROWS} rows.`);
      }
      if ((table.rows ?? []).flat().some((cell) => words(cell) > 8)) {
        add(index, 'low', 'layout', 'Table cells should be at most 6-8 words.');
      }
    }
    const prompt = plain(slide.callout?.text);
    if (slide.type === 'CHECKPOINT' && !/[?؟]/.test(prompt) && !(TASK_RE.test(prompt) || (language === 'ar' && words(prompt) >= 6))) {
      add(index, 'medium', 'pedagogy', 'Checkpoint must ask the students one clear question or task.');
    }
    if (slide.type === 'FORMULA' && !plain(slide.formula?.latex)) {
      add(index, 'high', 'accuracy', 'Formula slide has no formula; add the LaTeX formula and explain its symbols.');
    }
    if (slide.type === 'EXAMPLE' && !plain(slide.example?.solution)) {
      add(index, 'medium', 'pedagogy', 'Worked example has no solution; state the result and interpret it.');
    }
    if (
      slide.layout === 'TWO_COLUMN' &&
      (!slide.leftColumn?.bullets?.length || !slide.rightColumn?.bullets?.length)
    ) {
      add(index, 'medium', 'layout', 'Comparison needs both columns filled with matching aspects.');
    }
    if (CONTENT_TYPES.has(String(slide.type)) && !slide.cloCode) {
      add(index, 'low', 'pedagogy', 'Content slide is not linked to a CLO.');
    }
    if (plain(slide.speakerNotes).length < MIN_NOTES_CHARS) {
      add(index, 'low', 'pedagogy', 'Speaker notes are missing or too thin.');
    }
  });

  const conclusion = slides.findIndex((slide) => slide.type === 'CONCLUSION');
  slides.forEach((slide, index) => {
    if (slide.type === 'SUMMARY' && conclusion >= 0 && Math.abs(conclusion - index) <= RECAP_DISTANCE) {
      add(
        index,
        'medium',
        'coherence',
        `Recaps the lecture right next to the conclusion (slide ${conclusion + 1}); turn it into a CHECKPOINT question or a worked example that applies several ideas together.`,
      );
    }
  });
  if (profile) findings.push(...disciplineFindings(slides, profile));
  return findings;
}

/**
 * Makes a bullet list read as one form, following its majority: fragments lose
 * a lone trailing period, or sentences gain the missing one.
 */
function unifyPunctuation(list: string[] | undefined): string[] | undefined {
  if (!list || list.length < 2 || !mixedPunctuation(list)) return list;
  const judged = list.map(plain).filter((item) => item && !NEUTRAL_END_RE.test(item));
  const sentences = judged.filter((item) => FINAL_PERIOD_RE.test(item)).length;
  if (sentences * 2 > judged.length) {
    return list.map((item) => {
      const text = item.trim();
      return !text || NEUTRAL_END_RE.test(plain(text)) || /[.!?؟]$/.test(plain(text)) ? item : `${text}.`;
    });
  }
  return list.map((item) => {
    const text = item.trim();
    return FINAL_PERIOD_RE.test(text) && !/[.!?]\s/.test(text) ? text.slice(0, -1) : item;
  });
}

/** Cheap deterministic fixes applied to every written slide. */
export function polishSlide(slide: StudioSlide): StudioSlide {
  if (typeof slide.title === 'string') {
    const title = slide.title.replace(/\s{2,}/g, ' ').trim();
    slide.title = FINAL_PERIOD_RE.test(title) && !/[.!?]\s/.test(title) ? title.slice(0, -1) : title;
  }
  slide.bullets = unifyPunctuation(slide.bullets);
  if (slide.leftColumn) slide.leftColumn = { ...slide.leftColumn, bullets: unifyPunctuation(slide.leftColumn.bullets) };
  if (slide.rightColumn) slide.rightColumn = { ...slide.rightColumn, bullets: unifyPunctuation(slide.rightColumn.bullets) };
  if (slide.formula?.latex) {
    slide.formula = {
      ...slide.formula,
      latex: slide.formula.latex
        .trim()
        .replace(/^\${1,2}|\${1,2}$/g, '')
        .replace(/^\\\[|\\\]$/g, '')
        .trim(),
    };
  }
  return slide;
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;
const SEVERITY_WEIGHT = { high: 6, medium: 3, low: 1 } as const;
/** Factual errors are what embarrass a lecturer most, so they jump the queue. */
const ACCURACY_BONUS = 2;
/** Several small flaws together are worth a rewrite even without a serious one. */
const MIN_LOW_WEIGHT = 3;

/** Slides worth rewriting (any medium/high finding, or several low ones), worst first. 0-based. */
export function pickOptimizeTargets(findings: StudioQaFinding[], limit: number): number[] {
  const slides = new Map<number, { weight: number; serious: boolean }>();
  for (const finding of findings) {
    const index = finding.slide - 1;
    const entry = slides.get(index) ?? { weight: 0, serious: false };
    entry.weight += SEVERITY_WEIGHT[finding.severity] + (finding.category === 'accuracy' ? ACCURACY_BONUS : 0);
    entry.serious ||= finding.severity !== 'low';
    slides.set(index, entry);
  }
  return [...slides.entries()]
    .filter(([, entry]) => entry.serious || entry.weight >= MIN_LOW_WEIGHT)
    .sort((a, b) => b[1].weight - a[1].weight || a[0] - b[0])
    .slice(0, limit)
    .map(([index]) => index)
    .sort((a, b) => a - b);
}

const BLOCKING_WEIGHT = { high: 3, medium: 1, low: 0 } as const;

/**
 * Medium/high automated problems that a rewrite of slide `index` introduced;
 * empty when the rewrite is no worse than the slide it replaces.
 */
export function lintRegressions(
  before: StudioSlide[],
  after: StudioSlide[],
  index: number,
  language: StudioLanguage,
  profile?: DisciplineProfile,
): string[] {
  const serious = (deck: StudioSlide[]) =>
    lintSlides(deck, language, profile).filter((finding) => finding.slide === index + 1 && finding.severity !== 'low');
  const old = serious(before);
  const next = serious(after);
  const weight = (list: StudioQaFinding[]) =>
    list.reduce((sum, finding) => sum + BLOCKING_WEIGHT[finding.severity], 0);
  if (weight(next) <= weight(old)) return [];
  const fresh = next.filter((finding) => !old.some((known) => known.message === finding.message));
  return (fresh.length ? fresh : next).map((finding) => finding.message);
}

/** Merge model findings into automated ones, dropping near-duplicates per slide. */
export function mergeFindings(
  automated: StudioQaFinding[],
  judged: StudioQaFinding[],
): StudioQaFinding[] {
  const merged = [...automated];
  for (const finding of judged) {
    const duplicate = merged.some(
      (existing) =>
        existing.slide === finding.slide &&
        existing.category === finding.category &&
        existing.severity === finding.severity &&
        existing.source === 'auto',
    );
    if (!duplicate) merged.push(finding);
  }
  return merged.sort((a, b) => a.slide - b.slide || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}
