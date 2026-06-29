import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { GenerateAssessmentDto } from './dto/generate-assessment.dto';
import OpenAI from 'openai';
import { ConfigService } from '@nestjs/config';
import { GENERATE_COURSE_PROMPT } from './prompts/generate-assessment.prompt';
import { CreateAssessmentDto } from './dto/create-assessment.dto';
import { UpdateAssessmentDto } from './dto/update-assessment.dto.ts';
import { AddQuestionDto, UpdateQuestionDto } from './dto/question.dto';
import { ACTIVE_GENERATION_QUESTION_TYPES } from './config/question-types.config';
import { AssessmentType, Bloom } from 'generated/prisma/enums';

@Injectable()
export class AssessmentService {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
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
    return await this.prisma.assessment.create({
      data: {
        title: dto.title,
        type: dto.type,
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
        language: dto.language,
        difficulty: dto.difficulty,
        tenantId,
        courseId,
      },
    });
  }

  /**
   * 2. Orchestrated Generator: Populates/Updates an Existing Assessment Record
   */
  async generate(
    tenantId: number,
    courseId: number,
    assessmentId: number, // Target existing assessment record ID
    dto: GenerateAssessmentDto,
  ) {
    // Verify target assessment shell exists first
    const targetAssessment = await this.prisma.assessment.findFirst({
      where: { id: assessmentId, tenantId, courseId },
    });

    if (!targetAssessment) {
      throw new NotFoundException('Assessment container shell not found.');
    }

    // A. Enrich blueprint arrays for context window
    const promptPayload = await this.preparePromptPayload(dto);

    // B. Run LLM operations
    const aiRawResponse = await this.callAiModel(promptPayload);
    const generatedData = this.parseAiResponse(aiRawResponse);

    console.log(generatedData);

    // C. Write variations and items into the verified record
    return await this.updateAssessmentDataWithAi(
      tenantId,
      courseId,
      assessmentId,
      dto,
      generatedData,
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

        const clos = await this.prisma.clo.findMany({
          where: { id: { in: topicGen.cloIds } },
          select: { code: true, description: true, category: true },
        });

        return {
          ...topicGen,
          topicTitle: topic?.title ?? 'Unknown Topic',
          topicNumber: topic?.topicNumber ?? 0,
          closDetails: clos,
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
      const response = await this.client.chat.completions.create({
        model: this.model,
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
      throw new InternalServerErrorException(
        'Failed to communicate with AI Model generation service',
      );
    }
  }

  private parseAiResponse(rawContent: string): any {
    try {
      return JSON.parse(rawContent);
    } catch {
      throw new InternalServerErrorException(
        'AI returned an invalid JSON string layout.',
      );
    }
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
  ) {
    if (!Array.isArray(generatedData.questions)) {
      throw new InternalServerErrorException(
        'AI returned an invalid questions payload.',
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
          data: dto.assessment,
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
      { maxWait: 10000, timeout: 30000 },
    );
  }

  async update(
    tenantId: number,
    assessmentId: number,
    dto: UpdateAssessmentDto,
  ) {
    const assessment = await this.prisma.assessment.findFirst({
      where: { id: assessmentId, tenantId },
      select: { id: true },
    });

    if (!assessment) {
      throw new NotFoundException('Assessment not found');
    }

    const {
      topicIds,
      cloIds,
      questions,
      numberOfVersions,
      ...assessmentFields
    } = dto;

    return await this.prisma.$transaction(async (tx) => {
      await tx.assessment.update({
        where: { id: assessmentId },
        data: {
          ...assessmentFields,
          numberOfVersions,
        },
      });

      if (topicIds) {
        await tx.assessmentTopic.deleteMany({ where: { assessmentId } });

        if (topicIds.length) {
          await tx.assessmentTopic.createMany({
            data: topicIds.map((topicId) => ({
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
    const lines = [
      assessment.title,
      `${version.versionName}`,
      `Course: ${assessment.course?.title ?? 'N/A'}`,
      assessment.duration ? `Duration: ${assessment.duration} minutes` : '',
      assessment.totalMarks ? `Total Marks: ${assessment.totalMarks}` : '',
      '',
    ].filter(Boolean);

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
          buffer: this.createDocBuffer(lines),
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

    if (assessment.assessmentVersions.length === 0) {
      throw new NotFoundException('No assessment versions found to download.');
    }

    return assessment;
  }

  private async getAssessmentWithVersionsById(
    tenantId: number,
    assessmentId: number,
  ) {
    const assessment = await this.prisma.assessment.findFirst({
      where: { id: assessmentId, tenantId },
      include: {
        course: { select: { title: true } },
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

    if (assessment.assessmentVersions.length === 0) {
      throw new NotFoundException('No assessment versions found to download.');
    }

    return assessment;
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
      `<< /Type /Pages /Kids ${pages
        .map((_, index) => `${3 + index * 2} 0 R`)
        .join(' ')} /Count ${pages.length} >>`,
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

  async findOne(assessmentId: number) {
    const assessment = await this.prisma.assessment.findFirst({
      where: { id: assessmentId },
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
    return this.prisma.assessment.findMany({
      where: { tenantId },
      select: {
        id: true,
        title: true,
        type: true,
        totalMarks: true,
        duration: true,
        course: { select: { id: true, title: true, code: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  findAll(courseId: number) {
    return this.prisma.assessment.findMany({
      where: { courseId },
      include: {
        assessmentTopics: {
          include: {
            topic: {
              include: {
                questions: {
                  include: {
                    questionOptions: { orderBy: { order: 'asc' } },
                  },
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
  }

  async remove(id: number) {
    const assessment = await this.prisma.assessment.findUnique({
      where: { id },
    });
    if (!assessment) {
      throw new NotFoundException('Assessment is not found');
    }
    return await this.prisma.assessment.delete({
      where: { id },
    });
  }
}
