import { ConfigService } from '@nestjs/config';
import { ContentType } from 'generated/prisma/enums';
import OpenAI from 'openai';
import { ContentGenerationJob } from './interfaces/content-generation-job.interface';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ErrorMessageKey } from 'src/common/constants/error-message';
import { OPENROUTER_MAX_OUTPUT_TOKENS } from 'src/common/constants/openrouter';
import { createChatCompletion } from 'src/common/helpers/openrouter-chat.helper';
import { LECTURE_PROMPT, QUIZ_PROMPT, LAB_PROMPT } from './prompts';
import { LECTURE_SYSTEM_PROMPT } from './prompts/lecture.prompt';
import {
  SLIDES_SYSTEM_PROMPT,
  SLIDES_PROMPT,
  SLIDES_CLOSING_PROMPT,
  SLIDES_MODULE_PROMPT,
  SLIDES_OPENING_PROMPT,
} from './prompts/slides.prompt';
import {
  LAB_CLOSING_PROMPT,
  LAB_OVERVIEW_PROMPT,
  LAB_PLAN_PROMPT,
  LAB_SECTION_PROMPT,
  LAB_SYSTEM_PROMPT,
} from './prompts/lab.prompt';
import { QUIZ_SYSTEM_PROMPT } from './prompts/quiz.prompt';
import {
  LECTURE_CLOSING_PROMPT,
  LECTURE_MODULE_PROMPT,
  LECTURE_OVERVIEW_PROMPT,
  LECTURE_PLAN_PROMPT,
  LECTURE_STREAM_SYSTEM,
} from './prompts/lecture-stream.prompt';
import {
  compactLectureForSlides,
  normalizeAndPaginateSlideDeck,
  fitSlideDeckToTarget,
  resolveSlideBudget,
  type SlideDeckSlide,
} from './utils/slide-deck.util';

export type LectureStreamProgress = {
  stage: 'plan' | 'overview' | 'module' | 'assessment' | 'done';
  percent: number;
  moduleIndex?: number;
  moduleCount?: number;
  message: string;
  partial: Record<string, unknown>;
};

type LectureDiagram = {
  title: string;
  mermaid: string;
  explanation: string;
};

/**
 * Keep the diagrams authored during lecture generation as the source of truth
 * for slides. The recursive fallback also supports older lecture payloads
 * whose visual blocks were nested under a slightly different key.
 */
function extractLectureDiagrams(source: unknown): LectureDiagram[] {
  const diagrams: LectureDiagram[] = [];
  const seen = new Set<string>();

  const visit = (value: unknown, depth = 0) => {
    if (!value || depth > 12) return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;

    const record = value as Record<string, unknown>;
    const code =
      record.mermaidDiagramCode ??
      record.mermaid ??
      record.diagramCode ??
      (typeof record.diagram === 'string' ? record.diagram : null);
    if (typeof code === 'string' && code.trim()) {
      const mermaid = code.trim();
      const signature = mermaid.replace(/\s+/g, ' ');
      if (!seen.has(signature)) {
        seen.add(signature);
        diagrams.push({
          title: String(
            record.diagramTitle ??
              record.title ??
              record.name ??
              `Lecture diagram ${diagrams.length + 1}`,
          ).trim(),
          mermaid,
          explanation: String(
            record.diagramPedagogicalExplanation ?? record.explanation ?? '',
          ).trim(),
        });
      }
    }

    Object.values(record).forEach((item) => {
      if (item && typeof item === 'object') visit(item, depth + 1);
    });
  };

  visit(source);
  return diagrams;
}

