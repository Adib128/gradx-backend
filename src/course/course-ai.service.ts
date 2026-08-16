import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { EXTRACT_COURSE_PROMPT } from './prompts/extract-course.prompt';
import { CLO_ANALYSIS_PROMPT } from './prompts/clo-analysis.prompt';
import { CLO_ANALYSIS_ALL_PROMPT } from './prompts/clo-analysis-all.prompt';
import { inflateRawSync } from 'zlib';
import { createHash } from 'crypto';
import { ErrorMessageKey } from 'src/common/constants/error-message';
import { OPENROUTER_MAX_OUTPUT_TOKENS } from 'src/common/constants/openrouter';
import { createChatCompletion } from 'src/common/helpers/openrouter-chat.helper';
import { extractPdfText } from 'src/topic-content/utils/extract-pdf-text.util';

/** Keep course-spec text prompts within a safe model context budget. */
const MAX_COURSE_SPEC_TEXT_CHARS = 100_000;

/** Prefer local text extract when the PDF has at least this many characters. */
const MIN_PDF_TEXT_CHARS_FOR_TEXT_PATH = 200;

@Injectable()
export class CourseAIService {
  private readonly logger = new Logger(CourseAIService.name);
  private readonly client: OpenAI;
  private readonly model: string;
  constructor(private readonly config: ConfigService) {
    this.client = new OpenAI({
      apiKey: this.config.get<string>('OPENROUTER_API_KEY'),
      baseURL: this.config.get<string>('OPENROUTER_BASE_URL'),
    });
    this.model = this.config.get<string>('OPENROUTER_MODEL')!;
  }

  async extractFromBase64(
    base64: string,
    mimeType?: string,
    filename?: string,
  ): Promise<any> {
    const buffer = Buffer.from(base64, 'base64');
    const normalizedMimeType = (mimeType ?? '').toLowerCase();
    const normalizedFilename = (filename ?? '').toLowerCase();

    if (
      normalizedMimeType.includes(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ) ||
      normalizedFilename.endsWith('.docx')
    ) {
      return this.extractFromDocxBuffer(buffer);
    }

    if (
      normalizedMimeType.includes('application/pdf') ||
      normalizedFilename.endsWith('.pdf') ||
      !mimeType
    ) {
      return this.extractFromPdfBuffer(buffer, base64);
    }

    throw new BadRequestException(
      ErrorMessageKey.COURSE_EXTRACT_UNSUPPORTED_FILE,
    );
  }

