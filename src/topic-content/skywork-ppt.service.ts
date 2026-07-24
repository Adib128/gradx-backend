import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { ContentGenerationJob } from './interfaces/content-generation-job.interface';
import { ErrorMessageKey } from 'src/common/constants/error-message';
import { normalizeGenerationErrorKey } from 'src/common/helpers/generation-error.helper';

export type SkyworkPptProgress = {
  stage: string;
  percent: number;
  message: string;
  outline?: string;
};

export type SkyworkPptResult = {
  source: 'skywork';
  provider: 'skywork';
  fileName: string;
  filePath: string;
  mimeType: string;
  size: number;
  downloadUrl: string;
  sessionId: string;
  query: string;
  outline?: string;
  generatedAt: string;
  courseTitle: string;
  topicTitle: string;
  topicNumber: number;
};

@Injectable()
export class SkyworkPptService {
  private readonly logger = new Logger(SkyworkPptService.name);
  private readonly apiKey: string;
  private readonly gatewayUrl: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('SKYWORK_API_KEY') ?? '';
    this.gatewayUrl =
      this.config.get<string>('SKYWORK_GATEWAY_URL') ??
      'https://api-tools.skywork.ai/theme-gateway';
  }

  async generateSlides(
    data: ContentGenerationJob,
    onProgress?: (progress: SkyworkPptProgress) => Promise<void> | void,
  ): Promise<SkyworkPptResult> {
    if (!this.apiKey) {
      throw new BadRequestException(ErrorMessageKey.SKYWORK_API_KEY_MISSING);
    }

    const { query, reference, language } = this.buildPrompt(data);
    const sessionId = randomUUID().replace(/-/g, '_');
    const url = `${this.gatewayUrl.replace(/\/$/, '')}/ppt_write_stream`;

    await onProgress?.({
      stage: 'start',
      percent: 2,
      message: 'Starting Skywork slide generation…',
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'Session-Id': sessionId,
        Language: language,
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        query,
        language,
        reference,
        source_platform: '',
      }),
    });

    if (!response.ok || !response.body) {
      const errText = await response.text().catch(() => '');
      this.logger.error(`Skywork PPT HTTP ${response.status}: ${errText}`);
      const key = normalizeGenerationErrorKey(
        `${response.status} ${errText}`,
        ErrorMessageKey.SKYWORK_PPT_GENERATION_FAILED,
      );
      throw new BadRequestException(key);
    }

    let downloadUrl = '';
    let outline = '';
    let lastPercent = 5;

    for await (const { event, data: eventData } of this.parseSse(
      response.body as ReadableStream<Uint8Array>,
    )) {
      if (event === 'phase') {
        const phase = String(eventData.phase ?? '');
        const mapped = this.mapPhase(phase, eventData, lastPercent);
        lastPercent = mapped.percent;
        if (phase === 'outline_done' && eventData.outline) {
          outline = String(eventData.outline);
        }
        await onProgress?.(mapped);
      } else if (event === 'completionEvent') {
        if (eventData.phase === 'done') {
          downloadUrl = String(eventData.download_url ?? '');
          await onProgress?.({
            stage: 'download',
            percent: 95,
            message: 'Skywork export ready. Downloading PPTX…',
            outline: outline || undefined,
          });
        }
      } else if (event === 'error') {
        const message = String(eventData.message ?? 'Skywork PPT generation error');
        throw new BadRequestException(
          normalizeGenerationErrorKey(
            message,
            ErrorMessageKey.SKYWORK_PPT_GENERATION_FAILED,
          ),
        );
      }
    }

    if (!downloadUrl) {
      throw new BadRequestException(ErrorMessageKey.SKYWORK_PPT_NO_DOWNLOAD_URL);
    }

    const saved = await this.downloadAndStore(
      downloadUrl,
      data.tenantId,
      data.topicId,
      data.topicTitle,
    );

    await onProgress?.({
      stage: 'done',
      percent: 100,
      message: 'Skywork slides ready',
      outline: outline || undefined,
    });

    return {
      source: 'skywork',
      provider: 'skywork',
      fileName: saved.fileName,
      filePath: saved.filePath,
      mimeType:
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      size: saved.size,
      downloadUrl,
      sessionId,
      query,
      outline: outline || undefined,
      generatedAt: new Date().toISOString(),
      courseTitle: data.courseTitle,
      topicTitle: data.topicTitle,
      topicNumber: data.topicNumber,
    };
  }

  private buildPrompt(data: ContentGenerationJob): {
    query: string;
    reference: string;
    language: string;
  } {
    const cloLines = data.clos
      .map((c) => `- [${c.code}] ${c.description}`)
      .join('\n');

    const query = [
      `Create a professional university lecture PowerPoint for live classroom teaching.`,
      ``,
      `Course: ${data.courseTitle}`,
      `Topic ${data.topicNumber}: ${data.topicTitle}`,
      `Audience: ${data.audience}`,
      `Academic depth: ${data.contentDepth}`,
      `Difficulty: ${data.difficulty}`,
      `Bloom levels: ${data.bloomsTaxonomyLevels.join(', ') || 'Understand, Apply, Analyze'}`,
      ``,
      `Design requirements:`,
      `- Academic university style a professor can present immediately`,
      `- Title, measurable learning outcomes, agenda, section dividers`,
      `- One idea per slide, concise bullets (max ~5), no paragraph walls`,
      `- Include definitions, worked examples with steps, formulas, and diagrams where relevant`,
      `- Include formative checkpoints and a closing summary with take-home questions`,
      `- Align content to these CLOs when possible:`,
      cloLines || '- (use topic objectives)',
      ``,
      `Use the attached lecture notes as the single source of truth for sequence, terminology, examples, and assessment focus.`,
      `Do not invent a different syllabus.`,
    ].join('\n');

    const referenceRaw = this.lectureToReference(data.sourceLectureContent);
    const reference =
      referenceRaw.length > 48000
        ? `${referenceRaw.slice(0, 48000)}\n\n[truncated for length]`
        : referenceRaw;

    return { query, reference, language: 'English' };
  }

  private lectureToReference(content: unknown): string {
    if (!content) return 'No lecture notes provided.';
    if (typeof content === 'string') return content;
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return String(content);
    }
  }

  private mapPhase(
    phase: string,
    data: Record<string, unknown>,
    lastPercent: number,
  ): SkyworkPptProgress {
    const pingProgress = Number(data.progress);
    if (phase === 'ping' && Number.isFinite(pingProgress)) {
      const normalized = Math.round(pingProgress);
      return {
        stage: String(data.stage ?? 'working'),
        percent: Math.min(94, Math.max(lastPercent, normalized)),
        message: data.stage
          ? `Skywork: ${data.stage} (${normalized}%)`
          : `Skywork progress ${normalized}%`,
      };
    }

    const table: Record<string, { percent: number; message: string }> = {
      outline: { percent: 10, message: 'Generating outline…' },
      outline_page: {
        percent: 18,
        message: `Outline page ${data.page_num ?? ''}…`,
      },
      outline_done: { percent: 25, message: 'Outline ready. Building slides…' },
      slides: { percent: 35, message: 'Generating slides…' },
      slides_page_start: {
        percent: Math.min(80, lastPercent + 2),
        message: `Starting slide ${data.page_num ?? ''}…`,
      },
      slides_page: {
        percent: Math.min(85, lastPercent + 2),
        message: `Finished slide ${data.page_num ?? ''}`,
      },
      slides_done: { percent: 88, message: 'Slides ready. Exporting PPTX…' },
      export: {
        percent: 92,
        message:
          data.status === 'done'
            ? 'Export complete'
            : 'Exporting PPTX (this can take a few minutes)…',
      },
      done: { percent: 95, message: 'Generation complete' },
    };

    const mapped = table[phase] ?? {
      percent: Math.max(lastPercent, 8),
      message: phase ? `Skywork: ${phase}` : 'Skywork working…',
    };

    return {
      stage: phase || 'working',
      percent: Math.max(lastPercent, mapped.percent),
      message: mapped.message,
      outline:
        phase === 'outline_done' && data.outline
          ? String(data.outline)
          : undefined,
    };
  }

  private async *parseSse(
    body: ReadableStream<Uint8Array>,
  ): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let curEvent = '';
    let curData = '';

    const flush = (): { event: string; data: Record<string, unknown> } | null => {
      if (!curEvent && !curData) return null;
      let raw: any = {};
      try {
        raw = curData ? JSON.parse(curData) : {};
      } catch {
        raw = {};
      }
      let data = raw?.data ?? raw;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          data = {};
        }
      }
      if (!data || typeof data !== 'object') data = {};
      const result = { event: curEvent || 'message', data: data as Record<string, unknown> };
      curEvent = '';
      curData = '';
      return result;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line === '') {
          const item = flush();
          if (item) yield item;
          continue;
        }
        if (line.startsWith('event:')) {
          curEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          curData = line.slice(5).trim();
        }
      }
    }

    const trailing = flush();
    if (trailing) yield trailing;
  }

  private async downloadAndStore(
    downloadUrl: string,
    tenantId: number,
    topicId: number,
    topicTitle: string,
  ): Promise<{ fileName: string; filePath: string; size: number }> {
    const response = await fetch(downloadUrl, { method: 'GET' });
    if (!response.ok || !response.body) {
      throw new BadRequestException(ErrorMessageKey.SKYWORK_PPT_DOWNLOAD_FAILED);
    }

    const safeTitle = topicTitle
      .replace(/[^a-zA-Z0-9-_]+/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 40);
    const fileName = `Slides_${topicId}_${safeTitle || 'topic'}_${Date.now()}.pptx`;
    const uploadDir = join(
      process.cwd(),
      'tmp',
      'slide-uploads',
      String(tenantId),
    );
    await mkdir(uploadDir, { recursive: true });
    const absolutePath = join(uploadDir, fileName);
    const relativePath = join('tmp', 'slide-uploads', String(tenantId), fileName);

    // Remove older skywork pptx files for this topic prefix (best-effort)
    // Caller handles DB upsert; we only write the new file here.

    const nodeStream = Readable.fromWeb(response.body as any);
    await pipeline(nodeStream, createWriteStream(absolutePath));

    const fileStat = await stat(absolutePath);
    return { fileName, filePath: relativePath, size: fileStat.size };
  }

  async deleteStoredFile(relativePath: string | undefined) {
    if (!relativePath) return;
    try {
      await unlink(join(process.cwd(), relativePath));
    } catch {
      // ignore missing files
    }
  }
}