function addLectureDiagramsToDeck(
  slides: SlideDeckSlide[],
  sourceLecture: unknown,
  targetSlides: number,
): void {
  const available = extractLectureDiagrams(sourceLecture);
  if (!available.length || !slides.length) return;

  // A 16-slide lecture normally benefits from two diagrams; longer decks can
  // use three. Do not turn a short deck into a gallery.
  const desired = Math.min(
    available.length,
    Math.max(1, Math.min(3, Math.ceil(targetSlides / 8))),
  );
  const chosen = Array.from({ length: desired }, (_, index) => {
    const sourceIndex =
      desired === 1
        ? 0
        : Math.round((index * (available.length - 1)) / (desired - 1));
    return available[sourceIndex];
  });

  const eligible = slides
    .map((slide, index) => ({ slide, index }))
    .filter(({ slide }) => {
      const type = String(slide.type || '').toUpperCase();
      return ![
        'TITLE',
        'SECTION',
        'SECTION_DIVIDER',
        'AGENDA',
        'LEARNING_OUTCOMES',
        'REFERENCES',
      ].includes(type);
    });
  if (!eligible.length) return;

  chosen.forEach((diagram, index) => {
    const position =
      chosen.length === 1
        ? Math.floor(eligible.length / 2)
        : Math.round((index * (eligible.length - 1)) / (chosen.length - 1));
    const target = eligible[position]?.slide;
    if (!target) return;

    target.type = 'DIAGRAM';
    target.layout = 'BULLETS';
    target.diagram = {
      title: diagram.title || `Lecture diagram ${index + 1}`,
      mermaid: diagram.mermaid,
    };
    if (diagram.explanation) {
      target.speakerNotes = [
        String(target.speakerNotes || '').trim(),
        diagram.explanation,
      ]
        .filter(Boolean)
        .join('\n\n');
    }
  });
}

export type SlidesStreamProgress = {
  stage: 'prepare' | 'generate' | 'paginate' | 'done';
  percent: number;
  message: string;
  partial: Record<string, unknown>;
};

export type LabStreamProgress = {
  stage: 'plan' | 'overview' | 'section' | 'closing' | 'done';
  percent: number;
  sectionIndex?: number;
  sectionCount?: number;
  message: string;
  partial: Record<string, unknown>;
};

@Injectable()
export class TopicContentAiService {
  private readonly client: OpenAI;
  private readonly model: string;
  constructor(private readonly config: ConfigService) {
    this.client = new OpenAI({
      apiKey: this.config.get<string>('OPENROUTER_API_KEY'),
      baseURL: this.config.get<string>('OPENROUTER_BASE_URL'),
    });
    this.model = this.config.get<string>('OPENROUTER_MODEL')!;
  }

  async generate(type: ContentType, data: ContentGenerationJob): Promise<any> {
    if (type === 'LECTURE') {
      // Prefer generateLectureStreaming from the processor so progress can stream.
      return this.generateLectureStreaming(data);
    }

    if (type === 'SLIDES') {
      return this.generateSlides(data);
    }

    if (type === 'LAB') {
      return this.generateLabStreaming(data);
    }

    const promptMap: Partial<Record<ContentType, string>> = {
      QUIZ: QUIZ_PROMPT(data),
      LAB: LAB_PROMPT(data),
      LECTURE: LECTURE_PROMPT(data),
    };

    const systemMap: Partial<Record<ContentType, string>> = {
      LECTURE: LECTURE_SYSTEM_PROMPT,
      QUIZ: QUIZ_SYSTEM_PROMPT,
      LAB: LAB_SYSTEM_PROMPT,
    };

    const prompt = promptMap[type];
    if (!prompt)
      throw new BadRequestException(`Content type ${type} not supported yet`);

    return this.chatJson(
      systemMap[type] ??
        'You are an experienced university lecturer. Return valid JSON only.',
      prompt,
    );
  }