  /**
   * Course specs are typically text-layer PDFs. Prefer local text → JSON
   * (same path as DOCX). Fall back to vision/file upload when text is thin.
   */
  private async extractFromPdfBuffer(
    buffer: Buffer,
    base64: string,
  ): Promise<any> {
    let pdfText = '';
    try {
      pdfText = (await extractPdfText(buffer)).trim();
    } catch (error) {
      this.logger.warn(
        `PDF text extraction failed; falling back to vision: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (pdfText.length >= MIN_PDF_TEXT_CHARS_FOR_TEXT_PATH) {
      try {
        return await this.extractFromCourseSpecText(pdfText, 'PDF');
      } catch (error) {
        const isInvalidAi =
          error instanceof BadRequestException &&
          (error.getResponse() as { message?: string })?.message ===
            ErrorMessageKey.COURSE_EXTRACT_AI_INVALID_RESPONSE;
        if (!isInvalidAi) throw error;
        this.logger.warn(
          'Text-path course extract returned invalid JSON; retrying with PDF vision.',
        );
      }
    }

    return this.extractFromPdfVisionBase64(base64);
  }

  private async extractFromCourseSpecText(
    documentText: string,
    sourceLabel: string,
  ): Promise<any> {
    const truncated =
      documentText.length > MAX_COURSE_SPEC_TEXT_CHARS
        ? `${documentText.slice(0, MAX_COURSE_SPEC_TEXT_CHARS)}\n\n[…truncated…]`
        : documentText;

    const response = await createChatCompletion(this.client, {
      model: this.model,
      max_tokens: OPENROUTER_MAX_OUTPUT_TOKENS,
      messages: [
        {
          role: 'user',
          content: `${EXTRACT_COURSE_PROMPT}

Extract the course specification from the following ${sourceLabel} text content:

${truncated}`,
        },
      ],
      response_format: { type: 'json_object' },
    });

    const text = response.choices[0]?.message?.content ?? '';
    return this.parseResponse(text);
  }

  private async extractFromPdfVisionBase64(base64: string): Promise<any> {
    const response = await createChatCompletion(this.client, {
      model: this.model,
      max_tokens: OPENROUTER_MAX_OUTPUT_TOKENS,
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

  private async extractFromDocxBuffer(buffer: Buffer): Promise<any> {
    const documentXml = this.readZipTextFile(buffer, 'word/document.xml');
    const documentText = this.extractTextFromWordXml(documentXml);

    if (!documentText.trim()) {
      throw new BadRequestException(ErrorMessageKey.COURSE_EXTRACT_EMPTY_DOCX);
    }

    return this.extractFromCourseSpecText(documentText, 'DOCX');
  }

  private readZipTextFile(buffer: Buffer, filename: string): string {
    const endOfCentralDirectoryOffset = this.findEndOfCentralDirectory(buffer);

    if (endOfCentralDirectoryOffset < 0) {
      throw new BadRequestException(ErrorMessageKey.COURSE_EXTRACT_INVALID_DOCX);
    }

    const totalEntries = buffer.readUInt16LE(endOfCentralDirectoryOffset + 10);
    const centralDirectoryOffset = buffer.readUInt32LE(
      endOfCentralDirectoryOffset + 16,
    );

    let cursor = centralDirectoryOffset;

    for (let index = 0; index < totalEntries; index++) {
      if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
        break;
      }

      const compressionMethod = buffer.readUInt16LE(cursor + 10);
      const compressedSize = buffer.readUInt32LE(cursor + 20);
      const fileNameLength = buffer.readUInt16LE(cursor + 28);
      const extraFieldLength = buffer.readUInt16LE(cursor + 30);
      const fileCommentLength = buffer.readUInt16LE(cursor + 32);
      const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
      const entryName = buffer
        .subarray(cursor + 46, cursor + 46 + fileNameLength)
        .toString('utf8');

      if (entryName === filename) {
        return this.readZipEntryData(
          buffer,
          localHeaderOffset,
          compressedSize,
          compressionMethod,
        ).toString('utf8');
      }

      cursor += 46 + fileNameLength + extraFieldLength + fileCommentLength;
    }

    throw new BadRequestException(ErrorMessageKey.COURSE_EXTRACT_INVALID_DOCX);
  }

  private findEndOfCentralDirectory(buffer: Buffer): number {
    for (let offset = buffer.length - 22; offset >= 0; offset--) {
      if (buffer.readUInt32LE(offset) === 0x06054b50) {
        return offset;
      }
    }

    return -1;
  }

  private readZipEntryData(
    buffer: Buffer,
    localHeaderOffset: number,
    compressedSize: number,
    compressionMethod: number,
  ): Buffer {
    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new BadRequestException(ErrorMessageKey.COURSE_EXTRACT_INVALID_DOCX);
    }

    const fileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const extraFieldLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + fileNameLength + extraFieldLength;
    const compressedData = buffer.subarray(
      dataOffset,
      dataOffset + compressedSize,
    );

    if (compressionMethod === 0) {
      return compressedData;
    }

    if (compressionMethod === 8) {
      return inflateRawSync(compressedData);
    }

    throw new BadRequestException(ErrorMessageKey.COURSE_EXTRACT_INVALID_DOCX);
  }

  private extractTextFromWordXml(xml: string): string {
    return xml
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  async analyzeCloAchievement(payload: {
    code: string;
    description: string;
    achievementRate: number | null;
    thresholdScore: number;
    maxScore: number;
    studentsMet: number;
    totalStudents: number;
    avgScore: number | null;
    avgScoreLabel?: string;
    achieved: boolean;
    statusLabel: string;
    passRatePercent: number;
    hasGradingData: boolean;
    assessmentSources: Array<{
      title: string;
      cloMarks: number;
      questionNumbers: number[];
    }>;
    assessmentSourcesSummary: string;
  }) {
    const fallback = this.buildCloAnalysisFallback(payload);

    try {
      const response = await createChatCompletion(this.client, {
        model: this.model,
        max_tokens: OPENROUTER_MAX_OUTPUT_TOKENS,
        messages: [
          {
            role: 'user',
            content: `${CLO_ANALYSIS_PROMPT}

CLO data:
${JSON.stringify(payload, null, 2)}`,
          },
        ],
        response_format: { type: 'json_object' },
      });

      const text = response.choices[0]?.message?.content ?? '';
      const parsed = this.parseResponse(text) as {
        title?: string;
        paragraphs?: string[];
        highlightPercent?: number;
      };

      const paragraphs = Array.isArray(parsed.paragraphs)
        ? parsed.paragraphs.map((item) => String(item || '').trim()).filter(Boolean)
        : [];

      if (!parsed.title || paragraphs.length === 0) {
        return fallback;
      }

      return {
        title: String(parsed.title),
        paragraphs: paragraphs.slice(0, 3),
        highlightPercent:
          typeof parsed.highlightPercent === 'number'
            ? parsed.highlightPercent
            : fallback.highlightPercent,
      };
    } catch {
      return fallback;
    }
  }

  async analyzeAllCloAchievements(payload: {
    passRatePercent: number;
    clos: Array<{
      cloId: number;
      code: string;
      description: string;
      achievementRate: number | null;
      thresholdScore: number;
      maxScore: number;
      studentsMet: number;
      totalStudents: number;
      avgScore: number | null;
      avgScoreLabel: string;
      avgPercent: number | null;
      achieved: boolean;
      statusLabel: string;
      hasGradingData: boolean;
      assessmentSourcesSummary: string;
    }>;
  }) {
    const fallback = this.buildAllCloAnalysisFallback(payload);

    try {
      const response = await createChatCompletion(this.client, {
        model: this.model,
        max_tokens: OPENROUTER_MAX_OUTPUT_TOKENS,
        messages: [
          {
            role: 'user',
            content: `${CLO_ANALYSIS_ALL_PROMPT}

Course CLO achievement data:
${JSON.stringify(payload, null, 2)}`,
          },
        ],
        response_format: { type: 'json_object' },
      });

      const text = response.choices[0]?.message?.content ?? '';
      const parsed = this.parseResponse(text) as {
        overview?: { title?: string; paragraphs?: string[] };
        analyses?: Array<{
          cloId?: number;
          code?: string;
          title?: string;
          paragraphs?: string[];
          highlightPercent?: number;
        }>;
      };

      const overviewParagraphs = Array.isArray(parsed.overview?.paragraphs)
        ? parsed.overview.paragraphs
            .map((item) => String(item || '').trim())
            .filter(Boolean)
        : [];

      const analyses = payload.clos.map((clo, index) => {
        const match =
          (parsed.analyses ?? []).find((item) => item.cloId === clo.cloId) ??
          (parsed.analyses ?? [])[index];
        const paragraphs = Array.isArray(match?.paragraphs)
          ? match.paragraphs.map((item) => String(item || '').trim()).filter(Boolean)
          : [];
        if (!match?.title || paragraphs.length === 0) {
          return fallback.analyses[index];
        }
        return {
          cloId: clo.cloId,
          code: clo.code,
          title: String(match.title),
          paragraphs: paragraphs.slice(0, 4),
          highlightPercent:
            typeof match.highlightPercent === 'number'
              ? match.highlightPercent
              : clo.achievementRate ?? 0,
        };
      });

      return {
        overview: {
          title:
            String(parsed.overview?.title || '').trim() ||
            fallback.overview.title,
          paragraphs:
            overviewParagraphs.length > 0
              ? overviewParagraphs.slice(0, 4)
              : fallback.overview.paragraphs,
        },
        analyses,
      };
    } catch {
      return fallback;
    }
  }

  buildCloAnalysisFingerprint(
    passRatePercent: number,
    clos: Array<{
      cloId: number;
      achievementRate: number | null;
      studentsMet: number;
      totalStudents: number;
      avgScore: number | null;
      maxScore: number;
      achieved: boolean;
    }>,
  ) {
    const payload = {
      passRatePercent,
      clos: clos.map((clo) => ({
        cloId: clo.cloId,
        achievementRate: clo.achievementRate,
        studentsMet: clo.studentsMet,
        totalStudents: clo.totalStudents,
        avgScore: clo.avgScore,
        maxScore: clo.maxScore,
        achieved: clo.achieved,
      })),
    };
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  private buildAllCloAnalysisFallback(payload: {
    passRatePercent: number;
    clos: Array<{
      cloId: number;
      code: string;
      description: string;
      achievementRate: number | null;
      studentsMet: number;
      totalStudents: number;
      avgScoreLabel: string;
      achieved: boolean;
      statusLabel: string;
      hasGradingData: boolean;
      assessmentSourcesSummary: string;
    }>;
  }) {
    const achievedCount = payload.clos.filter((clo) => clo.achieved).length;
    const weakest = [...payload.clos]
      .filter((clo) => clo.achievementRate != null)
      .sort((a, b) => (a.achievementRate ?? 0) - (b.achievementRate ?? 0))[0];

    return {
      overview: {
        title: 'Course CLO achievement overview',
        paragraphs: [
          `Across ${payload.clos.length} CLOs, ${achievedCount} met the course pass-rate threshold of ${payload.passRatePercent}%, while ${payload.clos.length - achievedCount} remain below target.`,
          weakest
            ? `The lowest achievement rate is CLO ${weakest.code} at ${weakest.achievementRate}%. Prioritize instructional reinforcement for this outcome in the next teaching cycle.`
            : 'Grading coverage is incomplete, so priority actions should start with confirming assessments and CLO mappings.',
        ],
      },
      analyses: payload.clos.map((clo, index) => {
        const analysis = this.buildCloAnalysisFallback({
          code: clo.code,
          description: clo.description,
          achievementRate: clo.achievementRate,
          studentsMet: clo.studentsMet,
          totalStudents: clo.totalStudents,
          achieved: clo.achieved,
          statusLabel: clo.statusLabel,
          hasGradingData: clo.hasGradingData,
          assessmentSourcesSummary: clo.assessmentSourcesSummary,
        });
        return {
          cloId: clo.cloId,
          code: clo.code,
          ...analysis,
          paragraphs: [
            ...analysis.paragraphs,
            `Class average on this outcome is ${payload.clos[index].avgScoreLabel}. Use formative checks aligned to this CLO before the next weighted assessment.`,
          ].slice(0, 3),
        };
      }),
    };
  }

  private buildCloAnalysisFallback(payload: {
    code: string;
    description: string;
    achievementRate: number | null;
    studentsMet: number;
    totalStudents: number;
    achieved: boolean;
    statusLabel: string;
    hasGradingData: boolean;
    assessmentSourcesSummary: string;
  }) {
    const status = payload.achieved ? 'achieved' : 'not achieved';
    const rate =
      payload.achievementRate != null ? String(payload.achievementRate) : '0';
    const description =
      String(payload.description || '').trim() || 'No description available';

    const paragraph1 = payload.hasGradingData
      ? `CLO ${payload.code}, "${description}", was achieved by ${rate}% of students, with ${payload.studentsMet} out of ${payload.totalStudents} students meeting the per-student threshold.`
      : `CLO ${payload.code}, "${description}", does not have confirmed grading data yet, so an achievement rate cannot be computed.`;

    const paragraph2 = payload.hasGradingData
      ? `${payload.assessmentSourcesSummary} A recommended action for the next semester is to reinforce the skills behind this outcome with targeted practice and formative feedback before the next major assessment.`
      : `Link assessment questions to this CLO and confirm grading scans so instructors can monitor achievement against the course pass-rate threshold.`;

    return {
      title: `CLO ${payload.code} analysis — ${status}`,
      paragraphs: [paragraph1, paragraph2],
      highlightPercent: payload.achievementRate ?? 0,
    };
  }

  /**
   * Models often wrap JSON in fences or emit LaTeX-style single backslashes
   * that break strict JSON.parse. Repair and slice to the outermost object.
   */
  private repairJsonEscapes(input: string): string {
    return input.replace(
      /\\(u[0-9a-fA-F]{4}|[\s\S]|$)/g,
      (match, seq: string) =>
        /^(?:["\\/nr]|u[0-9a-fA-F]{4})$/.test(seq) ? match : `\\\\${seq}`,
    );
  }

  private extractJsonObject(text: string): string {
    const cleaned = text
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();

    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return cleaned.slice(start, end + 1);
    }
    return cleaned;
  }

  private parseResponse(text: string): any {
    const cleaned = this.repairJsonEscapes(this.extractJsonObject(text || ''));

    if (!cleaned) {
      throw new BadRequestException(
        ErrorMessageKey.COURSE_EXTRACT_AI_INVALID_RESPONSE,
      );
    }

    try {
      return JSON.parse(cleaned);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const pos = Number(/position (\d+)/i.exec(message)?.[1] ?? 0);
      this.logger.warn(
        `Course extract JSON parse failed: ${message}; context=${JSON.stringify(
          cleaned.slice(Math.max(0, pos - 60), pos + 60),
        )}`,
      );
      throw new BadRequestException(
        ErrorMessageKey.COURSE_EXTRACT_AI_INVALID_RESPONSE,
      );
    }
  }
}
