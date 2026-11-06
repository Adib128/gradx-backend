import type { StudioFigure, StudioPlanSection } from '../slide-studio.types';

const tokens = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff\s]/gi, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2);

/**
 * Rank reference figures for a plan section by caption overlap with
 * title / goal / key points / CLO codes. Textbook-first selection aid.
 */
export function rankFiguresForSection(
  section: Pick<StudioPlanSection, 'title' | 'goal' | 'keyPoints' | 'cloCodes'>,
  figures: StudioFigure[],
  limit = 5,
): StudioFigure[] {
  if (!figures.length) return [];
  const query = new Set(
    tokens(
      [section.title, section.goal, ...section.keyPoints, ...section.cloCodes].join(' '),
    ),
  );
  if (!query.size) return figures.slice(0, limit);

  return [...figures]
    .map((figure) => {
      const captionTokens = tokens(`${figure.caption} ${figure.referenceTitle}`);
      let score = 0;
      for (const token of captionTokens) {
        if (query.has(token)) score += 2;
      }
      // Slight preference for earlier pages when scores tie (chapter flow).
      score += Math.max(0, 1 - figure.pageNumber / 10_000);
      return { figure, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.figure);
}

/** Prompt block: per-section shortlists so the planner prefers textbook figures. */
export function rankedFiguresBlock(
  sections: Array<Pick<StudioPlanSection, 'id' | 'title' | 'goal' | 'keyPoints' | 'cloCodes'>>,
  figures: StudioFigure[],
): string {
  if (!figures.length || !sections.length) return '';
  const lines = sections.map((section) => {
    const ranked = rankFiguresForSection(section, figures, 4);
    if (!ranked.length) return `- ${section.id}: (no figures)`;
    return `- ${section.id} (${section.title}): ${ranked
      .map((figure) => `${figure.key} «${figure.caption}» p.${figure.pageNumber}`)
      .join('; ')}`;
  });
  return `Figure shortlists by section (prefer these textbook figures before mermaid):\n${lines.join('\n')}`;
}
