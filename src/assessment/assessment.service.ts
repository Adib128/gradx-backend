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
import { connect } from 'http2';

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

  async generate(
    tenantId: number,
    courseId: number,
    generateAssessmentDto: GenerateAssessmentDto,
  ) {
    const enrichedTopicGenerations = await Promise.all(
      generateAssessmentDto.topicGenerations.map(async (topicGen) => {
        const topic = await this.prisma.topic.findUnique({
          where: { id: topicGen.topicId },
          select: { id: true, title: true, topicNumber: true },
        });

        const clos = await this.prisma.clo.findMany({
          where: {
            id: { in: topicGen.cloIds },
          },
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

    const promptPayload = {
      assessment: generateAssessmentDto.assessment,
      topicGenerations: enrichedTopicGenerations,
    };

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'user',
          content: GENERATE_COURSE_PROMPT(promptPayload),
        },
      ],
    });

    return response.choices[0].message.content;
  }

  async update(
    tenantId: number,
    assessmentId: number,
    createAssessmentDto: CreateAssessmentDto,
  ) {
    const { questions, topicIds, cloIds, ...assessmentFields } =
      createAssessmentDto;
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const assessment = await tx.assessment.update({
            where: { id: assessmentId },
            data: {
              ...assessmentFields,
              tenantId,
              assessmentTopics: {
                create: topicIds.map((topicId) => ({ topicId })),
              },
              questions: {
                create: questions.map((question) => {
                  const { questionOptions, ...questionFields } = question;
                  return {
                    ...questionFields,
                    tenantId,
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
                  };
                }),
              },
            },
            include: {
              questions: {
                include: {
                  questionOptions: true,
                },
              },
            },
          });
          return assessment;
        },
        {
          maxWait: 15000,
          timeout: 30000,
        },
      );
    } catch (error) {
      console.log(error);
      throw new InternalServerErrorException('Could not create assessment');
    }
  }

  async findOne(tenantId: number, assessmentId: number) {
    const assessment = await this.prisma.assessment.findFirst({
      where: { id: assessmentId, tenantId },
      include: {
        assessmentTopics: {
          include: {
            topic: {
              include: {
                questions: {
                  where: { assessmentId },
                  include: {
                    questionOptions: {
                      orderBy: { order: 'asc' },
                    },
                  },
                  orderBy: { id: 'asc' },
                },
              },
            },
          },
          orderBy: { topicId: 'asc' },
        },
      },
    });
    if (!assessment) {
      throw new NotFoundException('Assessment not found');
    }
    return assessment;
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
                    questionOptions: {
                      orderBy: { order: 'asc' },
                    },
                  },
                },
              },
            },
          },
          orderBy: { topicId: 'asc' },
        },
      },
    });
  }
}
