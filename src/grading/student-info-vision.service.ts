import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { createChatCompletion } from '../common/helpers/openrouter-chat.helper';

export type StudentInfoRead = {
  name: string | null;
  section: string | null;
};

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EXT_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹';

const PROMPT = [
  'This image is the "Name / Section" box at the top of a student answer sheet.',
  'The student wrote by hand: their full name next to the printed label "Name:" and their section / group number next to the printed label "section:".',
  'The name is usually Arabic handwriting (read right to left) but can be English.',
  'Transcribe exactly what the student wrote. Do not translate, do not correct spelling, do not include the printed labels, and ignore anything outside the box.',
  'Write Arabic names in Arabic letters in natural reading order, separating words with single spaces.',
  'The section is a short number or code; write it with Western digits (0-9).',
  'A field is empty when nothing is handwritten after its printed label: then use null. Never output the printed labels, never guess or invent text, and never describe the image.',
  'If a field is unreadable use null.',
  'Reply with ONLY compact JSON: {"name": string|null, "section": string|null}',
].join(' ');

const idCheckPrompt = (bubbled: string) =>
  [
    'This image shows a row of boxes where a student hand-wrote their Student ID, one digit per box, left to right.',
    `The ID filled in on the bubble grid is ${bubbled} (${bubbled.length} digits, so ${bubbled.length} boxes).`,
    'For each box in order, judge the handwriting against the expected digit: answer "differs" ONLY if the handwriting clearly and unmistakably shows a different digit; answer "ok" if it matches, is ambiguous, messy, or empty.',
    'Messy handwriting is normal (a 0 may look like an "o", a 9 like a "q"), so when in doubt answer "ok".',
    `Reply with ONLY compact JSON: {"boxes": [${bubbled.length} strings, each "ok" or "differs"]}`,
  ].join(' ');

/** Reads handwritten name + section from the cropped capsule with a vision LLM. */
@Injectable()
export class StudentInfoVisionService {
  private readonly logger = new Logger(StudentInfoVisionService.name);
  private readonly client: OpenAI | null;
  private readonly model: string | null;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('OPENROUTER_API_KEY');
    this.model =
      this.config.get<string>('OPENROUTER_VISION_MODEL') ||
      this.config.get<string>('OPENROUTER_MODEL') ||
      null;
    this.client = apiKey
      ? new OpenAI({
          apiKey,
          baseURL: this.config.get<string>('OPENROUTER_BASE_URL'),
          timeout: 20000,
          maxRetries: 0,
        })
      : null;
  }

  get enabled() {
    return Boolean(this.client && this.model);
  }

  async read(
    pngBase64: string,
    context: { userId?: number | null; tenantId?: number | null },
  ): Promise<StudentInfoRead | null> {
    if (!this.client || !this.model || !pngBase64) return null;
    try {
      const response = await createChatCompletion(
        this.client,
        {
          model: this.model,
          max_tokens: 1000,
          temperature: 0,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: PROMPT },
                {
                  type: 'image_url',
                  image_url: { url: `data:image/png;base64,${pngBase64}` },
                },
              ],
            },
          ],
          // Plain transcription: skip hidden "thinking" so it is fast and cheap.
          reasoning: { max_tokens: 0 },
        } as never,
        {
          userId: context.userId ?? null,
          tenantId: context.tenantId ?? null,
          purpose: 'grading_student_info',
        },
      );
      const text = response.choices?.[0]?.message?.content ?? '';
      return this.parse(text);
    } catch (err) {
      this.logger.warn(
        `Vision name/section read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  parse(raw: string): StudentInfoRead | null {
    const match = /\{[\s\S]*\}/.exec(raw ?? '');
    if (!match) return null;
    let data: { name?: unknown; section?: unknown };
    try {
      data = JSON.parse(match[0]);
    } catch {
      return null;
    }
    const name = this.cleanName(data.name);
    const section = this.cleanSection(data.section);
    // Valid JSON with both fields null is a real answer: "the box is empty".
    return { name, section };
  }

  private cleanName(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const v = value
      .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
      .replace(/^(?:name|الاسم|اسم)\s*[:：]\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (v.length < 2 || /^(null|none|n\/a|unreadable)$/i.test(v)) return null;
    return v.slice(0, 80);
  }

  private cleanSection(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    let v = String(value)
      .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
      .trim();
    v = v.replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d)));
    v = v.replace(/[۰-۹]/g, (d) => String(EXT_ARABIC_INDIC.indexOf(d)));
    v = v.replace(/^(?:section|sec|الشعبة|شعبة)\s*[:：]?\s*/i, '').trim();
    if (!v || /^(null|none|n\/a|unreadable)$/i.test(v)) return null;
    return v.slice(0, 16);
  }

  /**
   * Second opinion on the Student ID. The bubbles stay the source of truth: the
   * model only judges, box by box, whether the hand-written digits clearly
   * contradict the bubbled ID. Handwriting is messy, so it is told to answer
   * "differs" only when sure. Returns how many boxes clearly differ, or null
   * when the model is unavailable or answered nonsense.
   */
  async countClearlyDifferentIdBoxes(
    pngBase64: string,
    bubbled: string,
    context: { userId?: number | null; tenantId?: number | null },
  ): Promise<number | null> {
    if (!this.client || !this.model || !pngBase64) return null;
    try {
      const response = await createChatCompletion(
        this.client,
        {
          model: this.model,
          max_tokens: 200,
          temperature: 0,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: idCheckPrompt(bubbled) },
                {
                  type: 'image_url',
                  image_url: { url: `data:image/png;base64,${pngBase64}` },
                },
              ],
            },
          ],
          reasoning: { max_tokens: 0 },
        } as never,
        {
          userId: context.userId ?? null,
          tenantId: context.tenantId ?? null,
          purpose: 'grading_student_id_check',
        },
      );
      return this.parseIdBoxVerdicts(
        response.choices?.[0]?.message?.content ?? '',
        bubbled.length,
      );
    } catch (err) {
      this.logger.warn(
        `Vision student-id check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  parseIdBoxVerdicts(raw: string, expectedBoxes: number): number | null {
    const match = /\{[\s\S]*\}/.exec(raw ?? '');
    if (!match) return null;
    let data: { boxes?: unknown };
    try {
      data = JSON.parse(match[0]);
    } catch {
      return null;
    }
    if (!Array.isArray(data.boxes) || data.boxes.length !== expectedBoxes) return null;
    return data.boxes.filter(
      (verdict) => String(verdict).trim().toLowerCase() === 'differs',
    ).length;
  }
}
