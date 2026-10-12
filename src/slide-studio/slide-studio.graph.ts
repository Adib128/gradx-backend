import {
  Annotation,
  END,
  START,
  StateGraph,
  interrupt,
  type LangGraphRunnableConfig,
} from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { ErrorMessageKey } from 'src/common/constants/error-message';
import {
  fitSlideDeckToTarget,
  normalizeAndPaginateSlideDeck,
  normalizeOneSlide,
} from 'src/topic-content/utils/slide-deck.util';
import {
  analystPrompt,
  designerPrompt,
  illustratorPrompt,
  inspectorPrompt,
  optimizerPrompt,
  outlinerPrompt,
  plannerPrompt,
  reviewerPrompt,
  verifierPrompt,
  writerPrompt,
} from './prompts/studio.prompts';
import type { SlideStudioLlm } from './slide-studio.llm';
import {
  allTemplates,
  DEFAULT_TEMPLATE_ID,
  findTemplate,
  templateDeckMeta,
} from './slide-studio.templates';
import type {
  StudioAgent,
  StudioAnalysis,
  StudioContext,
  StudioEvent,
  StudioExcerpt,
  StudioFigure,
  StudioInput,
  StudioInterrupt,
  StudioOutlineItem,
  StudioPlan,
  StudioPlanSection,
  StudioQa,
  StudioQaFinding,
  StudioResume,
  StudioReview,
  StudioSlide,
  StudioTemplateSuggestion,
} from './slide-studio.types';
import { summarizeContext } from './slide-studio.types';
import {
  classifyDiscipline,
  disciplineProfile,
  enforceDisciplineOutline,
} from './utils/discipline-profile.util';
import { mermaidProblems } from './utils/mermaid-check.util';
import {
  lintRegressions,
  lintSlides,
  mergeFindings,
  pickOptimizeTargets,
  polishSlide,
} from './utils/slide-lint.util';
import { fillEmptySlideBody, repairSlideStructure } from './utils/slide-repair.util';
import { figureCaption, withReferencesSlide } from './utils/studio-references.util';
import {
  applyPlanMeta,
  coerceAnalysis,
  coerceInspection,
  coerceOutlineItem,
  coercePlanSection,
  coerceReview,
  coerceTemplateSuggestion,
  emptyPlan,
  planSlideTotal,
  rebalancePlan,
  sanitizeOutline,
  sanitizePlan,
} from './utils/studio-coerce.util';

export const StudioState = Annotation.Root({
  input: Annotation<StudioInput>(),
  context: Annotation<StudioContext | null>(),
  analysis: Annotation<StudioAnalysis | null>(),
  plan: Annotation<StudioPlan | null>(),
  planRevision: Annotation<number>(),
  planFeedback: Annotation<string | null>(),
  templateSuggestion: Annotation<StudioTemplateSuggestion | null>(),
  templateId: Annotation<string | null>(),
  outline: Annotation<StudioOutlineItem[] | null>(),
  outlineRevision: Annotation<number>(),
  outlineFeedback: Annotation<string | null>(),
  slides: Annotation<StudioSlide[] | null>(),
  qa: Annotation<StudioQa | null>(),
  review: Annotation<StudioReview | null>(),
  deck: Annotation<Record<string, unknown> | null>(),
});

export type StudioStateType = typeof StudioState.State;
type Update = typeof StudioState.Update;

export type StudioGraphDeps = {
  llm: SlideStudioLlm;
  loadContext(input: StudioInput): Promise<StudioContext>;
  sectionExcerpts(
    input: StudioInput,
    context: StudioContext,
    section: StudioPlanSection,
  ): Promise<StudioExcerpt[]>;
  publishFigure(input: StudioInput, figure: StudioFigure): Promise<string | null>;
  saveDeck(input: StudioInput, deck: Record<string, unknown>): Promise<void>;
};

const WRITER_CONCURRENCY = 3;
/** Optimizer rewrites run at most this many times (the last inspection only reports). */
const MAX_OPTIMIZE_PASSES = 2;
const MAX_OPTIMIZE_SLIDES = 12;
const OPTIMIZE_BATCH = 4;
const OPTIMIZE_ATTEMPTS = 2;
/** Slides the final reviewer may send back for one more revision round. */
const MAX_REVIEW_REVISIONS = 8;

/** Problems reported for each slide, keyed by 0-based index. */
function problemsBySlide(findings: StudioQaFinding[]): Map<number, string[]> {
  const problems = new Map<number, string[]>();
  for (const finding of findings) {
    const list = problems.get(finding.slide - 1) ?? [];
    list.push(`[${finding.severity}] ${finding.message}`);
    problems.set(finding.slide - 1, list);
  }
  return problems;
}

