import { Injectable } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { GenerateAssessmentDto } from './dto/generate-assessment.dto';
import OpenAI from 'openai';
import { ConfigService } from '@nestjs/config';
import { GENERATE_COURSE_PROMPT } from './prompts/generate-assessment.prompt';

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
    // 1. Resolve all asynchronous database queries concurrently
    const enrichedTopicGenerations = await Promise.all(
      generateAssessmentDto.topicGenerations.map(async (topicGen) => {
        // Fetch the full topic details
        const topic = await this.prisma.topic.findUnique({
          where: { id: topicGen.topicId },
          select: { id: true, title: true, topicNumber: true },
        });

        // Fetch the full CLO details for this specific topic configuration
        const clos = await this.prisma.clo.findMany({
          where: {
            id: { in: topicGen.cloIds },
          },
          select: { code: true, description: true, category: true },
        });

        // Combine the original DTO configurations with the rich DB data
        return {
          ...topicGen, // topicId, cloIds, blooms, questionTypes
          topicTitle: topic?.title ?? 'Unknown Topic',
          topicNumber: topic?.topicNumber ?? 0,
          closDetails: clos, // The rich array containing code, description, etc.
        };
      }),
    );

    // 2. Build the aggregate execution job payload for the prompt
    const promptPayload = {
      assessment: generateAssessmentDto.assessment,
      topicGenerations: enrichedTopicGenerations,
    };

    // 3. Fire the OpenRouter/OpenAI generation completion
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
}
