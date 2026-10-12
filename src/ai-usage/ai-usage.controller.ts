import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { GetUser } from 'src/auth/decorators/get-user.decorator';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { AiUsageService, type AiUsageSummary } from './ai-usage.service';

const HEARTBEAT_MS = 25_000;

@UseGuards(JwtAuthGuard)
@Controller('ai-usage')
export class AiUsageController {
  constructor(private readonly aiUsage: AiUsageService) {}

  @Get('me')
  me(@GetUser('userId') userId: number) {
    return this.aiUsage.summary(userId);
  }

  /** Server-Sent Events: the current total first, then one event per metered AI call. */
  @Get('me/stream')
  async stream(
    @GetUser('userId') userId: number,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (summary: AiUsageSummary) => {
      if (!res.writableEnded) {
        res.write(`event: usage\ndata: ${JSON.stringify(summary)}\n\n`);
      }
    };
    const unsubscribe = this.aiUsage.subscribe(userId, send);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    send(await this.aiUsage.summary(userId));
  }
}
