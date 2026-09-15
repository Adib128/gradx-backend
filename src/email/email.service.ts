import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import {
  buildVerificationEmail,
  EmailLanguage,
} from './email.templates';

const PLACEHOLDER_HOSTS = new Set([
  'smtp.your-provider.com',
  'smtp.example.com',
  'your-provider.com',
  'localhost',
]);

function isPlaceholderValue(value?: string | null): boolean {
  if (!value) return true;
  const v = value.trim().toLowerCase();
  if (!v) return true;
  if (v === '...' || v === 'changeme' || v === 'password' || v === 'user') {
    return true;
  }
  if (v.includes('your-provider') || v.includes('example.com')) return true;
  if (v.includes('yourdomain')) return true;
  return false;
}

@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter | null = null;
  private from: string;
  private mode: 'smtp' | 'ethereal' | 'console' = 'console';
  private initPromise: Promise<void>;

  constructor(private readonly configService: ConfigService) {
    this.from =
      this.configService.get<string>('SMTP_FROM')?.trim() ||
      'GradX <noreply@gradx.app>';
    this.initPromise = this.initTransport();
  }

  async onModuleInit() {
    await this.initPromise;
  }

  /** True until real SMTP is configured — safe to show code in UI. */
  exposesVerificationCode(): boolean {
    const forced = this.configService.get<string>('EXPOSE_VERIFICATION_CODE');
    if (forced === 'true') return true;
    if (forced === 'false') return false;
    return this.mode !== 'smtp';
  }

  private async initTransport() {
    const host = this.configService.get<string>('SMTP_HOST')?.trim() || '';
    const user = this.configService.get<string>('SMTP_USER')?.trim() || '';
    const pass = this.configService.get<string>('SMTP_PASS')?.trim() || '';
    const port = Number(this.configService.get<string>('SMTP_PORT') || 587);
    const secure =
      this.configService.get<string>('SMTP_SECURE') === 'true' || port === 465;
    const forceEthereal =
      this.configService.get<string>('SMTP_USE_ETHEREAL') === 'true';

    const hostIsPlaceholder =
      !host ||
      PLACEHOLDER_HOSTS.has(host.toLowerCase()) ||
      isPlaceholderValue(host);
    const credsArePlaceholder =
      isPlaceholderValue(user) || isPlaceholderValue(pass);

    if (!forceEthereal && !hostIsPlaceholder && !credsArePlaceholder) {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass },
      });
      this.mode = 'smtp';
      this.from =
        this.configService.get<string>('SMTP_FROM')?.trim() ||
        user ||
        this.from;
      this.logger.log(`Email transport: SMTP ${host}:${port} (real delivery)`);
      return;
    }

    // Placeholder / unfinished SMTP → Ethereal so messages are still receivable
    try {
      const testAccount = await nodemailer.createTestAccount();
      this.transporter = nodemailer.createTransport({
        host: testAccount.smtp.host,
        port: testAccount.smtp.port,
        secure: testAccount.smtp.secure,
        auth: {
          user: testAccount.user,
          pass: testAccount.pass,
        },
      });
      this.from = `GradX <${testAccount.user}>`;
      this.mode = 'ethereal';
      this.logger.warn(
        `SMTP placeholders detected — using Ethereal test inbox (${testAccount.user}). Replace SMTP_* with real credentials for inbox delivery.`,
      );
    } catch (error) {
      this.mode = 'console';
      this.transporter = null;
      this.logger.warn(
        `Ethereal unavailable — logging verification codes only. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async sendVerificationCode(
    to: string,
    code: string,
    language: EmailLanguage = 'en',
  ): Promise<void> {
    await this.initPromise;
    const { subject, text, html } = buildVerificationEmail(code, language);

    if (this.mode === 'console' || !this.transporter) {
      this.logger.log(
        `[console-email] to=${to} lang=${language} subject="${subject}" code=${code}`,
      );
      this.logger.log(`[console-email] body: ${text}`);
      return;
    }

    try {
      const info = await this.transporter.sendMail({
        from: this.from,
        to,
        subject,
        text,
        html,
      });
      const preview = nodemailer.getTestMessageUrl(info);
      if (preview) {
        this.logger.log(
          `Verification email sent to ${to} (${info.messageId}) preview=${preview}`,
        );
      } else {
        this.logger.log(`Verification email sent to ${to} (${info.messageId})`);
      }
    } catch (error) {
      this.logger.error(
        `Failed to send verification email to ${to}`,
        error instanceof Error ? error.stack : String(error),
      );
      // Last-resort: never block registration if transport fails mid-flight
      this.logger.warn(
        `[console-email-fallback] to=${to} lang=${language} code=${code}`,
      );
    }
  }
}
