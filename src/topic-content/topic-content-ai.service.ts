import { ConfigService } from '@nestjs/config';
import { ContentType } from 'generated/prisma/enums';
import OpenAI from 'openai';
import { ContentGenerationJob } from './interfaces/content-generation-job.interface';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ErrorMessageKey } from 'src/common/constants/error-message';
import {
  LECTURE_PROMPT,
  QUIZ_PROMPT,
  LAB_PROMPT,
} from './prompts';
import { LECTURE_SYSTEM_PROMPT } from './prompts/lecture.prompt';
import {
  SLIDES_SYSTEM_PROMPT,
  SLIDES_PROMPT,
  SLIDES_CLOSING_PROMPT,
  SLIDES_MODULE_PROMPT,
  SLIDES_OPENING_PROMPT,
} from './prompts/slides.prompt';
import { LAB_SYSTEM_PROMPT } from './prompts/lab.prompt';
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

export type SlidesStreamProgress = {
  stage: 'prepare' | 'generate' | 'paginate' | 'done';
  percent: number;
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
        if (slide && typeof slide === 'object' && String(slide.title || '').trim()) {
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
    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0.35,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    });

    const text = response.choices[0]?.message?.content ?? '';
    return this.parseResponse(text);
  }

  private parseResponse(text: string): any {
    let clean = text
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    clean = clean.replace(/\\{2,}/g, '\\');
    clean = clean.replace(/\\([^"\\/bfnrtu\n\r])/g, (_, char) => `\\\\${char}`);

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