  async generateSlides(
    data: ContentGenerationJob,
    onProgress?: (progress: SlidesStreamProgress) => Promise<void> | void,
  ): Promise<Record<string, unknown>> {
    const emit = async (progress: SlidesStreamProgress) => {
      if (onProgress) await onProgress(progress);
    };

    const deckMeta = {
      courseTitle: data.courseTitle,
      topicTitle: data.topicTitle,
      topicNumber: data.topicNumber,
      designTheme: 'UNIVERSITY_ACADEMIC',
      audience: data.audience,
      difficulty: data.difficulty,
    };

    const buildPartial = (
      slides: SlideDeckSlide[],
      streamStatus: string,
      extra: Record<string, unknown> = {},
    ) => ({
      source: 'gradx',
      provider: 'openrouter',
      streamStatus,
      deckMeta,
      totalSlides: slides.length,
      slides: slides.map((slide, index) => ({
        ...slide,
        slideNumber: index + 1,
      })),
      ...extra,
    });

    await emit({
      stage: 'prepare',
      percent: 5,
      message: 'Preparing lecture content for slide design…',
      partial: buildPartial([], 'prepare'),
    });

    const compactLecture = compactLectureForSlides(data.sourceLectureContent);
    const slidesJob: ContentGenerationJob = {
      ...data,
      sourceLectureContent: compactLecture,
    };
    const modules = Array.isArray((compactLecture as any)?.modules)
      ? ((compactLecture as any).modules as Record<string, unknown>[])
      : [];
    const moduleCount = Math.max(1, modules.length);
    const budget = resolveSlideBudget(data.slidesLength, modules.length);

    const accumulated: SlideDeckSlide[] = [];
    const appendSlides = (raw: unknown) => {
      const list = Array.isArray((raw as any)?.slides)
        ? ((raw as any).slides as SlideDeckSlide[])
        : Array.isArray(raw)
          ? (raw as SlideDeckSlide[])
          : [];
      for (const slide of list) {
        if (
          slide &&
          typeof slide === 'object' &&
          String(slide.title || '').trim()
        ) {
          accumulated.push(slide);
        }
      }
    };

    await emit({
      stage: 'generate',
      percent: 12,
      message: `Designing title, outcomes, and agenda (target ${budget.target} slides)…`,
      partial: buildPartial(accumulated, 'generate-opening'),
    });

    const openingRaw = await this.chatJson(
      SLIDES_SYSTEM_PROMPT,
      SLIDES_OPENING_PROMPT(slidesJob, budget.opening),
    );
    appendSlides(openingRaw);
    await emit({
      stage: 'generate',
      percent: 22,
      message: `Opening ready · ${accumulated.length} slides`,
      partial: buildPartial(accumulated, 'opening-done'),
    });

    if (modules.length === 0) {
      // Fallback: one-shot full deck when lecture has no modules
      await emit({
        stage: 'generate',
        percent: 40,
        message: 'Generating full teaching deck…',
        partial: buildPartial(accumulated, 'generate-full'),
      });
      const rawDeck = await this.chatJson(
        SLIDES_SYSTEM_PROMPT,
        SLIDES_PROMPT(slidesJob),
      );
      accumulated.length = 0;
      appendSlides(rawDeck);
    } else {
      for (let i = 0; i < modules.length; i++) {
        const module = modules[i];
        const moduleIndex = i + 1;
        const basePercent = 22 + Math.round((i / moduleCount) * 55);
        await emit({
          stage: 'generate',
          percent: Math.min(basePercent, 78),
          message: `Designing slides for module ${moduleIndex}/${moduleCount}…`,
          partial: buildPartial(accumulated, `module-${moduleIndex}`),
        });

        const moduleRaw = await this.chatJson(
          SLIDES_SYSTEM_PROMPT,
          SLIDES_MODULE_PROMPT(
            slidesJob,
            module,
            moduleIndex,
            moduleCount,
            budget.perModule + (i < budget.remainder ? 1 : 0),
          ),
        );
        appendSlides(moduleRaw);
        await emit({
          stage: 'generate',
          percent: Math.min(basePercent + Math.round(55 / moduleCount), 82),
          message: `Module ${moduleIndex} ready · ${accumulated.length} slides`,
          partial: buildPartial(accumulated, `module-${moduleIndex}-done`),
        });
      }

      await emit({
        stage: 'generate',
        percent: 86,
        message: 'Writing summary and next steps…',
        partial: buildPartial(accumulated, 'generate-closing'),
      });
      const closingRaw = await this.chatJson(
        SLIDES_SYSTEM_PROMPT,
        SLIDES_CLOSING_PROMPT(slidesJob, budget.closing),
      );
      appendSlides(closingRaw);
      await emit({
        stage: 'generate',
        percent: 90,
        message: `Closing ready · ${accumulated.length} slides`,
        partial: buildPartial(accumulated, 'closing-done'),
      });
    }

    await emit({
      stage: 'paginate',
      percent: 94,
      message: 'Applying professional slide pagination…',
      partial: buildPartial(accumulated, 'paginate'),
    });

    const deck = fitSlideDeckToTarget(
      normalizeAndPaginateSlideDeck(
        { deckMeta, slides: accumulated },
        {
          courseTitle: data.courseTitle,
          topicTitle: data.topicTitle,
          topicNumber: data.topicNumber,
        },
      ),
      data.slidesLength ?? budget.target,
    );

    // Guarantee at least one usable instructional diagram even when the model
    // ignores the visual requirement. Keep the syntax deliberately simple so
    // Mermaid can render it consistently in browser, PDF and PowerPoint.
    const deckSlides = Array.isArray(deck.slides) ? deck.slides : [];
    addLectureDiagramsToDeck(
      deckSlides,
      data.sourceLectureContent,
      budget.target,
    );
    const hasDiagram = deckSlides.some(
      (slide) => String(slide?.diagram?.mermaid || '').trim().length > 0,
    );
    if (!hasDiagram) {
      const diagramTarget =
        deckSlides.find(
          (slide) =>
            String(slide.type || '').toUpperCase() === 'CONTENT' &&
            String(slide.layout || '').toUpperCase() !== 'SECTION_DIVIDER',
        ) ||
        deckSlides.find(
          (slide) =>
            !['TITLE', 'SECTION', 'SECTION_DIVIDER'].includes(
              String(slide.type || '').toUpperCase(),
            ),
        );

      if (diagramTarget) {
        const labels = (
          modules.length
            ? modules
                .map((module) => String(module?.title || '').trim())
                .filter(Boolean)
                .slice(0, 5)
            : ['Foundation', 'Method', 'Application']
        ).map((label) =>
          label
            .replace(/["[\]{}<>]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 42),
        );
        const nodes = labels.map(
          (label, index) => `N${index + 1}["${label || `Step ${index + 1}`}"]`,
        );
        const edges = labels
          .slice(0, -1)
          .map((_, index) => `N${index + 1} --> N${index + 2}`);
        diagramTarget.diagram = {
          title: 'Concept progression',
          mermaid: ['flowchart LR', ...nodes, ...edges].join('\n'),
        };
      }
    }

    await emit({
      stage: 'done',
      percent: 100,
      message: `Slide deck ready (${deck.totalSlides} slides)`,
      partial: deck,
    });

    return deck;
  }

  async generateLectureStreaming(
    data: ContentGenerationJob,
    onProgress?: (progress: LectureStreamProgress) => Promise<void> | void,
  ): Promise<Record<string, unknown>> {
    const emit = async (progress: LectureStreamProgress) => {
      if (onProgress) await onProgress(progress);
    };

    await emit({
      stage: 'plan',
      percent: 5,
      message: 'Planning lecture structure…',
      partial: {
        metadata: {
          targetTopic: data.topicTitle,
          noteType: data.courseNoteType,
          audienceTier: data.audience,
          depthProfile: data.contentDepth,
          difficultyLevel: data.difficulty,
          qualityComplianceMode: data.aiQualityMode,
        },
        lectureOverview: null,
        modules: [],
        comprehensiveAssessment: [],
        providedReferences: [],
        streamStatus: 'planning',
      },
    });

    const planRaw = await this.chatJson(
      LECTURE_STREAM_SYSTEM,
      LECTURE_PLAN_PROMPT(data),
    );
    const planModules = this.normalizePlanModules(planRaw);
    const moduleCount = planModules.length;

    let partial: Record<string, unknown> = {
      metadata: {
        targetTopic: data.topicTitle,
        noteType: data.courseNoteType,
        audienceTier: data.audience,
        depthProfile: data.contentDepth,
        difficultyLevel: data.difficulty,
        qualityComplianceMode: data.aiQualityMode,
      },
      lectureOverview: null,
      modules: [],
      comprehensiveAssessment: [],
      providedReferences: [],
      streamStatus: 'overview',
      plannedModules: planModules,
    };

    await emit({
      stage: 'overview',
      percent: 15,
      moduleCount,
      message: 'Writing lecture overview…',
      partial,
    });

    const overviewRaw = await this.chatJson(
      LECTURE_STREAM_SYSTEM,
      LECTURE_OVERVIEW_PROMPT(data, { modules: planModules }),
    );

    partial = {
      ...partial,
      metadata: overviewRaw?.metadata ?? partial.metadata,
      lectureOverview: overviewRaw?.lectureOverview ?? null,
      streamStatus: 'modules',
    };

    await emit({
      stage: 'overview',
      percent: 25,
      moduleCount,
      message: 'Overview ready. Generating modules…',
      partial,
    });

    const modules: any[] = [];
    for (let i = 0; i < planModules.length; i++) {
      const planModule = planModules[i];
      const percent = 25 + Math.round(((i + 1) / (moduleCount + 1)) * 60);

      await emit({
        stage: 'module',
        percent: Math.min(percent - 5, 85),
        moduleIndex: planModule.moduleIndex,
        moduleCount,
        message: `Generating module ${planModule.moduleIndex} of ${moduleCount}: ${planModule.title}`,
        partial: {
          ...partial,
          modules: [...modules],
          streamStatus: `module_${planModule.moduleIndex}`,
        },
      });

      const moduleRaw = await this.chatJson(
        LECTURE_STREAM_SYSTEM,
        LECTURE_MODULE_PROMPT(
          data,
          planModule,
          modules.map((m) => String(m?.title ?? '')),
        ),
      );

      const moduleObj = {
        ...moduleRaw,
        moduleIndex: planModule.moduleIndex,
        title: moduleRaw?.title || planModule.title,
      };
      modules.push(moduleObj);

      partial = {
        ...partial,
        modules: [...modules],
        streamStatus: `module_${planModule.moduleIndex}_done`,
      };

      await emit({
        stage: 'module',
        percent: Math.min(percent, 88),
        moduleIndex: planModule.moduleIndex,
        moduleCount,
        message: `Module ${planModule.moduleIndex} of ${moduleCount} ready`,
        partial,
      });
    }

    await emit({
      stage: 'assessment',
      percent: 92,
      moduleCount,
      message: 'Writing assessment and references…',
      partial: { ...partial, streamStatus: 'assessment' },
    });

    const closingRaw = await this.chatJson(
      LECTURE_STREAM_SYSTEM,
      LECTURE_CLOSING_PROMPT(
        data,
        modules.map((m) => ({
          moduleIndex: Number(m.moduleIndex),
          title: String(m.title ?? ''),
        })),
      ),
    );

    const finalContent: Record<string, unknown> = {
      ...partial,
      comprehensiveAssessment: closingRaw?.comprehensiveAssessment ?? [],
      providedReferences: closingRaw?.providedReferences ?? [],
      streamStatus: 'done',
    };
    delete finalContent.plannedModules;
    delete finalContent.academicReviewVerification;

    await emit({
      stage: 'done',
      percent: 100,
      moduleCount,
      message: 'Lecture generation complete',
      partial: finalContent,
    });

    return finalContent;
  }

  async generateLabStreaming(
    data: ContentGenerationJob,
    onProgress?: (progress: LabStreamProgress) => Promise<void> | void,
  ): Promise<Record<string, unknown>> {
    const emit = async (progress: LabStreamProgress) => {
      if (onProgress) await onProgress(progress);
    };
    const base = {
      source: 'gradx',
      provider: 'openrouter',
      title: `Lab Manual: ${data.topicTitle}`,
      objective: '',
      estimatedDuration: '',
      prerequisites: [],
      tools: [],
      setupNotes: [],
      sections: [],
      stretchChallenge: '',
      deliverables: [],
      gradingCriteria: [],
      totalPoints: 100,
    };

    await emit({
      stage: 'plan',
      percent: 5,
      message: 'Planning lab activities…',
      partial: { ...base, streamStatus: 'planning' },
    });

    const planRaw = await this.chatJson(
      LAB_SYSTEM_PROMPT,
      LAB_PLAN_PROMPT(data),
    );
    const rawSections = Array.isArray(planRaw?.sections)
      ? planRaw.sections
      : [];
    const plannedSections = rawSections
      .slice(0, 5)
      .map((section: any, index: number) => ({
        sectionNumber: index + 1,
        title: String(section?.title || `Lab activity ${index + 1}`).trim(),
        cloCode: String(section?.cloCode || '').trim(),
      }))
      .filter((section: { title: string }) => Boolean(section.title));
    if (!plannedSections.length) {
      plannedSections.push(
        { sectionNumber: 1, title: 'Guided implementation', cloCode: '' },
        { sectionNumber: 2, title: 'Verification and analysis', cloCode: '' },
        { sectionNumber: 3, title: 'Applied challenge', cloCode: '' },
      );
    }

    let partial: Record<string, unknown> = {
      ...base,
      title: String(planRaw?.title || base.title),
      streamStatus: 'overview',
    };
    await emit({
      stage: 'overview',
      percent: 15,
      sectionCount: plannedSections.length,
      message: 'Writing objectives and setup…',
      partial,
    });

    const overview = await this.chatJson(
      LAB_SYSTEM_PROMPT,
      LAB_OVERVIEW_PROMPT(data, {
        title: partial.title,
        sections: plannedSections,
      }),
    );
    partial = {
      ...partial,
      ...overview,
      sections: [],
      streamStatus: 'sections',
    };
    await emit({
      stage: 'overview',
      percent: 25,
      sectionCount: plannedSections.length,
      message: 'Setup ready. Building lab activities…',
      partial,
    });

    const sections: Record<string, unknown>[] = [];
    for (let index = 0; index < plannedSections.length; index += 1) {
      const plan = plannedSections[index];
      const startPercent =
        25 + Math.round((index / plannedSections.length) * 60);
      await emit({
        stage: 'section',
        percent: startPercent,
        sectionIndex: index + 1,
        sectionCount: plannedSections.length,
        message: `Generating activity ${index + 1} of ${plannedSections.length}: ${plan.title}`,
        partial: {
          ...partial,
          sections: [...sections],
          streamStatus: `section_${index + 1}`,
        },
      });

      const generated = await this.chatJson(
        LAB_SYSTEM_PROMPT,
        LAB_SECTION_PROMPT(data, plan),
      );
      sections.push({
        ...generated,
        sectionNumber: index + 1,
        title: generated?.title || plan.title,
        cloCode: generated?.cloCode || plan.cloCode,
      });
      partial = {
        ...partial,
        sections: [...sections],
        streamStatus: `section_${index + 1}_done`,
      };
      await emit({
        stage: 'section',
        percent: 25 + Math.round(((index + 1) / plannedSections.length) * 60),
        sectionIndex: index + 1,
        sectionCount: plannedSections.length,
        message: `Activity ${index + 1} of ${plannedSections.length} ready`,
        partial,
      });
    }

    await emit({
      stage: 'closing',
      percent: 90,
      sectionCount: plannedSections.length,
      message: 'Creating deliverables and grading rubric…',
      partial: { ...partial, streamStatus: 'closing' },
    });
    const closing = await this.chatJson(
      LAB_SYSTEM_PROMPT,
      LAB_CLOSING_PROMPT(data, plannedSections),
    );
    const finalContent = {
      ...partial,
      ...closing,
      sections,
      streamStatus: 'done',
    };
    await emit({
      stage: 'done',
      percent: 100,
      sectionCount: plannedSections.length,
      message: 'Lab manual generation complete',
      partial: finalContent,
    });
    return finalContent;
  }

  private normalizePlanModules(planRaw: any): Array<{
    moduleIndex: number;
    title: string;
  }> {
    const rawModules = Array.isArray(planRaw?.modules) ? planRaw.modules : [];
    let modules = rawModules
      .map((m: any, index: number) => ({
        moduleIndex: Number(m?.moduleIndex) || index + 1,
        title: String(m?.title ?? `Module ${index + 1}`).trim(),
      }))
      .filter((m: { title: string }) => m.title.length > 0);

    if (modules.length === 0) {
      modules = [
        { moduleIndex: 1, title: 'Core Concepts and Definitions' },
        { moduleIndex: 2, title: 'Methods and Worked Applications' },
        { moduleIndex: 3, title: 'Analysis, Edge Cases, and Practice' },
      ];
    }

    const count = Math.min(
      5,
      Math.max(2, Number(planRaw?.moduleCount) || modules.length),
    );
    return modules.slice(0, count).map((m, index) => ({
      moduleIndex: index + 1,
      title: m.title,
    }));
  }

  private async chatJson(system: string, prompt: string): Promise<any> {
    const response = await createChatCompletion(this.client, {
      model: this.model,
      temperature: 0.35,
      max_tokens: OPENROUTER_MAX_OUTPUT_TOKENS,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    });

    const text = response.choices[0]?.message?.content ?? '';
    return this.parseResponse(text);
  }

  /**
   * Models write LaTeX inside JSON strings with single backslashes, and
   * `\frac`, `\theta`, `\beta` happen to be the valid JSON escapes `\f`, `\t`
   * and `\b`. Parsing those as-is silently replaces the macro with a control
   * character, so only escapes we actually expect from a model (`\" \\ \/ \n
   * \r \uXXXX`) are preserved and every other backslash is doubled.
   */
  private repairJsonEscapes(input: string): string {
    return input.replace(
      /\\(u[0-9a-fA-F]{4}|[\s\S]|$)/g,
      (match, seq: string) =>
        /^(?:["\\/nr]|u[0-9a-fA-F]{4})$/.test(seq) ? match : `\\\\${seq}`,
    );
  }

  private parseResponse(text: string): any {
    const clean = this.repairJsonEscapes(
      text
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim(),
    );

    try {
      return JSON.parse(clean);
    } catch (e) {
      const pos = parseInt(e.message.match(/position (\d+)/)?.[1] ?? '0');
      console.log(
        'CONTEXT:',
        JSON.stringify(clean.substring(pos - 50, pos + 50)),
      );
      throw new BadRequestException(ErrorMessageKey.GENERATION_AI_INVALID_JSON);
    }
  }
}
