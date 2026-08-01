import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { PrismaService } from 'prisma/prisma.service';
import { GenerateAssessmentDto } from './dto/generate-assessment.dto';
import OpenAI from 'openai';
import { ConfigService } from '@nestjs/config';
import { GENERATE_COURSE_PROMPT, GENERATE_SINGLE_QUESTION_PROMPT } from './prompts/generate-assessment.prompt';
import { CreateAssessmentDto } from './dto/create-assessment.dto';
import { UpdateAssessmentDto } from './dto/update-assessment.dto.ts';
import { AddQuestionDto, UpdateQuestionDto } from './dto/question.dto';
import { ACTIVE_GENERATION_QUESTION_TYPES } from './config/question-types.config';
import { AssessmentType, Bloom, Prisma } from 'generated/prisma/client';
import { requireTenantId } from 'src/common/helpers/require-tenant.helper';
import { ErrorMessageKey } from 'src/common/constants/error-message';
import { OPENROUTER_MAX_OUTPUT_TOKENS } from 'src/common/constants/openrouter';
import { createChatCompletion } from 'src/common/helpers/openrouter-chat.helper';
import { generationErrorPayload } from 'src/common/helpers/generation-error.helper';
import {
  AssessmentGenerationJob,
  AssessmentGenerationProgress,
} from './interfaces/assessment-generation-job.interface';

const toPrismaJson = (
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
};

const withPrismaJsonFields = <T extends Record<string, unknown>>(data: T) => {
  if (!('headerConfig' in data) && !('generationConfig' in data)) {
    return data;
  }

  const next: Record<string, unknown> = { ...data };
  if ('headerConfig' in next) {
    next.headerConfig = toPrismaJson(next.headerConfig);
  }
  if ('generationConfig' in next) {
    next.generationConfig = toPrismaJson(next.generationConfig);
  }
  return next as T;
};

