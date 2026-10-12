import type {
  StudioAnalysis,
  StudioOutlineItem,
  StudioPlan,
  StudioPlanSection,
  StudioQaFinding,
  StudioReview,
  StudioTemplateSuggestion,
  StudioVisual,
} from '../slide-studio.types';
import { isDisciplineId } from './discipline-profile.util';

export const MIN_SLIDES = 4;
export const MAX_SLIDES = 40;
export const MAX_PLAN_SECTIONS = 16;

const text = (value: unknown, max = 600) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

const textList = (value: unknown, maxItems = 12, maxChars = 300) =>
  (Array.isArray(value) ? value : [])
    .map((item) => text(item, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);

const int = (value: unknown, fallback: number) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : fallback;
};

export function coerceAnalysis(raw: Record<string, unknown>): StudioAnalysis {
  const profile = text(raw.profile, 40).toLowerCase();
  return {
    profile: isDisciplineId(profile) ? profile : 'general',
    field: text(raw.field, 120) || 'General',
    discipline: text(raw.discipline, 120),
    subfield: text(raw.subfield, 160),
    materialTypes: textList(raw.materialTypes, 6, 40),
    audienceLevel: text(raw.audienceLevel, 120),
    keyConcepts: textList(raw.keyConcepts, 12, 120),
    visualStrategy: text(raw.visualStrategy, 400),
    summary: text(raw.summary, 600),
  };
}

export function coercePlanSection(
  raw: Record<string, unknown>,
  index: number,
): StudioPlanSection | null {
  const title = text(raw.title, 160);
  if (!title) return null;
  return {
    id: `s${index + 1}`,
    title,
    goal: text(raw.goal, 400),
    cloCodes: textList(raw.cloCodes, 6, 20),
    slideCount: Math.max(1, int(raw.slideCount, 2)),
    keyPoints: textList(raw.keyPoints, 6, 240),
    visuals: textList(raw.visuals, 6, 240),
  };
}

export function emptyPlan(): StudioPlan {
  return { title: '', approach: '', learningGoals: [], sections: [] };
}

export function applyPlanMeta(plan: StudioPlan, raw: Record<string, unknown>): StudioPlan {
  return {
    ...plan,
    title: text(raw.title, 200) || plan.title,
    approach: text(raw.approach, 600) || plan.approach,
    learningGoals: textList(raw.learningGoals, 6, 240).length
      ? textList(raw.learningGoals, 6, 240)
      : plan.learningGoals,
  };
}

/** Make section slide counts add up to `target` (min 1 each). */
export function rebalancePlan(plan: StudioPlan, target: number): StudioPlan {
  const sections = plan.sections.map((section) => ({ ...section }));
  if (!sections.length) return plan;
  let total = sections.reduce((sum, section) => sum + section.slideCount, 0);
  while (total > target) {
    const largest = sections.reduce((best, section) =>
      section.slideCount > best.slideCount ? section : best,
    );
    if (largest.slideCount <= 1) break;
    largest.slideCount -= 1;
    total -= 1;
  }
  // Grow core sections first (not the opening/closing ones).
  const growable = sections.length > 2 ? sections.slice(1, -1) : sections;
  let cursor = 0;
  while (total < target) {
    const candidates = [...growable].sort((a, b) => a.slideCount - b.slideCount);
    candidates[cursor % candidates.length].slideCount += 1;
    cursor += 1;
    total += 1;
  }
  return { ...plan, sections };
}

/** Instructor-edited plan from the client: keep it, but sanitised. */
export function sanitizePlan(raw: unknown, fallback: StudioPlan): StudioPlan {
  if (!raw || typeof raw !== 'object') return fallback;
  const value = raw as Record<string, unknown>;
  const sections = (Array.isArray(value.sections) ? value.sections : [])
    .map((section, index) =>
      section && typeof section === 'object'
        ? coercePlanSection(section as Record<string, unknown>, index)
        : null,
    )
    .filter((section): section is StudioPlanSection => !!section)
    .slice(0, MAX_PLAN_SECTIONS);
  if (!sections.length) return fallback;
  // Cleared fields are intentional edits, so only the title falls back.
  const plan: StudioPlan = {
    title: text(value.title, 200) || fallback.title,
    approach: typeof value.approach === 'string' ? text(value.approach, 600) : fallback.approach,
    learningGoals: Array.isArray(value.learningGoals)
      ? textList(value.learningGoals, 6, 240)
      : fallback.learningGoals,
    sections,
  };
  const total = sections.reduce((sum, section) => sum + section.slideCount, 0);
  if (total > MAX_SLIDES) return rebalancePlan(plan, MAX_SLIDES);
  if (total < MIN_SLIDES) return rebalancePlan(plan, MIN_SLIDES);
  return plan;
}

export function planSlideTotal(plan: StudioPlan) {
  return plan.sections.reduce((sum, section) => sum + section.slideCount, 0);
}

export function parseVisual(
  raw: unknown,
  figureKeys: Set<string>,
): StudioVisual {
  if (raw && typeof raw === 'object') {
    const value = raw as Record<string, unknown>;
    const kind = text(value.kind, 20);
    if (kind === 'figure' && figureKeys.has(text(value.figureKey, 80))) {
      return { kind: 'figure', figureKey: text(value.figureKey, 80) };
    }
    if (kind === 'mermaid' && text(value.idea, 300)) {
      return { kind: 'mermaid', idea: text(value.idea, 300) };
    }
    return { kind: 'none' };
  }
  const token = text(raw, 400);
  const match = /^(figure|mermaid)\s*:\s*(.+)$/i.exec(token);
  if (!match) return { kind: 'none' };
  if (match[1].toLowerCase() === 'figure') {
    const key = match[2].trim();
    return figureKeys.has(key) ? { kind: 'figure', figureKey: key } : { kind: 'none' };
  }
  return { kind: 'mermaid', idea: match[2].trim() };
}

