import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { EXTRACT_COURSE_PROMPT } from './prompts/extract-course.prompt';
import { inflateRawSync } from 'zlib';

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
      return this.extractFromPdfBase64(base64);
    }

    throw new BadRequestException(
      'Unsupported file type. Please upload a PDF or DOCX file.',
    );
  }

  private async extractFromPdfBase64(base64: string): Promise<any> {
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

  private async extractFromDocxBuffer(buffer: Buffer): Promise<any> {
    const documentXml = this.readZipTextFile(buffer, 'word/document.xml');
    const documentText = this.extractTextFromWordXml(documentXml);

    if (!documentText.trim()) {
      throw new BadRequestException('DOCX file does not contain readable text.');
    }

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'user',
          content: `${EXTRACT_COURSE_PROMPT}

Extract the course specification from the following DOCX text content:

${documentText}`,
        },
      ],
      response_format: { type: 'json_object' },
    });

    const text = response.choices[0]?.message?.content ?? '';

    return this.parseResponse(text);
  }

  private readZipTextFile(buffer: Buffer, filename: string): string {
    const endOfCentralDirectoryOffset = this.findEndOfCentralDirectory(buffer);

    if (endOfCentralDirectoryOffset < 0) {
      throw new BadRequestException('Invalid DOCX file.');
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

    throw new BadRequestException('DOCX document body was not found.');
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
      throw new BadRequestException('Invalid DOCX file entry.');
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

    throw new BadRequestException('Unsupported DOCX compression method.');
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