@Injectable()
export class AssessmentService {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    @InjectQueue('assessment-generation')
    private readonly assessmentQueue: Queue,
  ) {
    this.client = new OpenAI({
      apiKey: this.config.get<string>('OPENROUTER_API_KEY'),
      baseURL: this.config.get<string>('OPENROUTER_BASE_URL'),
    });
    this.model = this.config.get<string>('OPENROUTER_MODEL')!;
  }

  /**
   * 1. Create Assessment Metadata Shell Only
   */
  async create(tenantId: number, courseId: number, dto: CreateAssessmentDto) {
    const tid = requireTenantId(tenantId);
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, tenantId: tid },
      select: { id: true },
    });
    if (!course) {
      throw new NotFoundException('Course not found');
    }

    return await this.prisma.assessment.create({
      data: {
        title: dto.title,
        type: dto.type,
        timing: dto.timing ?? null,
        percentage: dto.percentage ?? null,
        duration: dto.duration,
        totalMarks: dto.totalMarks,
        passMark: dto.passMark,
        numberOfVersions: dto.numberOfVersions,
        paperSize: dto.paperSize,
        answerSheetMode: dto.answerSheetMode,
        showMarksPerQuestion: dto.showMarksPerQuestion,
        includeStudentInfoHeader: dto.includeStudentInfoHeader,
        studentIdLabel: dto.studentIdLabel,
        numberOfStudentIdDigits: dto.numberOfStudentIdDigits,
        includeAssessmentInstructionsSection:
          dto.includeAssessmentInstructionsSection,
        assessmentInstructions: dto.assessmentInstructions,
        printCloCodeNextToEachQuestion: dto.printCloCodeNextToEachQuestion,
        printBloomLevelNextToEachQuestion:
          dto.printBloomLevelNextToEachQuestion,
        printDifficultyLabelNextToEachQuestion:
          dto.printDifficultyLabelNextToEachQuestion,
        headerConfig: toPrismaJson(dto.headerConfig),
        language: dto.language,
        difficulty: dto.difficulty,
        tenantId: tid,
        courseId,
      },
    });
  }

  /**
   * 2. Orchestrated Generator: enqueue async job and return immediately
   */
  async generate(
    tenantId: number,
    courseId: number,
    assessmentId: number,
    dto: GenerateAssessmentDto,
  ) {
    const targetAssessment = await this.prisma.assessment.findFirst({
      where: { id: assessmentId, tenantId, courseId },
    });

    if (!targetAssessment) {
      throw new NotFoundException(ErrorMessageKey.ASSESSMENT_SHELL_NOT_FOUND);
    }

    const jobPayload: AssessmentGenerationJob = {
      tenantId,
      courseId,
      assessmentId,
      dto,
    };

    const job = await this.assessmentQueue.add(
      'assessment-generation',
      jobPayload,
      {
        attempts: 2,
        removeOnComplete: false,
        removeOnFail: false,
      },
    );

    return {
      jobId: job.id,
      status: 'processing',
      assessmentId,
      courseId,
    };
  }

  async getGenerateStatus(jobId: string) {
    const job = await this.assessmentQueue.getJob(jobId);

    if (!job) throw new NotFoundException(ErrorMessageKey.GENERATION_JOB_NOT_FOUND);

    const state = await job.getState();
    const failure = generationErrorPayload(
      state === 'failed' ? job.failedReason : null,
      ErrorMessageKey.ASSESSMENT_GENERATE_FAILED,
    );

    return {
      jobId,
      status: state,
      progress: job.progress,
      result: state === 'completed' ? job.returnvalue : null,
      error: failure.error,
      errorKey: failure.errorKey,
    };
  }

  async runGenerationJob(
    data: AssessmentGenerationJob,
    onProgress?: (progress: AssessmentGenerationProgress) => Promise<void> | void,
  ) {
    const expectedQuestionCount = this.countExpectedQuestions(data.dto);
    const append = Boolean(data.dto.append);

    const report = async (progress: AssessmentGenerationProgress) => {
      if (onProgress) await onProgress(progress);
    };

    await report({
      stage: 'preparing',
      percent: 5,
      message: append
        ? 'Preparing to add questions to existing assessment…'
        : 'Preparing assessment context…',
      expectedQuestionCount,
      savedQuestionCount: 0,
    });

    const promptPayload = await this.preparePromptPayload(data.dto);
    const assessmentMeta = await this.resetAssessmentShell(
      data.tenantId,
      data.courseId,
      data.assessmentId,
      data.dto,
      append,
    );

    const existingQuestions = append
      ? await this.prisma.question.findMany({
          where: { assessmentId: data.assessmentId },
          include: {
            questionOptions: { orderBy: { order: 'asc' } },
            questionClos: {
              include: {
                Clo: { select: { id: true, code: true } },
              },
            },
          },
          orderBy: { id: 'asc' },
        })
      : [];

    const units = this.buildGenerationUnits(promptPayload.topicGenerations);
    const accumulatedQuestions: any[] = existingQuestions.map((question) => {
      const cloCodes = (question.questionClos || [])
        .map((link) => String(link.Clo?.code || '').trim())
        .filter(Boolean);
      return {
        id: question.id,
        text: question.text,
        type: question.type,
        explanation: question.explanation,
        points: question.points,
        topicId: question.topicId,
        cloCode: cloCodes[0] || null,
        cloCodes,
        clo: cloCodes[0] || null,
        questionClos: question.questionClos,
        questionOptions: question.questionOptions,
        options:
          question.questionOptions?.map((opt) => ({
            text: opt.text,
            isCorrect: opt.isCorrect,
            order: opt.order,
          })) ?? [],
      };
    });
    const savedQuestionIds: { id: number }[] = existingQuestions.map((q) => ({
      id: q.id,
    }));
    const existingQuestionTexts = accumulatedQuestions.map((q) =>
      String(q?.text || ''),
    );
    const totalUnits = units.length || expectedQuestionCount || 1;
    const baselineCount = accumulatedQuestions.length;

    for (let index = 0; index < units.length; index++) {
      const unit = units[index];
      const questionNumber = index + 1;
      const percent = Math.min(
        92,
        Math.round(8 + (questionNumber / totalUnits) * 84),
      );

      await report({
        stage: 'generating',
        percent,
        message: append
          ? `Adding question ${questionNumber} of ${totalUnits}…`
          : `Generating question ${questionNumber} of ${totalUnits}…`,
        expectedQuestionCount: baselineCount + totalUnits,
        savedQuestionCount: accumulatedQuestions.length,
        partial: { questions: accumulatedQuestions },
      });

      let nextQuestion: any = null;
      let lastQuestionError: unknown = null;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const aiRawResponse = await this.callAiModelForSingleQuestion({
            assessment: promptPayload.assessment,
            topicGeneration: unit.topicGeneration,
            questionType: unit.questionType,
            questionIndex: questionNumber,
            totalQuestions: totalUnits,
            existingQuestionTexts: [
              ...existingQuestionTexts,
              ...accumulatedQuestions
                .slice(baselineCount)
                .map((q) => String(q?.text || '')),
            ],
          });

          const generatedData = this.parseAiResponse(aiRawResponse);
          nextQuestion = this.extractGeneratedQuestion(generatedData);

          if (nextQuestion && typeof nextQuestion === 'object') {
            break;
          }

          lastQuestionError = ErrorMessageKey.ASSESSMENT_AI_QUESTION_FAILED;
        } catch (error) {
          lastQuestionError = error;
          nextQuestion = null;
        }

        if (attempt < 3) {
          await report({
            stage: 'generating',
            percent,
            message: `Retrying question ${questionNumber} (attempt ${attempt + 1}/3)…`,
            expectedQuestionCount: baselineCount + totalUnits,
            savedQuestionCount: accumulatedQuestions.length,
            partial: { questions: accumulatedQuestions },
          });
        }
      }

      if (!nextQuestion || typeof nextQuestion !== 'object') {
        if (lastQuestionError instanceof InternalServerErrorException) {
          throw lastQuestionError;
        }
        throw new InternalServerErrorException(
          ErrorMessageKey.ASSESSMENT_AI_QUESTION_FAILED,
        );
      }

      const normalizedQuestion = {
        ...nextQuestion,
        topicId: nextQuestion.topicId ?? unit.topicId,
        type: nextQuestion.type || unit.questionType,
      };

      const cloCodesFromTopic = Array.from(
        new Set(
          [
            ...(Array.isArray(unit.topicGeneration.closDetails)
              ? unit.topicGeneration.closDetails.map((clo: any) =>
                  String(clo?.code || '').trim(),
                )
              : []),
            ...(Array.isArray(unit.topicGeneration.cloCodes)
              ? unit.topicGeneration.cloCodes.map((code: any) =>
                  String(code || '').trim(),
                )
              : []),
          ].filter(Boolean),
        ),
      );
      const preferredCloCode = String(
        normalizedQuestion.cloCode || cloCodesFromTopic[0] || '',
      ).trim();
      const cloCodes = preferredCloCode
        ? [
            preferredCloCode,
            ...cloCodesFromTopic.filter((code) => code !== preferredCloCode),
          ]
        : cloCodesFromTopic;

      // Prefer matching cloId for the chosen code when available.
      const cloIdsForQuestion = (() => {
        const details = Array.isArray(unit.topicGeneration.closDetails)
          ? unit.topicGeneration.closDetails
          : [];
        const matched = details.find(
          (clo: any) => String(clo?.code || '').trim() === preferredCloCode,
        );
        if (matched?.id != null) return [Number(matched.id)];
        return (unit.topicGeneration.cloIds as number[] | undefined) || [];
      })();

      const saved = await this.saveGeneratedQuestion(
        data.tenantId,
        data.courseId,
        data.assessmentId,
        normalizedQuestion,
        cloIdsForQuestion,
      );

      savedQuestionIds.push({ id: saved.id });
      accumulatedQuestions.push({
        ...normalizedQuestion,
        id: saved.id,
        cloCode: preferredCloCode || cloCodes[0] || null,
        cloCodes,
        clo: preferredCloCode || cloCodes[0] || null,
        questionClos: saved.questionClos,
        questionOptions: saved.questionOptions,
        options:
          saved.questionOptions?.map((opt) => ({
            text: opt.text,
            isCorrect: opt.isCorrect,
            order: opt.order,
          })) ??
          normalizedQuestion.options ??
          [],
      });

      await report({
        stage: 'saving',
        percent: Math.min(95, percent + 1),
        message: `Question ${questionNumber} of ${totalUnits} ready`,
        expectedQuestionCount: baselineCount + totalUnits,
        savedQuestionCount: accumulatedQuestions.length,
        partial: { questions: accumulatedQuestions },
      });
    }

    await report({
      stage: 'saving',
      percent: 96,
      message: 'Building assessment versions…',
      expectedQuestionCount: baselineCount + totalUnits,
      savedQuestionCount: accumulatedQuestions.length,
      partial: { questions: accumulatedQuestions },
    });

    await this.createAssessmentVersionsWithShuffle(
      this.prisma,
      assessmentMeta.id,
      savedQuestionIds,
      assessmentMeta.numberOfVersions,
    );

    const result = await this.getAssessmentWithQuestions(data.assessmentId);

    await report({
      stage: 'complete',
      percent: 100,
      message: append
        ? 'New questions added to assessment'
        : 'Assessment generation complete',
      expectedQuestionCount: baselineCount + totalUnits,
      savedQuestionCount: accumulatedQuestions.length,
      partial: { questions: accumulatedQuestions },
    });

    return result;
  }

  private buildGenerationUnits(
    topicGenerations: Array<{
      topicId: number;
      questionTypes: Array<{ questionType: string; questionTypeNumber: number }>;
      [key: string]: unknown;
    }>,
  ) {
    const units: Array<{
      topicId: number;
      questionType: string;
      topicGeneration: (typeof topicGenerations)[number];
    }> = [];

    for (const topicGeneration of topicGenerations) {
      for (const questionType of topicGeneration.questionTypes || []) {
        const count = Math.max(0, Number(questionType.questionTypeNumber) || 0);
        for (let i = 0; i < count; i++) {
          units.push({
            topicId: topicGeneration.topicId,
            questionType: questionType.questionType,
            topicGeneration,
          });
        }
      }
    }

    return units;
  }

  private async resetAssessmentShell(
    tenantId: number,
    courseId: number,
    assessmentId: number,
    dto: GenerateAssessmentDto,
    append = false,
  ) {
    // Versions are always rebuilt after generation with the full question set.
    await this.prisma.assessmentVersion.deleteMany({ where: { assessmentId } });

    if (!append) {
      await this.prisma.questionClo.deleteMany({
        where: { question: { assessmentId } },
      });
      await this.prisma.assessmentTopic.deleteMany({ where: { assessmentId } });
      await this.prisma.question.deleteMany({ where: { assessmentId } });
    }

    const generationConfig = {
      topicGenerations: dto.topicGenerations,
      append: Boolean(append),
      updatedAt: new Date().toISOString(),
    };

    const updatedAssessment = await this.prisma.assessment.update({
      where: { id: assessmentId },
      data: withPrismaJsonFields({
        ...dto.assessment,
        generationConfig,
      }) as Prisma.AssessmentUpdateInput,
      select: { id: true, numberOfVersions: true },
    });

    if (dto.topicGenerations.length) {
      await this.prisma.assessmentTopic.createMany({
        data: dto.topicGenerations.map((tg) => ({
          assessmentId,
          topicId: tg.topicId,
        })),
        skipDuplicates: true,
      });
    }

    return updatedAssessment;
  }

  private async saveGeneratedQuestion(
    tenantId: number,
    courseId: number,
    assessmentId: number,
    question: any,
    cloIds: number[] = [],
  ) {
    const uniqueCloIds = Array.from(
      new Set(
        (cloIds || [])
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id) && id > 0),
      ),
    );

    return this.prisma.question.create({
      data: {
        text: question.text,
        type: question.type,
        explanation: question.explanation,
        points: question.points ?? 1,
        assessmentId,
        tenantId,
        courseId,
        topicId: question.topicId,
        questionOptions: {
          create: (question.options ?? []).map((opt: any, index: number) => ({
            text: opt.text,
            isCorrect: Boolean(opt.isCorrect),
            order: opt.order ?? index + 1,
          })),
        },
        questionClos: uniqueCloIds.length
          ? {
              create: uniqueCloIds.map((cloId) => ({ cloId })),
            }
          : undefined,
      },
      include: {
        questionOptions: { orderBy: { order: 'asc' } },
        questionClos: {
          include: {
            Clo: { select: { id: true, code: true } },
          },
        },
      },
    });
  }

  private async getAssessmentWithQuestions(assessmentId: number) {
    return this.prisma.assessment.findUnique({
      where: { id: assessmentId },
      include: {
        assessmentTopics: true,
        questions: {
          include: {
            questionOptions: { orderBy: { order: 'asc' } },
            questionClos: {
              include: {
                Clo: { select: { id: true, code: true } },
              },
            },
          },
          orderBy: { id: 'asc' },
        },
        assessmentVersions: {
          include: {
            versionQuestions: {
              orderBy: { order: 'asc' },
              include: {
                question: {
                  include: {
                    questionOptions: { orderBy: { order: 'asc' } },
                    questionClos: {
                      include: {
                        Clo: { select: { id: true, code: true } },
                      },
                    },
                  },
                },
              },
            },
          },
          orderBy: { id: 'asc' },
        },
      },
    });
  }

  private countExpectedQuestions(dto: GenerateAssessmentDto) {
    return dto.topicGenerations.reduce(
      (total, topic) =>
        total +
        topic.questionTypes.reduce(
          (topicTotal, questionType) =>
            topicTotal + (questionType.questionTypeNumber || 0),
          0,
        ),
      0,
    );
  }

  // =========================================================================
  // PRIVATE HELPER METHODS (Separation of Concerns)
  // =========================================================================

  /**
   * Concern 1: Context Preparation & Data Fetching
   */
  private async preparePromptPayload(dto: GenerateAssessmentDto) {
    const enrichedTopics = await Promise.all(
      dto.topicGenerations.map(async (topicGen) => {
        const topic = await this.prisma.topic.findUnique({
          where: { id: topicGen.topicId },
          select: { id: true, title: true, topicNumber: true },
        });

        const cloIds = Array.from(
          new Set(
            (topicGen.cloIds || [])
              .map((id) => Number(id))
              .filter((id) => Number.isInteger(id) && id > 0),
          ),
        );

        const closFromIds =
          cloIds.length > 0
            ? await this.prisma.clo.findMany({
                where: { id: { in: cloIds } },
                select: {
                  id: true,
                  code: true,
                  description: true,
                  category: true,
                },
              })
            : [];

        const codesFromPayload = (topicGen.cloCodes || [])
          .map((code) => String(code || '').trim())
          .filter(Boolean);

        const missingCodes = codesFromPayload.filter(
          (code) =>
            !closFromIds.some(
              (clo) => String(clo.code).trim().toLowerCase() === code.toLowerCase(),
            ),
        );

        const closFromCodes =
          missingCodes.length > 0
            ? await this.prisma.clo.findMany({
                where: {
                  OR: [
                    { code: { in: missingCodes } },
                    { programCLOCode: { in: missingCodes } },
                  ],
                },
                select: {
                  id: true,
                  code: true,
                  description: true,
                  category: true,
                },
              })
            : [];

        const closByKey = new Map<string, (typeof closFromIds)[number]>();
        for (const clo of [...closFromIds, ...closFromCodes]) {
          closByKey.set(String(clo.id), clo);
        }

        // Keep payload code order when possible.
        const orderedClos = [
          ...codesFromPayload
            .map((code) =>
              [...closByKey.values()].find(
                (clo) =>
                  String(clo.code).trim().toLowerCase() === code.toLowerCase(),
              ),
            )
            .filter(Boolean),
          ...[...closByKey.values()].filter(
            (clo) =>
              !codesFromPayload.some(
                (code) =>
                  String(clo.code).trim().toLowerCase() === code.toLowerCase(),
              ),
          ),
        ] as typeof closFromIds;

        // If DB lookup failed, still keep plain codes for prompts + UI badges.
        const closDetails =
          orderedClos.length > 0
            ? orderedClos
            : codesFromPayload.map((code) => ({
                id: null as number | null,
                code,
                description: '',
                category: '',
              }));

        return {
          ...topicGen,
          cloIds: orderedClos.map((clo) => clo.id).filter(Boolean) as number[],
          cloCodes: closDetails.map((clo) => clo.code).filter(Boolean),
          topicTitle: topic?.title ?? 'Unknown Topic',
          topicNumber: topic?.topicNumber ?? 0,
          closDetails,
        };
      }),
    );

    return {
      assessment: dto.assessment,
      topicGenerations: enrichedTopics,
    };
  }

  /**
   * Concern 2: External LLM Infrastructure Layer
   */
  private async callAiModel(promptPayload: any): Promise<string> {
    try {
      const response = await createChatCompletion(this.client, {
        model: this.model,
        max_tokens: OPENROUTER_MAX_OUTPUT_TOKENS,
        messages: [
          {
            role: 'user',
            content: GENERATE_COURSE_PROMPT(promptPayload),
          },
        ],
        response_format: { type: 'json_object' },
      });

      return response.choices[0].message.content ?? '{}';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/402|credits|can only afford|max_tokens/i.test(message)) {
        throw new InternalServerErrorException(
          ErrorMessageKey.GENERATION_AI_CREDITS_EXCEEDED,
        );
      }
      throw new InternalServerErrorException(
        ErrorMessageKey.GENERATION_AI_API_FAILED,
      );
    }
  }

  private async callAiModelForSingleQuestion(payload: {
    assessment: any;
    topicGeneration: any;
    questionType: string;
    questionIndex: number;
    totalQuestions: number;
    existingQuestionTexts: string[];
  }): Promise<string> {
    try {
      const response = await createChatCompletion(this.client, {
        model: this.model,
        max_tokens: OPENROUTER_MAX_OUTPUT_TOKENS,
        messages: [
          {
            role: 'user',
            content: GENERATE_SINGLE_QUESTION_PROMPT(payload),
          },
        ],
        response_format: { type: 'json_object' },
      });

      return response.choices[0].message.content ?? '{}';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/402|credits|can only afford|max_tokens/i.test(message)) {
        throw new InternalServerErrorException(
          ErrorMessageKey.GENERATION_AI_CREDITS_EXCEEDED,
        );
      }
      throw new InternalServerErrorException(
        ErrorMessageKey.GENERATION_AI_API_FAILED,
      );
    }
  }

  private parseAiResponse(rawContent: string): any {
    const text = String(rawContent ?? '').trim();
    if (!text) {
      throw new InternalServerErrorException(
        ErrorMessageKey.GENERATION_AI_INVALID_JSON,
      );
    }

    const candidates = new Set<string>();
    candidates.add(text);

    const withoutFences = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    if (withoutFences) candidates.add(withoutFences);

    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      candidates.add(text.slice(firstBrace, lastBrace + 1));
    }

    const firstFenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (firstFenceMatch?.[1]?.trim()) {
      candidates.add(firstFenceMatch[1].trim());
    }

    for (const candidate of candidates) {
      const normalized = candidate
        .replace(/^\uFEFF/, '')
        .replace(/,\s*([}\]])/g, '$1');

      try {
        return JSON.parse(normalized);
      } catch {
        // try next candidate
      }
    }

    throw new InternalServerErrorException(
      ErrorMessageKey.GENERATION_AI_INVALID_JSON,
    );
  }

  /** Accept `{ questions: [...] }`, `{ question: {...} }`, or a bare question object. */
  private extractGeneratedQuestion(parsed: any): any | null {
    if (!parsed || typeof parsed !== 'object') return null;

    if (Array.isArray(parsed.questions) && parsed.questions.length > 0) {
      const first = parsed.questions.find(
        (item: unknown) => item && typeof item === 'object',
      );
      if (first) return first;
    }

    if (parsed.question && typeof parsed.question === 'object') {
      return parsed.question;
    }

    if (
      typeof parsed.text === 'string' &&
      parsed.text.trim() &&
      (parsed.type || Array.isArray(parsed.options))
    ) {
      return parsed;
    }

    return null;
  }

  /**
   * Concern 3: Transactional Update/Population
   */
  private async updateAssessmentDataWithAi(
    tenantId: number,
    courseId: number,
    assessmentId: number,
    dto: GenerateAssessmentDto,
    generatedData: any,
    onQuestionSaved?: (
      savedCount: number,
      total: number,
    ) => Promise<void> | void,
  ) {
    if (!Array.isArray(generatedData.questions)) {
      throw new InternalServerErrorException(
        ErrorMessageKey.ASSESSMENT_AI_INVALID_QUESTIONS_PAYLOAD,
      );
    }

    return await this.prisma.$transaction(
      async (tx) => {
        // Step A: Wipe clean potential existing configurations/stale iterations
        await tx.assessmentVersion.deleteMany({ where: { assessmentId } });
        await tx.questionClo.deleteMany({
          where: { question: { assessmentId } },
        });
        await tx.assessmentTopic.deleteMany({ where: { assessmentId } });
        await tx.question.deleteMany({ where: { assessmentId } });

        const updatedAssessment = await tx.assessment.update({
          where: { id: assessmentId },
          data: withPrismaJsonFields({
            ...(dto.assessment as Record<string, unknown>),
          }) as Prisma.AssessmentUpdateInput,
          select: { id: true, numberOfVersions: true },
        });

        // Step B: Bind chosen scope to AssessmentTopics layout
        await tx.assessmentTopic.createMany({
          data: dto.topicGenerations.map((tg) => ({
            assessmentId,
            topicId: tg.topicId,
          })),
        });

        // Step C: Save generated questions and concrete configurations
        const savedQuestions: { id: number }[] = [];
        const totalQuestions = generatedData.questions.length;

        for (const q of generatedData.questions) {
          const question = await tx.question.create({
            data: {
              text: q.text,
              type: q.type,
              explanation: q.explanation,
              points: q.points ?? 1,
              assessmentId,
              tenantId,
              courseId,
              topicId: q.topicId,
              questionOptions: {
                create: (q.options ?? []).map((opt: any) => ({
                  text: opt.text,
                  isCorrect: opt.isCorrect,
                  order: opt.order,
                })),
              },
            },
            select: { id: true },
          });

          savedQuestions.push(question);

          if (onQuestionSaved) {
            await onQuestionSaved(savedQuestions.length, totalQuestions);
          }
        }

        await this.createAssessmentVersionsWithShuffle(
          tx,
          updatedAssessment.id,
          savedQuestions,
          updatedAssessment.numberOfVersions,
        );

        // Return fully populated entity
        return tx.assessment.findUnique({
          where: { id: assessmentId },
          include: {
            assessmentTopics: true,
            questions: {
              include: {
                questionOptions: { orderBy: { order: 'asc' } },
              },
              orderBy: { id: 'asc' },
            },
            assessmentVersions: {
              include: {
                versionQuestions: {
                  orderBy: { order: 'asc' },
                  include: {
                    question: {
                      include: {
                        questionOptions: { orderBy: { order: 'asc' } },
                      },
                    },
                  },
                },
              },
              orderBy: { id: 'asc' },
            },
          },
        });
      },
      { maxWait: 10000, timeout: 60000 },
    );
  }

  async update(
    tenantId: number,
    assessmentId: number,
    dto: UpdateAssessmentDto,
  ) {
    const assessment = await this.prisma.assessment.findFirst({
      where: { id: assessmentId, tenantId },
      select: { id: true, courseId: true },
    });

    if (!assessment) {
      throw new NotFoundException('Assessment not found');
    }

    const {
      topicIds,
      cloIds,
      questions,
      numberOfVersions,
      headerConfig,
      ...assessmentFields
    } = dto;

    const courseId = assessment.courseId;

    return await this.prisma.$transaction(async (tx) => {
      await tx.assessment.update({
        where: { id: assessmentId },
        data: {
          ...assessmentFields,
          numberOfVersions,
          ...(headerConfig !== undefined
            ? { headerConfig: toPrismaJson(headerConfig) }
            : {}),
        },
      });

      if (topicIds) {
        const validTopics =
          topicIds.length > 0
            ? await tx.topic.findMany({
                where: {
                  id: { in: topicIds },
                  courseId,
                },
                select: { id: true },
              })
            : [];
        const validTopicIds = validTopics.map((topic) => topic.id);

        await tx.assessmentTopic.deleteMany({ where: { assessmentId } });

        if (validTopicIds.length) {
          await tx.assessmentTopic.createMany({
            data: validTopicIds.map((topicId) => ({
              assessmentId,
              topicId,
            })),
          });
        }
      }

      if (questions) {
        await tx.assessmentVersion.deleteMany({ where: { assessmentId } });
        await tx.questionClo.deleteMany({
          where: { question: { assessmentId } },
        });
        await tx.question.deleteMany({ where: { assessmentId } });

        const savedQuestions: { id: number }[] = [];

        for (const question of questions) {
          const { questionOptions, ...questionFields } = question;

          const savedQuestion = await tx.question.create({
            data: {
              ...questionFields,
              assessmentId,
              tenantId,
              questionClos: {
                create: (cloIds ?? []).map((cloId) => ({ cloId })),
              },
              questionOptions: {
                create: questionOptions.map((option) => ({
                  text: option.text,
                  isCorrect: option.isCorrect,
                  order: option.order,
                })),
              },
            },
            select: { id: true },
          });

          savedQuestions.push(savedQuestion);
        }

        const updatedAssessment = await tx.assessment.findUnique({
          where: { id: assessmentId },
          select: { numberOfVersions: true },
        });

        await this.createAssessmentVersionsWithShuffle(
          tx,
          assessmentId,
          savedQuestions,
          updatedAssessment?.numberOfVersions ?? 2,
        );
      } else if (numberOfVersions) {
        await this.rebuildAssessmentVersions(tx, assessmentId);
      }

      return tx.assessment.findUnique({
        where: { id: assessmentId },
        include: {
          assessmentTopics: true,
          questions: {
            include: {
              questionOptions: { orderBy: { order: 'asc' } },
            },
            orderBy: { id: 'asc' },
          },
          assessmentVersions: {
            include: {
              versionQuestions: {
                orderBy: { order: 'asc' },
                include: {
                  question: {
                    include: {
                      questionOptions: { orderBy: { order: 'asc' } },
                    },
                  },
                },
              },
            },
            orderBy: { id: 'asc' },
          },
        },
      });
    });
  }

  async addQuestion(
    tenantId: number,
    assessmentId: number,
    dto: AddQuestionDto,
  ) {
    const assessment = await this.prisma.assessment.findFirst({
      where: { id: assessmentId, tenantId },
      select: { id: true, courseId: true },
    });

    if (!assessment) {
      throw new NotFoundException('Assessment not found');
    }

    const { questionOptions, cloIds, ...questionFields } = dto;

    return await this.prisma.$transaction(async (tx) => {
      const question = await tx.question.create({
        data: {
          ...questionFields,
          assessmentId,
          tenantId,
          courseId: assessment.courseId,
          questionClos: {
            create: cloIds.map((cloId) => ({ cloId })),
          },
          questionOptions: {
            create: questionOptions.map((option) => ({
              text: option.text,
              isCorrect: option.isCorrect,
              order: option.order,
            })),
          },
        },
        include: {
          questionOptions: { orderBy: { order: 'asc' } },
          questionClos: true,
        },
      });

      await this.rebuildAssessmentVersions(tx, assessmentId);

      return question;
    });
  }

  async updateQuestion(
    tenantId: number,
    assessmentId: number,
    questionId: number,
    dto: UpdateQuestionDto,
  ) {
    const question = await this.prisma.question.findFirst({
      where: { id: questionId, assessmentId, tenantId },
      select: { id: true },
    });

    if (!question) {
      throw new NotFoundException('Question not found');
    }

    const { questionOptions, cloIds, ...questionFields } = dto;

    return await this.prisma.$transaction(async (tx) => {
      if (cloIds) {
        await tx.questionClo.deleteMany({ where: { questionId } });
        if (cloIds.length) {
          await tx.questionClo.createMany({
            data: cloIds.map((cloId) => ({ questionId, cloId })),
          });
        }
      }

      if (questionOptions) {
        await tx.questionOption.deleteMany({ where: { questionId } });
      }

      const updatedQuestion = await tx.question.update({
        where: { id: questionId },
        data: {
          ...questionFields,
          ...(questionOptions
            ? {
                questionOptions: {
                  create: questionOptions.map((option) => ({
                    text: option.text,
                    isCorrect: option.isCorrect,
                    order: option.order,
                  })),
                },
              }
            : {}),
        },
        include: {
          questionOptions: { orderBy: { order: 'asc' } },
          questionClos: true,
        },
      });

      await this.rebuildAssessmentVersions(tx, assessmentId);

      return updatedQuestion;
    });
  }

  async removeQuestion(
    tenantId: number,
    assessmentId: number,
    questionId: number,
  ) {
    const question = await this.prisma.question.findFirst({
      where: { id: questionId, assessmentId, tenantId },
      select: { id: true },
    });

    if (!question) {
      throw new NotFoundException('Question not found');
    }

    return await this.prisma.$transaction(async (tx) => {
      await tx.questionClo.deleteMany({ where: { questionId } });
      await tx.question.delete({ where: { id: questionId } });
      await this.rebuildAssessmentVersions(tx, assessmentId);

      return { id: questionId, deleted: true };
    });
  }

  async createVersionDownloads(tenantId: number, courseId: number) {
    const assessment = await this.getLatestAssessmentWithVersions(
      tenantId,
      courseId,
    );

    if (!assessment.assessmentVersions.length) {
      throw new NotFoundException(
        'No assessment versions found to download. Generate questions first.',
      );
    }

    return this.createAssessmentArchiveDownload(assessment);
  }

  async createVersionDownloadsByAssessmentId(
    tenantId: number,
    assessmentId: number,
  ) {
    const assessment = await this.getAssessmentWithVersionsById(
      tenantId,
      assessmentId,
    );

    if (!assessment.assessmentVersions.length) {
      throw new NotFoundException(
        'No assessment versions found to download. Generate questions first.',
      );
    }

    return this.createAssessmentArchiveDownload(assessment);
  }

  async getVersionDownloadFiles(tenantId: number, courseId: number) {
    const assessment = await this.getLatestAssessmentWithVersions(
      tenantId,
      courseId,
    );

    const baseUrl = `/courses/${courseId}/assessments/generate/ai/downloads`;

    return this.buildVersionDownloadList(assessment, baseUrl);
  }

  async getVersionDownloadFilesByAssessmentId(
    tenantId: number,
    assessmentId: number,
  ) {
    const assessment = await this.getAssessmentWithVersionsById(
      tenantId,
      assessmentId,
    );
    const baseUrl = `/assessments/${assessmentId}/downloads`;

    if (!assessment.assessmentVersions.length) {
      return {
        assessmentId: assessment.id,
        archiveUrl: `${baseUrl}/archive`,
        examFiles: [],
        answerSheetFiles: [],
        message: 'No assessment versions available yet. Generate questions first.',
      };
    }

    return this.buildVersionDownloadList(assessment, baseUrl);
  }

  async createVersionFileDownload(
    tenantId: number,
    courseId: number,
    versionId: number,
    kind: 'exam' | 'answer-sheet',
    format: 'pdf' | 'doc',
  ) {
    const assessment = await this.getLatestAssessmentWithVersions(
      tenantId,
      courseId,
    );

    return this.createVersionFileFromAssessment(
      assessment,
      versionId,
      kind,
      format,
    );
  }

  async createVersionFileDownloadByAssessmentId(
    tenantId: number,
    assessmentId: number,
    versionId: number,
    kind: 'exam' | 'answer-sheet',
    format: 'pdf' | 'doc',
  ) {
    const assessment = await this.getAssessmentWithVersionsById(
      tenantId,
      assessmentId,
    );

    return this.createVersionFileFromAssessment(
      assessment,
      versionId,
      kind,
      format,
    );
  }

  private createVersionFileFromAssessment(
    assessment: any,
    versionId: number,
    kind: 'exam' | 'answer-sheet',
    format: 'pdf' | 'doc',
  ) {
    const version = assessment.assessmentVersions.find(
      (assessmentVersion: any) => assessmentVersion.id === versionId,
    );

    if (!version) {
      throw new NotFoundException('Assessment version not found.');
    }

    const baseName = this.safeFilename(
      `${assessment.title}-${version.versionName}${
        kind === 'answer-sheet' ? '-answers' : ''
      }`,
    );
    const lines =
      kind === 'answer-sheet'
        ? this.buildAnswerSheetDocumentLines(assessment, version)
        : this.buildVersionDocumentLines(assessment, version);

    return {
      filename: `${baseName}.${format}`,
      contentType: format === 'pdf' ? 'application/pdf' : 'application/msword',
      buffer:
        format === 'pdf'
          ? this.createPdfBuffer(lines)
          : kind === 'exam'
            ? this.createExamDocBuffer(assessment, version)
            : this.createDocBuffer(lines),
    };
  }

  async getGenerationTopics(
    tenantId: number,
    courseId: number,
    type?: AssessmentType,
  ) {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, tenantId },
      include: {
        assessments: {
          where: type ? { type } : undefined,
          orderBy: { id: 'asc' },
        },
        topics: {
          include: {
            topicClos: {
              include: {
                clo: true,
              },
            },
          },
          orderBy: { topicNumber: 'asc' },
        },
      },
    });

    if (!course) {
      throw new NotFoundException('Course not found');
    }

    return {
      courseId: course.id,
      assessments: course.assessments,
      topics: course.topics.map((topic) => ({
        id: topic.id,
        topicNumber: topic.topicNumber,
        title: topic.title,
        contactHours: topic.contactHours,
        clos: topic.topicClos.map((topicClo) => topicClo.clo),
      })),
      blooms: Object.values(Bloom),
      questionTypes: ACTIVE_GENERATION_QUESTION_TYPES,
    };
  }

  private async createAssessmentVersionsWithShuffle(
    tx: any,
    assessmentId: number,
    questions: { id: number }[],
    numberOfVersions = 2,
  ): Promise<void> {
    const assessment = await tx.assessment.findUnique({
      where: { id: assessmentId },
      select: { id: true },
    });

    if (!assessment) {
      throw new NotFoundException('Assessment not found');
    }

    if (questions.length === 0) {
      return;
    }

    const safeNumberOfVersions = Math.max(1, numberOfVersions ?? 2);
    const versionNames = this.buildAssessmentVersionNames(safeNumberOfVersions);

    for (const versionName of versionNames) {
      const version = await tx.assessmentVersion.create({
        data: {
          versionName,
          assessment: {
            connect: { id: assessment.id },
          },
        },
      });

      const shuffledQuestions = this.shuffleQuestions(questions);

      if (shuffledQuestions.length) {
        await tx.assessmentVersionQuestion.createMany({
          data: shuffledQuestions.map((question, index) => ({
            assessmentVersionId: version.id,
            questionId: question.id,
            order: index + 1,
          })),
        });
      }
    }
  }

  private async rebuildAssessmentVersions(tx: any, assessmentId: number) {
    const assessment = await tx.assessment.findUnique({
      where: { id: assessmentId },
      select: {
        numberOfVersions: true,
        questions: {
          select: { id: true },
          orderBy: { id: 'asc' },
        },
      },
    });

    if (!assessment) {
      throw new NotFoundException('Assessment not found');
    }

    await tx.assessmentVersion.deleteMany({ where: { assessmentId } });
    await this.createAssessmentVersionsWithShuffle(
      tx,
      assessmentId,
      assessment.questions,
      assessment.numberOfVersions,
    );
  }

  private buildAssessmentVersionNames(numberOfVersions: number): string[] {
    return Array.from(
      { length: numberOfVersions },
      (_, index) => `Version ${this.getVersionLabel(index)}`,
    );
  }

  private getVersionLabel(index: number): string {
    let label = '';
    let current = index;

    do {
      label = String.fromCharCode(65 + (current % 26)) + label;
      current = Math.floor(current / 26) - 1;
    } while (current >= 0);

    return label;
  }

  private shuffleQuestions<T>(questions: T[]): T[] {
    const shuffled = [...questions];

    for (let index = shuffled.length - 1; index > 0; index--) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [
        shuffled[swapIndex],
        shuffled[index],
      ];
    }

    return shuffled;
  }

  private buildVersionDocumentLines(assessment: any, version: any): string[] {
    const headerLines = this.buildAssessmentHeaderLines(assessment.headerConfig);
    const fallbackMeta = headerLines.length
      ? []
      : [
          assessment.title,
          `Course: ${assessment.course?.title ?? 'N/A'}`,
          assessment.duration ? `Duration: ${assessment.duration} minutes` : '',
          assessment.totalMarks ? `Total Marks: ${assessment.totalMarks}` : '',
          '',
        ];

    const lines = [
      ...headerLines,
      ...(headerLines.length ? [] : fallbackMeta),
    ].filter((line, index, all) => {
      if (line !== '') return true;
      return index === 0 || all[index - 1] !== '';
    });

    version.versionQuestions.forEach((versionQuestion: any, index: number) => {
      const question = versionQuestion.question;
      lines.push(
        `${index + 1}. [${question.points ?? 1} pts] ${question.text}`,
      );

      question.questionOptions?.forEach((option: any) => {
        lines.push(`   ${option.order}. ${option.text}`);
      });

      lines.push('');
    });

    return lines;
  }

  private pickHeaderText(value: unknown, fallback = '') {
    const next = String(value ?? '').trim();
    return next || fallback;
  }

  private formatExaminationDate(value: unknown) {
    const raw = this.pickHeaderText(value);
    if (!raw) return '';
    const date = new Date(`${raw}T00:00:00`);
    if (Number.isNaN(date.getTime())) return raw;
    const formatted = date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const weekday = date.toLocaleDateString('en-US', { weekday: 'long' });
    return `${formatted} (${weekday}).`;
  }

  private semesterLabel(value: unknown) {
    const raw = this.pickHeaderText(value).toUpperCase();
    if (raw === 'FIRST') return 'First Semester';
    if (raw === 'SECOND') return 'Second Semester';
    if (raw === 'THIRD') return 'Third Semester';
    return this.pickHeaderText(value);
  }

  private hasAssessmentHeader(headerConfig: unknown) {
    if (!headerConfig || typeof headerConfig !== 'object') return false;
    const header = headerConfig as Record<string, unknown>;
    return Boolean(
      this.pickHeaderText(header.universityEn) ||
        this.pickHeaderText(header.universityAr) ||
        this.pickHeaderText(header.examName) ||
        this.pickHeaderText(header.courseName) ||
        this.pickHeaderText(header.facultyEn),
    );
  }

  private buildAssessmentHeaderLines(headerConfig: unknown): string[] {
    if (!this.hasAssessmentHeader(headerConfig)) return [];
    const header = headerConfig as Record<string, unknown>;

    const enLines = [
      header.countryEn,
      header.ministryEn,
      header.universityEn,
      header.facultyEn,
      header.sectionEn,
    ]
      .map((line) => this.pickHeaderText(line))
      .filter(Boolean);

    const arLines = [
      header.countryAr,
      header.ministryAr,
      header.universityAr,
      header.facultyAr,
      header.sectionAr,
    ]
      .map((line) => this.pickHeaderText(line))
      .filter(Boolean);

    const duration = this.pickHeaderText(header.durationMinutes)
      ? `${this.pickHeaderText(header.durationMinutes)} Minutes`
      : '';

    return [
      '================================================================================',
      ...enLines,
      ...arLines,
      '--------------------------------------------------------------------------------',
      this.pickHeaderText(header.academicYear)
        ? `Academic Year ${this.pickHeaderText(header.academicYear)}`
        : '',
      this.semesterLabel(header.semester),
      this.pickHeaderText(header.examName),
      this.pickHeaderText(header.courseName)
        ? `Course Name: ${this.pickHeaderText(header.courseName)}`
        : '',
      this.pickHeaderText(header.courseCode)
        ? `Course Code: ${this.pickHeaderText(header.courseCode)}`
        : '',
      '',
      `Date of Examination: ${this.formatExaminationDate(header.dateOfExamination)}`,
      `Duration: ${duration}`,
      `Time of Examination: ${this.pickHeaderText(header.timeOfExamination)}`,
      `Total Marks: ${this.pickHeaderText(header.totalMarks)}`,
      '',
      "Student's Name: ______________________________",
      'Academic ID: _____________',
      '================================================================================',
      '',
    ].filter((line, index, all) => {
      if (line !== '') return true;
      return index === 0 || all[index - 1] !== '';
    });
  }

  private buildAssessmentHeaderHtml(headerConfig: unknown): string {
    if (!this.hasAssessmentHeader(headerConfig)) return '';
    const header = headerConfig as Record<string, unknown>;
    const escape = (value: unknown) => this.escapeHtml(this.pickHeaderText(value));

    const enLines = [
      header.countryEn,
      header.ministryEn,
      header.universityEn,
      header.facultyEn,
      header.sectionEn,
    ]
      .map((line) => this.pickHeaderText(line))
      .filter(Boolean);

    const arLines = [
      header.countryAr,
      header.ministryAr,
      header.universityAr,
      header.facultyAr,
      header.sectionAr,
    ]
      .map((line) => this.pickHeaderText(line))
      .filter(Boolean);

    const duration = this.pickHeaderText(header.durationMinutes)
      ? `${this.pickHeaderText(header.durationMinutes)} Minutes`
      : '';

    return `
<div style="font-family:'Times New Roman',Times,serif;color:#000;margin-bottom:18px;">
  <div style="border-top:5px double #000;border-bottom:5px double #000;padding:10px 0;">
    <table style="width:100%;border-collapse:collapse;">
      <tr>
        <td style="width:40%;text-align:center;font-weight:700;font-size:14px;line-height:1.3;">
          ${enLines.map((line) => `<div>${escape(line)}</div>`).join('')}
        </td>
        <td style="width:20%;text-align:center;font-weight:700;font-size:18px;">
          ${escape(
            this.pickHeaderText(header.universityEn)
              .split(/\s+/)
              .slice(0, 2)
              .map((part) => part[0] || '')
              .join('')
              .toUpperCase() || 'U',
          )}
        </td>
        <td style="width:40%;text-align:center;font-weight:700;font-size:14px;line-height:1.3;direction:rtl;">
          ${arLines.map((line) => `<div>${escape(line)}</div>`).join('')}
        </td>
      </tr>
    </table>
  </div>
  <div style="text-align:center;padding-top:12px;font-size:16px;line-height:1.35;">
    ${this.pickHeaderText(header.academicYear) ? `<div style="font-weight:700;">Academic Year ${escape(header.academicYear)}</div>` : ''}
    ${this.semesterLabel(header.semester) ? `<div>${escape(this.semesterLabel(header.semester))}</div>` : ''}
    ${this.pickHeaderText(header.examName) ? `<div>${escape(header.examName)}</div>` : ''}
    ${this.pickHeaderText(header.courseName) ? `<div><strong>Course Name:</strong> ${escape(header.courseName)}</div>` : ''}
    ${this.pickHeaderText(header.courseCode) ? `<div><strong>Course Code:</strong> ${escape(header.courseCode)}</div>` : ''}
  </div>
  <table style="width:100%;margin-top:12px;font-size:14px;border-collapse:collapse;">
    <tr>
      <td style="width:58%;padding:3px 6px;"><strong>Date of Examination:</strong> ${escape(this.formatExaminationDate(header.dateOfExamination))}</td>
      <td style="width:42%;padding:3px 6px;"><strong>Duration:</strong> ${escape(duration)}</td>
    </tr>
    <tr>
      <td style="padding:3px 6px;"><strong>Time of Examination:</strong> ${escape(header.timeOfExamination)}</td>
      <td style="padding:3px 6px;"><strong>Total Marks:</strong> ${escape(header.totalMarks)}</td>
    </tr>
    <tr>
      <td style="padding:10px 6px 3px;"><strong>Student's Name:</strong> ______________________________</td>
      <td style="padding:10px 6px 3px;"><strong>Academic ID:</strong> _____________</td>
    </tr>
  </table>
  <div style="margin-top:14px;border-bottom:5px double #1f3b73;"></div>
</div>`;
  }

  private createExamDocBuffer(assessment: any, version: any): Buffer {
    const headerHtml = this.buildAssessmentHeaderHtml(assessment.headerConfig);
    const footerText = this.pickHeaderText(assessment.headerConfig?.footerText);
    const questionLines: string[] = [];

    if (headerHtml) {
      questionLines.push('');
    } else {
      questionLines.push(assessment.title || '');
      questionLines.push(`Course: ${assessment.course?.title ?? 'N/A'}`);
      if (assessment.duration) {
        questionLines.push(`Duration: ${assessment.duration} minutes`);
      }
      if (assessment.totalMarks) {
        questionLines.push(`Total Marks: ${assessment.totalMarks}`);
      }
      questionLines.push('');
    }

    version.versionQuestions.forEach((versionQuestion: any, index: number) => {
      const question = versionQuestion.question;
      questionLines.push(
        `${index + 1}. [${question.points ?? 1} pts] ${question.text}`,
      );
      question.questionOptions?.forEach((option: any) => {
        questionLines.push(`   ${option.order}. ${option.text}`);
      });
      questionLines.push('');
    });

    const body = questionLines
      .map((line) =>
        line
          ? `<p>${this.escapeHtml(line)}</p>`
          : '<p style="mso-line-height-alt:1pt">&nbsp;</p>',
      )
      .join('');

    const footerHtml = footerText
      ? `<div style="margin-top:28px;padding-top:10px;border-top:1px solid #cbd5e1;font-size:12px;line-height:1.55;color:#334155;white-space:pre-wrap;">${this.escapeHtml(footerText)}</div>`
      : '';

    return Buffer.from(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Assessment Version</title></head><body>${headerHtml}${body}${footerHtml}</body></html>`,
      'utf8',
    );
  }

  private buildAnswerSheetDocumentLines(assessment: any, version: any): string[] {
    const lines = [
      `${assessment.title} - Answer Sheet`,
      `${version.versionName}`,
      `Course: ${assessment.course?.title ?? 'N/A'}`,
      '',
    ].filter(Boolean);

    version.versionQuestions.forEach((versionQuestion: any, index: number) => {
      const question = versionQuestion.question;
      const correctOptions =
        question.questionOptions
          ?.filter((option: any) => option.isCorrect)
          .map((option: any) => `${option.order}. ${option.text}`)
          .join('; ') ?? '';

      lines.push(`${index + 1}. ${question.text}`);
      lines.push(
        `Answer: ${correctOptions || question.correctAnswer || 'N/A'}`,
      );

      if (question.explanation) {
        lines.push(`Explanation: ${question.explanation}`);
      }

      lines.push('');
    });

    return lines;
  }

  private createAssessmentArchiveDownload(assessment: any) {
    const files = assessment.assessmentVersions.flatMap((version: any) => {
      const baseName = this.safeFilename(
        `${assessment.title}-${version.versionName}`,
      );
      const lines = this.buildVersionDocumentLines(assessment, version);
      const answerLines = this.buildAnswerSheetDocumentLines(
        assessment,
        version,
      );

      return [
        {
          filename: `exams/${baseName}.pdf`,
          buffer: this.createPdfBuffer(lines),
        },
        {
          filename: `exams/${baseName}.doc`,
          buffer: this.createExamDocBuffer(assessment, version),
        },
        {
          filename: `answer-sheets/${baseName}-answers.pdf`,
          buffer: this.createPdfBuffer(answerLines),
        },
        {
          filename: `answer-sheets/${baseName}-answers.doc`,
          buffer: this.createDocBuffer(answerLines),
        },
      ];
    });

    return {
      filename: `${this.safeFilename(assessment.title)}-versions.zip`,
      contentType: 'application/zip',
      buffer: this.createZipBuffer(files),
    };
  }

  private buildVersionDownloadList(assessment: any, baseUrl: string) {
    return {
      assessmentId: assessment.id,
      archiveUrl: `${baseUrl}/archive`,
      examFiles: assessment.assessmentVersions.flatMap((version: any) =>
        this.buildDownloadFileEntries(
          baseUrl,
          assessment.title,
          version.id,
          version.versionName,
          'exams',
        ),
      ),
      answerSheetFiles: assessment.assessmentVersions.flatMap((version: any) =>
        this.buildDownloadFileEntries(
          baseUrl,
          `${assessment.title} Answers`,
          version.id,
          version.versionName,
          'answer-sheets',
        ),
      ),
    };
  }

  private async getLatestAssessmentWithVersions(
    tenantId: number,
    courseId: number,
  ) {
    const assessment = await this.prisma.assessment.findFirst({
      where: { tenantId, courseId },
      orderBy: { updatedAt: 'desc' },
      include: {
        course: { select: { title: true } },
        questions: { select: { id: true }, orderBy: { id: 'asc' } },
        assessmentVersions: {
          orderBy: { id: 'asc' },
          include: {
            versionQuestions: {
              orderBy: { order: 'asc' },
              include: {
                question: {
                  include: {
                    questionOptions: { orderBy: { order: 'asc' } },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!assessment) {
      throw new NotFoundException('Assessment not found for this course.');
    }

    return this.ensureAssessmentHasVersions(assessment);
  }

  private async getAssessmentWithVersionsById(
    tenantId: number,
    assessmentId: number,
  ) {
    const assessment = await this.prisma.assessment.findFirst({
      where: { id: assessmentId, tenantId },
      include: {
        course: { select: { title: true } },
        questions: { select: { id: true }, orderBy: { id: 'asc' } },
        assessmentVersions: {
          orderBy: { id: 'asc' },
          include: {
            versionQuestions: {
              orderBy: { order: 'asc' },
              include: {
                question: {
                  include: {
                    questionOptions: { orderBy: { order: 'asc' } },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!assessment) {
      throw new NotFoundException('Assessment not found.');
    }

    return this.ensureAssessmentHasVersions(assessment);
  }

  /**
   * Rebuild shuffled paper versions when questions exist but versions are missing
   * (common after interrupted generation or edit/append flows).
   */
  private async ensureAssessmentHasVersions<
    T extends {
      id: number;
      numberOfVersions?: number | null;
      questions?: { id: number }[];
      assessmentVersions: unknown[];
    },
  >(assessment: T): Promise<T> {
    if (assessment.assessmentVersions.length > 0) {
      return assessment;
    }

    const questionIds =
      assessment.questions?.map((question) => ({ id: question.id })) ?? [];

    if (questionIds.length === 0) {
      return assessment;
    }

    await this.createAssessmentVersionsWithShuffle(
      this.prisma,
      assessment.id,
      questionIds,
      assessment.numberOfVersions ?? 2,
    );

    const refreshed = await this.prisma.assessment.findFirst({
      where: { id: assessment.id },
      include: {
        course: { select: { title: true } },
        questions: { select: { id: true }, orderBy: { id: 'asc' } },
        assessmentVersions: {
          orderBy: { id: 'asc' },
          include: {
            versionQuestions: {
              orderBy: { order: 'asc' },
              include: {
                question: {
                  include: {
                    questionOptions: { orderBy: { order: 'asc' } },
                  },
                },
              },
            },
          },
        },
      },
    });

    return ((refreshed as unknown) as T) || assessment;
  }

  private buildDownloadFileEntries(
    baseUrl: string,
    title: string,
    versionId: number,
    versionName: string,
    kind: 'exams' | 'answer-sheets',
  ) {
    const baseName = this.safeFilename(`${title}-${versionName}`);

    return [
      {
        filename: `${baseName}.pdf`,
        format: 'pdf',
        url: `${baseUrl}/${kind}/${versionId}/pdf`,
      },
      {
        filename: `${baseName}.doc`,
        format: 'doc',
        url: `${baseUrl}/${kind}/${versionId}/doc`,
      },
    ];
  }

  private createPdfBuffer(lines: string[]): Buffer {
    const wrappedLines = lines.flatMap((line) => this.wrapText(line, 92));
    const pages = this.chunk(wrappedLines, 48);
    const objects: string[] = [];

    objects.push('<< /Type /Catalog /Pages 2 0 R >>');
    objects.push(
      `<< /Type /Pages /Kids [${pages
        .map((_, index) => `${3 + index * 2} 0 R`)
        .join(' ')}] /Count ${pages.length} >>`,
    );

    pages.forEach((pageLines, index) => {
      const pageObjectNumber = 3 + index * 2;
      const contentObjectNumber = pageObjectNumber + 1;
      const content = [
        'BT',
        '/F1 11 Tf',
        '50 780 Td',
        '14 TL',
        ...pageLines.map((line) => `(${this.escapePdfText(line)}) Tj T*`),
        'ET',
      ].join('\n');

      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${contentObjectNumber} 0 R >>`,
      );
      objects.push(
        `<< /Length ${Buffer.byteLength(content, 'utf8')} >>\nstream\n${content}\nendstream`,
      );
    });

    let pdf = '%PDF-1.4\n';
    const offsets = [0];

    objects.forEach((object, index) => {
      offsets.push(Buffer.byteLength(pdf, 'utf8'));
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });

    const xrefOffset = Buffer.byteLength(pdf, 'utf8');
    pdf += `xref\n0 ${objects.length + 1}\n`;
    pdf += '0000000000 65535 f \n';
    offsets.slice(1).forEach((offset) => {
      pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
    });
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
    pdf += `startxref\n${xrefOffset}\n%%EOF`;

    return Buffer.from(pdf, 'utf8');
  }

  private createDocBuffer(lines: string[]): Buffer {
    const body = lines
      .map((line) =>
        line
          ? `<p>${this.escapeHtml(line)}</p>`
          : '<p style="mso-line-height-alt:1pt">&nbsp;</p>',
      )
      .join('');

    return Buffer.from(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Assessment Version</title></head><body>${body}</body></html>`,
      'utf8',
    );
  }

  private createZipBuffer(
    files: { filename: string; buffer: Buffer }[],
  ): Buffer {
    const localParts: Buffer[] = [];
    const centralParts: Buffer[] = [];
    let offset = 0;

    files.forEach((file) => {
      const name = Buffer.from(file.filename, 'utf8');
      const crc = this.crc32(file.buffer);
      const localHeader = Buffer.alloc(30);

      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(20, 4);
      localHeader.writeUInt16LE(0x0800, 6);
      localHeader.writeUInt16LE(0, 8);
      localHeader.writeUInt32LE(0, 10);
      localHeader.writeUInt32LE(crc, 14);
      localHeader.writeUInt32LE(file.buffer.length, 18);
      localHeader.writeUInt32LE(file.buffer.length, 22);
      localHeader.writeUInt16LE(name.length, 26);
      localHeader.writeUInt16LE(0, 28);

      localParts.push(localHeader, name, file.buffer);

      const centralHeader = Buffer.alloc(46);
      centralHeader.writeUInt32LE(0x02014b50, 0);
      centralHeader.writeUInt16LE(20, 4);
      centralHeader.writeUInt16LE(20, 6);
      centralHeader.writeUInt16LE(0x0800, 8);
      centralHeader.writeUInt16LE(0, 10);
      centralHeader.writeUInt32LE(0, 12);
      centralHeader.writeUInt32LE(crc, 16);
      centralHeader.writeUInt32LE(file.buffer.length, 20);
      centralHeader.writeUInt32LE(file.buffer.length, 24);
      centralHeader.writeUInt16LE(name.length, 28);
      centralHeader.writeUInt16LE(0, 30);
      centralHeader.writeUInt16LE(0, 32);
      centralHeader.writeUInt16LE(0, 34);
      centralHeader.writeUInt16LE(0, 36);
      centralHeader.writeUInt32LE(0, 38);
      centralHeader.writeUInt32LE(offset, 42);

      centralParts.push(centralHeader, name);
      offset += localHeader.length + name.length + file.buffer.length;
    });

    const centralSize = centralParts.reduce(
      (sum, part) => sum + part.length,
      0,
    );
    const endRecord = Buffer.alloc(22);

    endRecord.writeUInt32LE(0x06054b50, 0);
    endRecord.writeUInt16LE(0, 4);
    endRecord.writeUInt16LE(0, 6);
    endRecord.writeUInt16LE(files.length, 8);
    endRecord.writeUInt16LE(files.length, 10);
    endRecord.writeUInt32LE(centralSize, 12);
    endRecord.writeUInt32LE(offset, 16);
    endRecord.writeUInt16LE(0, 20);

    return Buffer.concat([...localParts, ...centralParts, endRecord]);
  }

  private crc32(buffer: Buffer): number {
    let crc = 0xffffffff;

    for (const byte of buffer) {
      crc = (crc >>> 8) ^ this.crc32Table[(crc ^ byte) & 0xff];
    }

    return (crc ^ 0xffffffff) >>> 0;
  }

  private readonly crc32Table = Array.from({ length: 256 }, (_, index) => {
    let crc = index;

    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }

    return crc >>> 0;
  });

  private wrapText(text: string, maxLength: number): string[] {
    if (!text) {
      return [''];
    }

    const words = text.split(/\s+/);
    const lines: string[] = [];
    let currentLine = '';

    words.forEach((word) => {
      if (`${currentLine} ${word}`.trim().length > maxLength) {
        lines.push(currentLine);
        currentLine = word;
        return;
      }

      currentLine = `${currentLine} ${word}`.trim();
    });

    if (currentLine) {
      lines.push(currentLine);
    }

    return lines;
  }

  private chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];

    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }

    return chunks.length ? chunks : [[]];
  }

  private escapePdfText(text: string): string {
    return text
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)');
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private safeFilename(value: string): string {
    return value
      .trim()
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
  }

  // =========================================================================
  // CORE FETCH / DATA MANAGEMENT OPERATIONS
  // =========================================================================

  async findOne(tenantId: number, assessmentId: number) {
    const tid = requireTenantId(tenantId);
    const assessment = await this.prisma.assessment.findFirst({
      where: { id: assessmentId, tenantId: tid },
      include: {
        course: {
          select: {
            id: true,
            title: true,
            code: true,
            _count: { select: { students: true } },
          },
        },
        assessmentTopics: {
          include: {
            topic: {
              include: {
                questions: {
                  where: { assessmentId },
                  include: {
                    questionOptions: { orderBy: { order: 'asc' } },
                  },
                  orderBy: { id: 'asc' },
                },
              },
            },
          },
          orderBy: { topicId: 'asc' },
        },
        questions: {
          include: {
            questionOptions: { orderBy: { order: 'asc' } },
            questionClos: {
              include: {
                Clo: { select: { id: true, code: true } },
              },
            },
          },
          orderBy: { id: 'asc' },
        },
        assessmentVersions: {
          include: {
            versionQuestions: {
              orderBy: { order: 'asc' },
              include: {
                question: {
                  include: {
                    questionOptions: { orderBy: { order: 'asc' } },
                  },
                },
              },
            },
          },
          orderBy: { id: 'asc' },
        },
      },
    });
    if (!assessment) {
      throw new NotFoundException('Assessment not found');
    }
    return assessment;
  }

  findByTenant(tenantId: number) {
    const tid = requireTenantId(tenantId);
    return this.prisma.assessment.findMany({
      where: { tenantId: tid },
      select: {
        id: true,
        title: true,
        type: true,
        totalMarks: true,
        duration: true,
        tenantId: true,
        isPublished: true,
        createdAt: true,
        updatedAt: true,
        generationConfig: true,
        _count: { select: { questions: true } },
        course: { select: { id: true, title: true, code: true, tenantId: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  findAll(tenantId: number, courseId: number) {
    const tid = requireTenantId(tenantId);
    const questionCloInclude = {
      questionClos: {
        include: {
          Clo: { select: { id: true, code: true } },
        },
      },
      questionOptions: { orderBy: { order: 'asc' as const } },
    };

    return this.prisma.assessment.findMany({
      where: { tenantId: tid, courseId },
      include: {
        questions: {
          include: questionCloInclude,
          orderBy: { id: 'asc' },
        },
        assessmentTopics: {
          include: {
            topic: {
              include: {
                questions: {
                  include: questionCloInclude,
                },
              },
            },
          },
          orderBy: { topicId: 'asc' },
        },
        assessmentVersions: {
          include: {
            versionQuestions: {
              orderBy: { order: 'asc' },
              include: {
                question: {
                  include: questionCloInclude,
                },
              },
            },
          },
          orderBy: { id: 'asc' },
        },
      },
    });
  }

  async remove(tenantId: number, id: number) {
    const tid = requireTenantId(tenantId);
    const assessment = await this.prisma.assessment.findFirst({
      where: { id, tenantId: tid },
    });
    if (!assessment) {
      throw new NotFoundException('Assessment is not found');
    }
    return await this.prisma.assessment.delete({
      where: { id },
    });
  }
}
