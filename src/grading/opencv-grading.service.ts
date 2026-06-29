import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

export type OpenCvProcessResult = {
  confidence: number;
  decodedFormId: number | null;
  answers: Record<string, string>;
  questionDetails?: unknown[];
  detectedStudentId?: string | null;
  error?: string;
  debug?: Record<string, unknown>;
};

@Injectable()
export class OpenCvGradingService {
  private async resolveScriptPath() {
    const distPath = join(__dirname, 'opencv_grader.py');
    try {
      await access(distPath, constants.F_OK);
      return distPath;
    } catch {
      return join(process.cwd(), 'src', 'grading', 'opencv_grader.py');
    }
  }

  async processAnswerSheet(imagePath: string, configJson?: string): Promise<OpenCvProcessResult> {
    const scriptPath = await this.resolveScriptPath();
    const args = [scriptPath, imagePath];
    if (configJson) args.push(configJson);
    return new Promise((resolve, reject) => {
      const child = spawn('python3', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `OpenCV process failed with code ${code}. ${stderr || stdout}`,
            ),
          );
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as OpenCvProcessResult;
          resolve(parsed);
        } catch {
          reject(new Error('Invalid OpenCV output format.'));
        }
      });
    });
  }

  // Fallback decoder for environments without OpenCV/Python.
  async processWithFallback(imagePath: string): Promise<OpenCvProcessResult> {
    const fileBuffer = await readFile(imagePath);
    const fingerprint = fileBuffer
      .slice(0, 200)
      .reduce((acc, value) => (acc + value) % 997, 0);
    return {
      confidence: 0.35,
      decodedFormId: fingerprint % 100,
      answers: {},
      debug: {
        mode: 'fallback',
      },
    };
  }
}
