import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { EXTRACT_COURSE_PROMPT } from './prompts/extract-course.prompt';

@Injectable()
export class CourseAIService {
  private readonly client: OpenAI;
  private readonly model: string;
  constructor(private readonly config: ConfigService) {
    this.client = new OpenAI({
      apiKey: this.config.get<string>('OPENROUTER_API_KEY'),
      baseURL: this.config.get<string>('OPENROUTER_BASE_URL'),
    });
    this.model = this.config.get<string>('OPENROUTER_MODEL')!;
  }

  async extractFromBase64(base64: string): Promise<any> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:application/pdf;base64,${base64}`,
              },
            },
            {
              type: 'text',
              text: EXTRACT_COURSE_PROMPT,
            },
          ],
        },
      ],
    });

    const text = response.choices[0]?.message?.content ?? '';

    return this.parseResponse(text);
  }

  private parseResponse(text: string): any {
    try {
      const clean = text.replace(/```json|```/g, '').trim();
      return JSON.parse(clean);
    } catch {
      throw new BadRequestException(
        'AI returned an invalid response. Please try again.',
      );
    }
  }
}
