import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONVERSION_TIMEOUT_MS = 120_000;

/**
 * Converts a .docx buffer to PDF with a headless LibreOffice, so the PDF of a
 * filled Word template looks like the Word file. Conversions run one at a
 * time (LibreOffice is memory hungry) and each uses its own profile folder.
 */
@Injectable()
export class DocxPdfService {
  private readonly logger = new Logger(DocxPdfService.name);
  private queue: Promise<unknown> = Promise.resolve();

  convert(docx: Buffer): Promise<Buffer> {
    const task = this.queue.then(() => this.run(docx));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async run(docx: Buffer): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'docx-pdf-'));
    const input = join(dir, 'report.docx');
    try {
      await writeFile(input, docx);
      await new Promise<void>((resolve, reject) => {
        execFile(
          process.env.SOFFICE_PATH || 'soffice',
          [
            '--headless',
            '--norestore',
            '--nolockcheck',
            `-env:UserInstallation=file://${join(dir, 'profile')}`,
            '--convert-to',
            'pdf',
            '--outdir',
            dir,
            input,
          ],
          { timeout: CONVERSION_TIMEOUT_MS },
          (error) => (error ? reject(error) : resolve()),
        );
      });
      return await readFile(join(dir, 'report.pdf'));
    } catch (error) {
      this.logger.error(
        `DOCX to PDF conversion failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException('PDF_CONVERSION_UNAVAILABLE');
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
