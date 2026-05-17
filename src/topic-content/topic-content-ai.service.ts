import { ConfigService } from '@nestjs/config';
import { ContentType } from 'generated/prisma/enums';
import OpenAI from 'openai';
import { ContentGenerationJob } from './interfaces/content-generation-job.interface';
import { BadRequestException, Injectable } from '@nestjs/common';
import {
  LECTURE_PROMPT,
  SLIDES_PROMPT,
  QUIZ_PROMPT,
  LAB_PROMPT,
} from './prompts';

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
    const promptMap: Partial<Record<ContentType, string>> = {
      LECTURE: LECTURE_PROMPT(data),
      SLIDES: SLIDES_PROMPT(data),
      QUIZ: QUIZ_PROMPT(data),
      LAB: LAB_PROMPT(data),
    };

    const prompt = promptMap[type];
    if (!prompt)
      throw new BadRequestException(`Content type ${type} not supported yet`);

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.choices[0]?.message?.content ?? '';

    return this.parseResponse(text);
  }

  private parseResponse(text: string): any {
    let clean = text
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    // step 1: normalize multiple backslashes to single
    clean = clean.replace(/\\{2,}/g, '\\');

    // step 2: fix remaining single invalid backslashes
    clean = clean.replace(/\\([^"\\/bfnrtu\n\r])/g, (_, char) => `\\\\${char}`);

    try {
      return JSON.parse(clean);
    } catch (e) {
      const pos = parseInt(e.message.match(/position (\d+)/)?.[1] ?? '0');
      console.log(
        'CONTEXT:',
        JSON.stringify(clean.substring(pos - 50, pos + 50)),
      );
      throw new BadRequestException('AI returned invalid response');
    }
  }
}
