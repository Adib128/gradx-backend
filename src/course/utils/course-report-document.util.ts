export type ReportLanguage = 'en' | 'ar';

export type CloCategoryGroup = 'knowledge' | 'skills' | 'values' | 'other';

export const normalizeReportLanguage = (value: unknown): ReportLanguage =>
  String(value ?? '').toLowerCase().startsWith('ar') ? 'ar' : 'en';

export const sectionKeyOf = (section: string | null | undefined) =>
  (section ?? '').trim();

/** Distinct section names, natural-sorted ("2" before "10"); no-section students last. */
export function orderSections(sections: Iterable<string>): string[] {
  const unique = Array.from(new Set(sections));
  const named = unique
    .filter((section) => section !== '')
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return unique.includes('') ? [...named, ''] : named;
}

export function cloCategoryGroup(category: string | null | undefined): CloCategoryGroup {
  const raw = (category ?? '').trim().toLowerCase();
  if (!raw) return 'other';
  if (raw.includes('knowledge') || raw.startsWith('k')) return 'knowledge';
  if (raw.includes('skill') || raw.startsWith('s')) return 'skills';
  if (raw.includes('value') || raw.startsWith('v')) return 'values';
  return 'other';
}

const COMMENT_TEXT = {
  en: {
    all: 'Target achieved in all sections',
    allSingle: 'Target achieved',
    none: 'Target not achieved',
    achieved: 'Target achieved in',
    notAchieved: 'but not achieved in',
    section: 'section',
    sections: 'sections',
    and: 'and',
  },
  ar: {
    all: 'تم تحقيق المستهدف في جميع الشعب',
    allSingle: 'تم تحقيق المستهدف',
    none: 'لم يتم تحقيق المستهدف',
    achieved: 'تم تحقيق المستهدف في',
    notAchieved: 'ولكن لم يتحقق في',
    section: 'الشعبة',
    sections: 'الشعب',
    and: 'و',
  },
} as const;

function joinList(items: string[], and: string) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${and} ${items[items.length - 1]}`;
}

/**
 * "Target achieved in all sections" / "Target achieved in section 109, but not
 * achieved in sections 110 and 314." / "Target not achieved". Sections without
 * data (`achieved === null`) are left out of the sentence.
 */
export function buildAchievementComment(
  language: ReportLanguage,
  sections: Array<{ section: string; achieved: boolean | null }>,
): string {
  const text = COMMENT_TEXT[language];
  const known = sections.filter((entry) => entry.achieved !== null);
  if (known.length === 0) return '';

  const met = known.filter((entry) => entry.achieved);
  const missed = known.filter((entry) => !entry.achieved);
  const single = known.length === 1 && known[0].section === '';

  if (missed.length === 0) return single ? text.allSingle : text.all;
  if (met.length === 0) return text.none;

  const label = (list: typeof known) =>
    `${list.length === 1 ? text.section : text.sections} ${joinList(
      list.map((entry) => entry.section),
      text.and,
    )}`;
  return `${text.achieved} ${label(met)}, ${text.notAchieved} ${label(missed)}.`;
}