/** Slides that frame the lecture: text only, never a figure or diagram. */
const FRAME_TYPES = new Set(['INTRODUCTION', 'CONCLUSION', 'REFERENCES']);

export function coerceOutlineItem(
  raw: Record<string, unknown>,
  index: number,
  sectionIds: string[],
  figureKeys: Set<string>,
  fallbackSectionId: string,
): StudioOutlineItem | null {
  const title = text(raw.title, 160);
  if (!title) return null;
  const requested = text(raw.section ?? raw.sectionId, 20);
  const type = text(raw.type, 30).toUpperCase() || 'CONTENT';
  return {
    index,
    sectionId: sectionIds.includes(requested) ? requested : fallbackSectionId,
    type,
    layout: text(raw.layout, 30).toUpperCase() || 'BULLETS',
    title,
    intent: text(raw.intent, 400),
    cloCode: text(raw.cloCode, 20) || null,
    visual: FRAME_TYPES.has(type) ? { kind: 'none' } : parseVisual(raw.visual, figureKeys),
  };
}

/** Instructor-edited outline from the client. */
export function sanitizeOutline(
  raw: unknown,
  fallback: StudioOutlineItem[],
  sectionIds: string[],
  figureKeys: Set<string>,
): StudioOutlineItem[] {
  if (!Array.isArray(raw)) return fallback;
  const items = raw
    .slice(0, MAX_SLIDES)
    .map((item, index) =>
      item && typeof item === 'object'
        ? coerceOutlineItem(
            item as Record<string, unknown>,
            index,
            sectionIds,
            figureKeys,
            sectionIds[0] ?? 's1',
          )
        : null,
    )
    .filter((item): item is StudioOutlineItem => !!item)
    .map((item, index) => ({ ...item, index }));
  return items.length >= 1 ? items : fallback;
}

export function coerceTemplateSuggestion(
  raw: Record<string, unknown>,
  fallbackId: string,
  templateIds: string[],
): StudioTemplateSuggestion {
  const ids = new Set(templateIds);
  const templateId = ids.has(text(raw.templateId, 60))
    ? text(raw.templateId, 60)
    : fallbackId;
  const seen = new Set([templateId]);
  const alternatives = (Array.isArray(raw.alternatives) ? raw.alternatives : [])
    .map((item) =>
      item && typeof item === 'object'
        ? {
            templateId: text((item as Record<string, unknown>).templateId, 60),
            reason: text((item as Record<string, unknown>).reason, 300),
          }
        : null,
    )
    .filter(
      (item): item is { templateId: string; reason: string } =>
        !!item && ids.has(item.templateId) && !seen.has(item.templateId) && !!seen.add(item.templateId),
    )
    .slice(0, 3);
  return {
    templateId,
    rationale: text(raw.rationale, 600),
    alternatives,
  };
}

const QA_CATEGORIES = ['accuracy', 'clarity', 'pedagogy', 'layout', 'coherence', 'polish'];

export function coerceInspection(
  raw: Record<string, unknown>,
  slideCount: number,
): { score: number; findings: StudioQaFinding[] } {
  const findings = (Array.isArray(raw.findings) ? raw.findings : [])
    .map((item): StudioQaFinding | null => {
      if (!item || typeof item !== 'object') return null;
      const value = item as Record<string, unknown>;
      const slide = int(value.slide, 0);
      const message = text(value.message, 300);
      if (slide < 1 || slide > slideCount || !message) return null;
      const severity = text(value.severity, 10).toLowerCase();
      const category = text(value.category, 20).toLowerCase();
      return {
        slide,
        severity:
          severity === 'high' || severity === 'medium' ? severity : 'low',
        category: QA_CATEGORIES.includes(category) ? category : 'clarity',
        message,
        source: 'ai',
      };
    })
    .filter((item): item is StudioQaFinding => !!item)
    .slice(0, 16);
  return { score: Math.min(100, Math.max(0, int(raw.score, 0))), findings };
}

export function coerceReview(raw: Record<string, unknown>): StudioReview {
  const score = Math.min(100, Math.max(0, int(raw.score, 0)));
  return {
    score,
    summary: text(raw.summary, 600),
    cloCoverage: (Array.isArray(raw.cloCoverage) ? raw.cloCoverage : [])
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const value = item as Record<string, unknown>;
        const code = text(value.code, 20);
        if (!code) return null;
        return {
          code,
          slides: (Array.isArray(value.slides) ? value.slides : [])
            .map((slide) => int(slide, 0))
            .filter((slide) => slide > 0),
        };
      })
      .filter((item): item is { code: string; slides: number[] } => !!item)
      .slice(0, 20),
    issues: (Array.isArray(raw.issues) ? raw.issues : [])
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const value = item as Record<string, unknown>;
        const message = text(value.message, 400);
        if (!message) return null;
        const slide = int(value.slide, 0);
        const severity = text(value.severity, 10).toLowerCase();
        return {
          slide: slide > 0 ? slide : null,
          severity: ['low', 'medium', 'high'].includes(severity) ? severity : 'low',
          message,
        };
      })
      .filter(
        (item): item is { slide: number | null; severity: string; message: string } =>
          !!item,
      )
      .slice(0, 8),
  };
}
