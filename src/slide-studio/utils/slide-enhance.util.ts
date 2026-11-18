import type { StudioSlide } from '../slide-studio.types';

const STRUCTURE_KEYS = [
  'type',
  'layout',
  'image',
  'video',
  'diagram',
  'boxes',
  'titleFontSize',
  'bodyFontSize',
  'cloCode',
  'bloomLevel',
  'teachingBeat',
  'timingMinutes',
  'sectionLabel',
] as const;

/**
 * Keep shape / style / media components from the pre-enhance slide.
 * Only text teaching content from the model rewrite is allowed through.
 */
export function applySurgicalEnhance(
  previous: StudioSlide,
  drafted: StudioSlide,
): StudioSlide {
  const next: StudioSlide = {
    ...previous,
    title: drafted.title || previous.title,
    subtitle:
      drafted.subtitle !== undefined ? drafted.subtitle : previous.subtitle,
    bullets: Array.isArray(drafted.bullets) ? drafted.bullets : previous.bullets,
    leftColumn:
      drafted.leftColumn !== undefined ? drafted.leftColumn : previous.leftColumn,
    rightColumn:
      drafted.rightColumn !== undefined
        ? drafted.rightColumn
        : previous.rightColumn,
    callout: drafted.callout !== undefined ? drafted.callout : previous.callout,
    formula: drafted.formula !== undefined ? drafted.formula : previous.formula,
    code: drafted.code !== undefined ? drafted.code : previous.code,
    example: drafted.example !== undefined ? drafted.example : previous.example,
    table: drafted.table !== undefined ? drafted.table : previous.table,
    speakerNotes:
      drafted.speakerNotes !== undefined
        ? drafted.speakerNotes
        : previous.speakerNotes,
    slideNumber: previous.slideNumber ?? drafted.slideNumber,
  };

  for (const key of STRUCTURE_KEYS) {
    if (previous[key] !== undefined) {
      (next as Record<string, unknown>)[key] = previous[key];
    }
  }

  // Preserve any extra layout/style keys the editor may have set.
  for (const [key, value] of Object.entries(previous)) {
    if (key in next) continue;
    if (value === undefined) continue;
    (next as Record<string, unknown>)[key] = value;
  }

  return next;
}