/** Why a model call produced nothing, and whether trying again can help. */
function llmFailure(error: unknown): { reason: string; retryable: boolean } {
  if (!error) return { reason: 'empty answer', retryable: true };
  const status = Number((error as { status?: unknown }).status);
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (message.includes(ErrorMessageKey.AI_TOKEN_LIMIT_REACHED)) {
    return { reason: 'monthly AI token allowance used up', retryable: false };
  }
  if (status === 402 || /credit|afford/i.test(message)) {
    return { reason: 'AI credits exhausted', retryable: false };
  }
  if (status === 401 || status === 403) {
    return { reason: 'AI provider rejected the request', retryable: false };
  }
  return { reason: message.slice(0, 120) || 'request failed', retryable: true };
}

function emit(config: LangGraphRunnableConfig, event: StudioEvent) {
  config.writer?.(event);
}

function activity(
  config: LangGraphRunnableConfig,
  agent: StudioAgent,
  status: 'start' | 'done' | 'info',
  message: string,
  model?: string,
) {
  emit(config, { event: 'activity', data: { agent, status, message, model } });
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export function buildStudioGraph(
  deps: StudioGraphDeps,
  checkpointer: BaseCheckpointSaver,
) {
  const { llm } = deps;

  /**
   * Normalizes a model-written slide and attaches its visual. For rewrites,
   * `previous` keeps the published figure and the already-validated diagram.
   */
  const draftSlide = async (
    input: StudioInput,
    index: number,
    item: StudioOutlineItem | undefined,
    raw: Record<string, unknown>,
    figures: Map<string, StudioFigure>,
    previous: StudioSlide | null,
  ): Promise<StudioSlide> => {
    const rest = { ...raw };
    delete rest.n;
    const base = previous ?? {
      type: item?.type,
      layout: item?.layout,
      title: item?.title,
      bullets: item ? [item.intent] : [],
    };
    const slide = polishSlide(
      normalizeOneSlide({
        ...rest,
        type: rest.type || base.type,
        layout: rest.layout || base.layout,
        title: rest.title || base.title,
      }) ??
        (previous ? { ...previous } : normalizeOneSlide(base)) ??
        { title: item?.title ?? `Slide ${index + 1}` },
    );
    slide.slideNumber = index + 1;
    slide.cloCode = slide.cloCode || previous?.cloCode || item?.cloCode || null;

    if (previous?.image) {
      slide.image = previous.image;
      slide.diagram = null;
      return slide;
    }
    if (!previous && item?.visual.kind === 'figure') {
      const figure = figures.get(item.visual.figureKey);
      const src = figure ? await deps.publishFigure(input, figure) : null;
      if (figure && src) {
        slide.image = {
          src,
          alt: figure.caption,
          caption: figureCaption(figure, input.language),
          position: 'right',
          width: 46,
        };
        slide.diagram = null;
        return slide;
      }
    }
    const mermaid = slide.diagram?.mermaid?.trim();
    if (mermaid && (!previous || !mermaidProblems(mermaid).length)) {
      // Broken first drafts are kept for the illustrator to repair.
      slide.diagram = { ...slide.diagram, position: 'right', width: 48 } as StudioSlide['diagram'];
    } else {
      slide.diagram = previous?.diagram ?? null;
    }
    return slide;
  };

  const buildSlide = async (...args: Parameters<typeof draftSlide>) =>
    repairSlideStructure(await draftSlide(...args)).slide;

  const researcher = async (
    state: StudioStateType,
    config: LangGraphRunnableConfig,
  ): Promise<Update> => {
    activity(config, 'researcher', 'start', 'Retrieving reference material');
    const context = await deps.loadContext(state.input);
    emit(config, { event: 'context', data: summarizeContext(context) });
    activity(
      config,
      'researcher',
      'done',
      `${context.excerpts.length} excerpts (${context.mode}), ${context.figures.length} figures`,
    );
    return { context };
  };

  const analyst = async (
    state: StudioStateType,
    config: LangGraphRunnableConfig,
  ): Promise<Update> => {
    activity(config, 'analyst', 'start', 'Classifying the material', llm.models.analyst);
    const raw = await llm.json(
      'analyst',
      analystPrompt(state.input, state.context!),
      config.signal,
    );
    const analysis = coerceAnalysis(raw);
    analysis.profile = classifyDiscipline(state.input, analysis, state.context?.excerpts ?? []);
    emit(config, { event: 'analysis', data: analysis });
    activity(
      config,
      'analyst',
      'done',
      `${[analysis.field, analysis.discipline, analysis.subfield].filter(Boolean).join(' › ')} · ${
        disciplineProfile(analysis.profile).label
      }`,
    );
    return { analysis };
  };

  const planner = async (
    state: StudioStateType,
    config: LangGraphRunnableConfig,
  ): Promise<Update> => {
    const revision =
      state.plan && state.planFeedback
        ? { previous: state.plan, feedback: state.planFeedback }
        : null;
    activity(
      config,
      'planner',
      'start',
      revision ? 'Revising the plan with your feedback' : 'Drafting the teaching plan',
      llm.models.planner,
    );
    let plan = emptyPlan();
    await llm.ndjson(
      'planner',
      plannerPrompt(state.input, state.context!, state.analysis, revision),
      (line) => {
        if (line.type === 'meta') {
          plan = applyPlanMeta(plan, line);
        } else {
          const section = coercePlanSection(line, plan.sections.length);
          if (!section) return;
          plan = { ...plan, sections: [...plan.sections, section] };
        }
        emit(config, { event: 'plan_partial', data: plan });
      },
      config.signal,
    );
    if (!plan.sections.length) throw new Error('GENERATION_EMPTY_RESULT');
    plan = rebalancePlan(plan, state.input.slideCount);
    emit(config, { event: 'plan_partial', data: plan });
    activity(config, 'planner', 'done', `${plan.sections.length} sections planned`);
    return {
      plan,
      planFeedback: null,
      planRevision: (state.planRevision ?? 0) + 1,
    };
  };

  const planReview = (state: StudioStateType): Update => {
    const answer = interrupt<StudioInterrupt, StudioResume>({
      kind: 'plan_review',
      plan: state.plan!,
      revision: state.planRevision ?? 1,
    });
    if (
      answer?.kind === 'plan_review' &&
      answer.action === 'revise' &&
      answer.feedback?.trim()
    ) {
      // The planner revises the instructor's edited version, not its own draft.
      return {
        plan: sanitizePlan(answer.plan, state.plan!),
        planFeedback: answer.feedback.trim().slice(0, 2000),
      };
    }
    const plan =
      answer?.kind === 'plan_review' && answer.action === 'confirm'
        ? sanitizePlan(answer.plan, state.plan!)
        : state.plan!;
    return {
      plan,
      planFeedback: null,
      input: { ...state.input, slideCount: planSlideTotal(plan) },
    };
  };

  const designer = async (
    state: StudioStateType,
    config: LangGraphRunnableConfig,
  ): Promise<Update> => {
    activity(config, 'designer', 'start', 'Choosing the best template', llm.models.designer);
    const raw = await llm.json(
      'designer',
      designerPrompt(state.input, state.analysis, state.plan!),
      config.signal,
    );
    const suggestion = coerceTemplateSuggestion(
      raw,
      DEFAULT_TEMPLATE_ID,
      allTemplates(state.input.customTemplates).map((template) => template.id),
    );
    emit(config, { event: 'template_suggestion', data: suggestion });
    activity(config, 'designer', 'done', findTemplate(suggestion.templateId, state.input.customTemplates).name.en);
    return { templateSuggestion: suggestion };
  };

  const templateReview = (state: StudioStateType): Update => {
    const answer = interrupt<StudioInterrupt, StudioResume>({
      kind: 'template_review',
      suggestion: state.templateSuggestion!,
    });
    const chosen = answer?.kind === 'template_review' ? answer : null;
    const customTemplates = chosen?.customTemplate
      ? [
          chosen.customTemplate,
          ...(state.input.customTemplates ?? []).filter(
            (template) => template.id !== chosen.customTemplate!.id,
          ),
        ]
      : state.input.customTemplates;
    return {
      input: { ...state.input, customTemplates },
      templateId: findTemplate(
        chosen?.templateId || state.templateSuggestion?.templateId,
        customTemplates,
      ).id,
    };
  };

  const outliner = async (
    state: StudioStateType,
    config: LangGraphRunnableConfig,
  ): Promise<Update> => {
    const plan = state.plan!;
    const template = findTemplate(state.templateId, state.input.customTemplates);
    const revision =
      state.outline && state.outlineFeedback
        ? { previous: state.outline, feedback: state.outlineFeedback }
        : null;
    activity(
      config,
      'outliner',
      'start',
      revision ? 'Revising the outline with your feedback' : 'Outlining every slide',
      llm.models.outliner,
    );
    const sectionIds = plan.sections.map((section) => section.id);
    const figureKeys = new Set(state.context!.figures.map((figure) => figure.key));
    const usedFigures = new Set<string>();
    const outline: StudioOutlineItem[] = [];
    // Fallback section follows the planned counts when the model omits ids.
    const sectionForIndex = (index: number) => {
      let cursor = 0;
      for (const section of plan.sections) {
        cursor += section.slideCount;
        if (index < cursor) return section.id;
      }
      return sectionIds[sectionIds.length - 1] ?? 's1';
    };

    await llm.ndjson(
      'outliner',
      outlinerPrompt(
        state.input,
        state.context!,
        plan,
        template,
        revision,
        disciplineProfile(state.analysis?.profile),
      ),
      (line) => {
        if (outline.length >= state.input.slideCount) return;
        const item = coerceOutlineItem(
          line,
          outline.length,
          sectionIds,
          figureKeys,
          sectionForIndex(outline.length),
        );
        if (!item) return;
        if (item.visual.kind === 'figure') {
          if (usedFigures.has(item.visual.figureKey)) item.visual = { kind: 'none' };
          else usedFigures.add(item.visual.figureKey);
        }
        outline.push(item);
        emit(config, { event: 'outline_item', data: item });
      },
      config.signal,
    );
    if (!outline.length) throw new Error('GENERATION_EMPTY_RESULT');
    const profile = disciplineProfile(state.analysis?.profile);
    const enforced = enforceDisciplineOutline(outline, profile);
    if (enforced.changed.length) {
      activity(
        config,
        'outliner',
        'info',
        `Slides ${enforced.changed.map((index) => index + 1).join(', ')} retyped to carry ${profile.evidence}`,
      );
    }
    emit(config, { event: 'outline', data: enforced.outline });
    activity(config, 'outliner', 'done', `${outline.length} slides outlined`);
    return {
      outline: enforced.outline,
      outlineFeedback: null,
      outlineRevision: (state.outlineRevision ?? 0) + 1,
    };
  };

  const outlineReview = (state: StudioStateType): Update => {
    const answer = interrupt<StudioInterrupt, StudioResume>({
      kind: 'outline_review',
      outline: state.outline!,
      revision: state.outlineRevision ?? 1,
    });
    if (
      answer?.kind === 'outline_review' &&
      answer.action === 'revise' &&
      answer.feedback?.trim()
    ) {
      return { outlineFeedback: answer.feedback.trim().slice(0, 2000) };
    }
    const outline =
      answer?.kind === 'outline_review' && answer.action === 'confirm'
        ? sanitizeOutline(
            answer.outline,
            state.outline!,
            state.plan!.sections.map((section) => section.id),
            new Set(state.context!.figures.map((figure) => figure.key)),
          )
        : state.outline!;
    return {
      outline,
      outlineFeedback: null,
      input: { ...state.input, slideCount: outline.length },
    };
  };

  const writer = async (
    state: StudioStateType,
    config: LangGraphRunnableConfig,
  ): Promise<Update> => {
    const outline = state.outline!;
    const plan = state.plan!;
    const context = state.context!;
    const template = findTemplate(state.templateId, state.input.customTemplates);
    const figures = new Map(context.figures.map((figure) => [figure.key, figure]));
    activity(config, 'writer', 'start', `Writing ${outline.length} slides`, llm.models.writer);
    emit(config, {
      event: 'slides_init',
      data: { total: outline.length, templateId: template.id },
    });

    const slides: Array<StudioSlide | null> = outline.map(() => null);
    const groups = plan.sections
      .map((section) => ({
        section,
        items: outline.filter((item) => item.sectionId === section.id),
      }))
      .filter((group) => group.items.length);
    const grouped = new Set(groups.flatMap((group) => group.items.map((item) => item.index)));
    const orphans = outline.filter((item) => !grouped.has(item.index));
    if (orphans.length && groups.length) groups[groups.length - 1].items.push(...orphans);

    const finishSlide = async (item: StudioOutlineItem, raw: Record<string, unknown>) => {
      const slide = await buildSlide(state.input, item.index, item, raw, figures, null);
      slides[item.index] = slide;
      emit(config, { event: 'slide', data: { index: item.index, slide } });
    };

    await mapWithConcurrency(groups, WRITER_CONCURRENCY, async ({ section, items }) => {
      const excerpts = await deps.sectionExcerpts(state.input, context, section);
      const pending = new Set(items.map((item) => item.index));
      let chain: Promise<void> = Promise.resolve();
      const markNext = () => {
        const next = items.find((item) => pending.has(item.index));
        if (next) emit(config, { event: 'slide_writing', data: { index: next.index } });
      };
      markNext();
      await llm.ndjson(
        'writer',
        writerPrompt(
          state.input,
          state.analysis,
          plan,
          section,
          items,
          outline,
          excerpts,
          context.figures,
          template,
        ),
        (line) => {
          const requested = Number(line.n) - 1;
          const item =
            items.find((candidate) => candidate.index === requested && pending.has(requested)) ??
            items.find((candidate) => pending.has(candidate.index));
          if (!item) return;
          pending.delete(item.index);
          chain = chain.then(() => finishSlide(item, line)).then(markNext);
        },
        config.signal,
      );
      await chain;
      for (const item of items) {
        if (pending.has(item.index)) await finishSlide(item, {});
      }
    });

    activity(config, 'writer', 'done', `${slides.filter(Boolean).length} slides written`);
    const written = slides.map((slide, index) => slide ?? { title: outline[index].title });
    const cited = withReferencesSlide(written, context, state.input.language);
    cited.forEach((slide, index) => {
      if (slide !== written[index]) emit(config, { event: 'slide', data: { index, slide } });
    });
    return { slides: cited };
  };

  const illustrator = async (
    state: StudioStateType,
    config: LangGraphRunnableConfig,
  ): Promise<Update> => {
    const slides = (state.slides ?? []).map((slide) => ({ ...slide }));
    const outline = state.outline ?? [];
    const jobs = slides
      .map((slide, index) => {
        const item = outline[index];
        const wanted = item?.visual.kind === 'mermaid';
        const current = slide.diagram?.mermaid?.trim() || null;
        const problems = current ? mermaidProblems(current) : [];
        if (current && !problems.length) return null;
        if (!current && !wanted) return null;
        return {
          n: index + 1,
          title: String(slide.title ?? ''),
          idea:
            item?.visual.kind === 'mermaid'
              ? item.visual.idea
              : String(slide.diagram?.title || slide.title || ''),
          current,
          problems,
        };
      })
      .filter((job): job is NonNullable<typeof job> => !!job);

    if (!jobs.length) {
      activity(config, 'illustrator', 'info', 'All diagrams look valid');
      return {};
    }
    activity(
      config,
      'illustrator',
      'start',
      `Drawing/fixing ${jobs.length} diagram(s)`,
      llm.models.illustrator,
    );
    const fixed = new Set<number>();
    try {
      await llm.ndjson(
        'illustrator',
        illustratorPrompt(state.input, jobs),
        (line) => {
          const index = Number(line.n) - 1;
          const mermaid = typeof line.mermaid === 'string' ? line.mermaid.trim() : '';
          if (!slides[index] || !mermaid || mermaidProblems(mermaid).length) return;
          slides[index] = {
            ...slides[index],
            diagram: {
              title:
                (typeof line.title === 'string' && line.title.trim()) ||
                slides[index].diagram?.title ||
                String(slides[index].title ?? ''),
              mermaid,
              position: 'right',
              width: 48,
            } as StudioSlide['diagram'],
          };
          fixed.add(index);
          emit(config, { event: 'slide', data: { index, slide: slides[index] } });
        },
        config.signal,
      );
    } catch (error) {
      if (config.signal?.aborted) throw error;
      activity(config, 'illustrator', 'info', 'Diagram repair failed; broken diagrams removed');
    }
    for (const job of jobs) {
      const index = job.n - 1;
      if (fixed.has(index) || !job.current) continue;
      slides[index] = { ...slides[index], diagram: null };
      emit(config, { event: 'slide', data: { index, slide: slides[index] } });
    }
    activity(config, 'illustrator', 'done', `${fixed.size}/${jobs.length} diagrams ready`);
    return { slides };
  };

  const inspector = async (
    state: StudioStateType,
    config: LangGraphRunnableConfig,
  ): Promise<Update> => {
    const pass = (state.qa?.pass ?? 0) + 1;
    const judged = pass === 1;
    const recheck = (state.qa?.recheck ?? []).filter((index) => state.slides?.[index]);
    activity(
      config,
      'inspector',
      'start',
      judged
        ? `Inspecting ${state.slides?.length ?? 0} slides`
        : `Verifying ${recheck.length} rewritten slide(s)`,
      judged || recheck.length ? llm.models.inspector : undefined,
    );
    const fixes: string[] = [];
    const slides = (state.slides ?? []).map((slide, index) => {
      const repaired = repairSlideStructure(slide);
      if (!repaired.fixes.length) return slide;
      fixes.push(...repaired.fixes.map((fix) => `slide ${index + 1}: ${fix}`));
      emit(config, { event: 'slide', data: { index, slide: repaired.slide } });
      return repaired.slide;
    });
    if (fixes.length) {
      activity(config, 'inspector', 'info', `Auto-fixed ${fixes.length} structural issue(s) — ${fixes.slice(0, 3).join('; ')}`);
    }
    const profile = disciplineProfile(state.analysis?.profile);
    const automated = lintSlides(slides, state.input.language, profile);
    let findings: StudioQaFinding[] = automated;
    let draftScore = state.qa?.draftScore ?? null;
    if (judged) {
      try {
        const raw = await llm.json(
          'inspector',
          inspectorPrompt(
            state.input,
            state.plan!,
            slides,
            state.context?.excerpts ?? [],
            automated,
            profile,
          ),
          config.signal,
        );
        const inspection = coerceInspection(raw, slides.length);
        draftScore = inspection.score;
        findings = mergeFindings(automated, inspection.findings);
      } catch (error) {
        if (config.signal?.aborted) throw error;
        activity(config, 'inspector', 'info', 'AI inspection unavailable; using automated checks');
      }
    } else {
      // AI findings on slides that were not rewritten still stand.
      const rewritten = new Set(recheck);
      const carried = (state.qa?.findings ?? []).filter(
        (finding) => finding.source !== 'auto' && !rewritten.has(finding.slide - 1),
      );
      findings = mergeFindings(automated, carried);
      if (recheck.length) {
        const asked = problemsBySlide(state.qa?.findings ?? []);
        try {
          const raw = await llm.json(
            'inspector',
            verifierPrompt(
              state.input,
              slides,
              recheck.map((index) => ({ index, problems: asked.get(index) ?? [] })),
              state.context?.excerpts ?? [],
              profile,
            ),
            config.signal,
          );
          const verdict = coerceInspection(raw, slides.length).findings.filter((finding) =>
            rewritten.has(finding.slide - 1),
          );
          findings = mergeFindings(automated, [...carried, ...verdict]);
          const open = new Set(verdict.filter((finding) => finding.severity !== 'low').map((finding) => finding.slide));
          activity(
            config,
            'inspector',
            'info',
            open.size
              ? `${recheck.length - open.size}/${recheck.length} rewrite(s) verified; slide(s) ${[...open].sort((a, b) => a - b).join(', ')} still need work`
              : `All ${recheck.length} rewrite(s) verified`,
          );
        } catch (error) {
          if (config.signal?.aborted) throw error;
          activity(config, 'inspector', 'info', 'AI verification unavailable; using automated checks');
        }
      }
    }
    const targets =
      pass <= MAX_OPTIMIZE_PASSES && !state.qa?.reviewRevised
        ? pickOptimizeTargets(findings, MAX_OPTIMIZE_SLIDES)
        : [];
    if (!targets.length) {
      // Last chance before review: no slide may be published without text.
      const filled = new Set<number>();
      slides.forEach((slide, index) => {
        const next = { ...slide };
        if (!fillEmptySlideBody(next)) return;
        slides[index] = next;
        filled.add(index);
        emit(config, { event: 'slide', data: { index, slide: next } });
      });
      if (filled.size) {
        findings = mergeFindings(
          lintSlides(slides, state.input.language, profile),
          findings.filter((finding) => finding.source !== 'auto'),
        );
        activity(
          config,
          'inspector',
          'info',
          `Added explanatory text to ${filled.size} slide(s) that had none (${[...filled].map((i) => i + 1).join(', ')})`,
        );
      }
    }
    const qa: StudioQa = {
      pass,
      draftScore,
      findings,
      initialCount: state.qa?.initialCount ?? findings.length,
      targets,
      optimized: state.qa?.optimized ?? [],
      recheck: [],
      reviewRevised: state.qa?.reviewRevised ?? false,
    };
    emit(config, { event: 'qa', data: qa });
    activity(
      config,
      'inspector',
      'done',
      targets.length
        ? `${findings.length} issue(s); ${targets.length} slide(s) to optimize`
        : findings.length
          ? `${findings.length} minor issue(s) left`
          : 'No issues found',
    );
    return { qa, slides };
  };

  const optimizer = async (
    state: StudioStateType,
    config: LangGraphRunnableConfig,
  ): Promise<Update> => {
    const qa = state.qa!;
    const slides = [...(state.slides ?? [])];
    const outline = state.outline ?? [];
    const context = state.context!;
    const template = findTemplate(state.templateId, state.input.customTemplates);
    const figures = new Map(context.figures.map((figure) => [figure.key, figure]));
    const profile = disciplineProfile(state.analysis?.profile);
    const problems = problemsBySlide(qa.findings);
    const targets = qa.targets
      .filter((index) => slides[index])
      .map((index) => ({ index, problems: problems.get(index) ?? [] }));
    activity(
      config,
      'optimizer',
      'start',
      `Optimizing ${targets.length} slide(s)`,
      llm.models.optimizer,
    );

    const improved = new Set<number>();
    const kept = new Set<number>();
    const failed = new Set<number>();
    const batches: Array<typeof targets> = [];
    for (let i = 0; i < targets.length; i += OPTIMIZE_BATCH) {
      batches.push(targets.slice(i, i + OPTIMIZE_BATCH));
    }
    await mapWithConcurrency(batches, WRITER_CONCURRENCY, async (batch) => {
      const pending = new Set(batch.map((target) => target.index));
      const feedback = new Map<number, string>();
      const markNext = () => {
        const next = batch.find((target) => pending.has(target.index));
        if (next) emit(config, { event: 'slide_writing', data: { index: next.index } });
      };
      markNext();
      for (let attempt = 1; attempt <= OPTIMIZE_ATTEMPTS && pending.size; attempt++) {
        let chain: Promise<void> = Promise.resolve();
        let failure: unknown = null;
        const rejected = new Map<number, string[]>();
        try {
          await llm.ndjson(
            'optimizer',
            optimizerPrompt(
              state.input,
              state.plan!,
              template,
              slides,
              outline,
              batch
                .filter((target) => pending.has(target.index))
                .map((target) => {
                  const note = feedback.get(target.index);
                  return note ? { ...target, problems: [...target.problems, note] } : target;
                }),
              context.excerpts,
              context.figures,
              profile,
            ),
            (line) => {
              const index = Number(line.n) - 1;
              if (!pending.has(index)) return;
              pending.delete(index);
              chain = chain
                .then(async () => {
                  const candidate = await buildSlide(
                    state.input,
                    index,
                    outline[index],
                    line,
                    figures,
                    slides[index],
                  );
                  const trial = [...slides];
                  trial[index] = candidate;
                  const regressions = lintRegressions(slides, trial, index, state.input.language, profile);
                  if (regressions.length) {
                    rejected.set(index, regressions);
                    return;
                  }
                  slides[index] = candidate;
                  improved.add(index);
                  emit(config, { event: 'slide', data: { index, slide: slides[index] } });
                })
                .then(markNext);
            },
            config.signal,
          );
        } catch (error) {
          if (config.signal?.aborted) throw error;
          failure = error;
        }
        await chain;
        const canRetry = attempt < OPTIMIZE_ATTEMPTS;
        if (rejected.size) {
          const slideList = [...rejected.keys()].map((index) => index + 1).join(', ');
          const [firstIndex, firstReasons] = [...rejected.entries()][0];
          const why = `slide ${firstIndex + 1}: ${firstReasons[0].slice(0, 90)}`;
          activity(
            config,
            'optimizer',
            'info',
            canRetry
              ? `Rejected rewrite(s) of slide(s) ${slideList} that introduced new problems (${why}); retrying`
              : `Kept the original slide(s) ${slideList}: rewrites introduced new problems (${why})`,
          );
          for (const [index, regressions] of rejected) {
            if (canRetry) {
              pending.add(index);
              feedback.set(index, `REJECTED REWRITE: ${regressions.join(' ')}`);
            } else {
              kept.add(index);
            }
          }
        }
        const silent = [...pending].filter((index) => !rejected.has(index));
        if (!silent.length) continue;
        const { reason, retryable } = llmFailure(failure);
        const retry = retryable && canRetry;
        const slideList = silent.map((index) => index + 1).join(', ');
        activity(
          config,
          'optimizer',
          'info',
          retry
            ? `No rewrite for slide(s) ${slideList} (${reason}); retrying`
            : `Could not rewrite slide(s) ${slideList} (${reason}); keeping them for automatic repair`,
        );
        if (!retry) {
          silent.forEach((index) => {
            pending.delete(index);
            failed.add(index);
          });
        }
      }
      for (const index of [...pending, ...kept, ...failed]) {
        emit(config, { event: 'slide', data: { index, slide: slides[index] } });
      }
    });

    activity(
      config,
      'optimizer',
      'done',
      `${improved.size}/${targets.length} slide(s) improved${kept.size ? `, ${kept.size} kept as they were` : ''}`,
    );
    return {
      slides,
      qa: {
        ...qa,
        targets: [],
        optimized: [...new Set([...qa.optimized, ...improved])].sort((a, b) => a - b),
        recheck: [...improved].sort((a, b) => a - b),
      },
    };
  };

  const reviewer = async (
    state: StudioStateType,
    config: LangGraphRunnableConfig,
  ): Promise<Update> => {
    const qa = state.qa;
    const slides = state.slides ?? [];
    const revisionDone = Boolean(qa?.reviewRevised);
    activity(
      config,
      'reviewer',
      'start',
      revisionDone ? 'Re-scoring the revised deck' : 'Quality review',
      llm.models.reviewer,
    );
    try {
      const raw = await llm.json(
        'reviewer',
        reviewerPrompt(
          state.input,
          state.plan!,
          slides,
          state.context?.excerpts ?? [],
          disciplineProfile(state.analysis?.profile),
        ),
        config.signal,
      );
      const review = coerceReview(raw);
      emit(config, { event: 'review', data: review });
      const sendBack: StudioQaFinding[] = review.issues
        .filter(
          (issue) =>
            issue.slide != null &&
            issue.slide <= slides.length &&
            (issue.severity === 'high' || issue.severity === 'medium'),
        )
        .map((issue) => ({
          slide: issue.slide!,
          severity: issue.severity as StudioQaFinding['severity'],
          category: 'review',
          message: issue.message,
          source: 'ai',
        }));
      const targets = [...new Set(sendBack.map((finding) => finding.slide - 1))]
        .slice(0, MAX_REVIEW_REVISIONS)
        .sort((a, b) => a - b);
      if (qa && !revisionDone && targets.length) {
        activity(
          config,
          'reviewer',
          'done',
          `Score ${review.score}/100 — sending slide(s) ${targets.map((index) => index + 1).join(', ')} back for revision`,
        );
        return {
          review,
          qa: {
            ...qa,
            findings: mergeFindings(qa.findings, sendBack),
            targets,
            reviewRevised: true,
          },
        };
      }
      activity(config, 'reviewer', 'done', `Score ${review.score}/100`);
      return { review, qa: qa ? { ...qa, targets: [] } : qa };
    } catch (error) {
      if (config.signal?.aborted) throw error;
      activity(config, 'reviewer', 'info', 'Quality review skipped');
      return { review: state.review ?? null };
    }
  };

  const publisher = async (
    state: StudioStateType,
    config: LangGraphRunnableConfig,
  ): Promise<Update> => {
    activity(config, 'publisher', 'start', 'Saving the deck');
    const template = findTemplate(state.templateId, state.input.customTemplates);
    const input = state.input;
    const slides = withReferencesSlide(state.slides ?? [], state.context, input.language).map((slide) => {
      const { slide: repaired } = repairSlideStructure(slide);
      fillEmptySlideBody(repaired);
      return repaired;
    });
    const deck = fitSlideDeckToTarget(
      normalizeAndPaginateSlideDeck(
        {
          deckMeta: {
            courseTitle: input.courseTitle,
            topicTitle: input.topicTitle,
            topicNumber: input.topicNumber,
            designTheme: 'UNIVERSITY_ACADEMIC',
            ...templateDeckMeta(template),
            language: input.language,
            studio: {
              sessionId: input.sessionId,
              deckTitle: state.plan?.title ?? null,
              field: state.analysis?.field ?? null,
              profile: state.analysis?.profile ?? null,
              reviewScore: state.review?.score ?? null,
              draftScore: state.qa?.draftScore ?? null,
              qaIssuesFound: state.qa?.initialCount ?? 0,
              qaSlidesOptimized: state.qa?.optimized.length ?? 0,
              models: llm.models,
            },
          },
          slides,
        },
        {
          courseTitle: input.courseTitle,
          topicTitle: input.topicTitle,
          topicNumber: input.topicNumber,
        },
      ),
      slides.length,
    ) as Record<string, unknown>;
    await deps.saveDeck(input, deck);
    emit(config, { event: 'done', data: { deck } });
    activity(config, 'publisher', 'done', 'Deck saved');
    return { deck };
  };

  return new StateGraph(StudioState)
    .addNode('researcher', researcher)
    .addNode('analyst', analyst)
    .addNode('planner', planner)
    .addNode('plan_review', planReview)
    .addNode('designer', designer)
    .addNode('template_review', templateReview)
    .addNode('outliner', outliner)
    .addNode('outline_review', outlineReview)
    .addNode('writer', writer)
    .addNode('illustrator', illustrator)
    .addNode('inspector', inspector)
    .addNode('optimizer', optimizer)
    .addNode('reviewer', reviewer)
    .addNode('publisher', publisher)
    .addEdge(START, 'researcher')
    .addEdge('researcher', 'analyst')
    .addEdge('analyst', 'planner')
    .addEdge('planner', 'plan_review')
    .addConditionalEdges(
      'plan_review',
      (state) => (state.planFeedback ? 'planner' : 'designer'),
      ['planner', 'designer'],
    )
    .addEdge('designer', 'template_review')
    .addEdge('template_review', 'outliner')
    .addEdge('outliner', 'outline_review')
    .addConditionalEdges(
      'outline_review',
      (state) => (state.outlineFeedback ? 'outliner' : 'writer'),
      ['outliner', 'writer'],
    )
    .addEdge('writer', 'illustrator')
    .addEdge('illustrator', 'inspector')
    .addConditionalEdges(
      'inspector',
      (state) => (state.qa?.targets.length ? 'optimizer' : 'reviewer'),
      ['optimizer', 'reviewer'],
    )
    .addEdge('optimizer', 'inspector')
    .addConditionalEdges(
      'reviewer',
      (state) => (state.qa?.targets.length ? 'optimizer' : 'publisher'),
      ['optimizer', 'publisher'],
    )
    .addEdge('publisher', END)
    .compile({ checkpointer });
}

export type StudioGraph = ReturnType<typeof buildStudioGraph>;
