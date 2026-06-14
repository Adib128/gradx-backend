import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { GetUser } from 'src/auth/decorators/get-user.decorator';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { AssessmentService } from './assessment.service';
import { AssessmentType } from 'generated/prisma/enums';

@UseGuards(JwtAuthGuard)
@Controller('courses/:courseId/assessments/generate/ai')
export class AssessmentDownloadController {
  constructor(private readonly assessmentService: AssessmentService) {}

  @Get('topics')
  getGenerationTopics(
    @GetUser('tenantId') tenantId: number,
    @Param('courseId', ParseIntPipe) courseId: number,
    @Query('type') type?: AssessmentType,
  ) {
    return this.assessmentService.getGenerationTopics(tenantId, courseId, type);
  }

  @Get('downloads')
  listDownloads(
    @GetUser('tenantId') tenantId: number,
    @Param('courseId', ParseIntPipe) courseId: number,
  ) {
    return this.assessmentService.getVersionDownloadFiles(tenantId, courseId);
  }

  @Get('downloads/archive')
  async downloadVersionsArchive(
    @GetUser('tenantId') tenantId: number,
    @Param('courseId', ParseIntPipe) courseId: number,
    @Res() res: Response,
  ) {
    const download = await this.assessmentService.createVersionDownloads(
      tenantId,
      courseId,
    );

    res.setHeader('Content-Type', download.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${download.filename}"`,
    );
    res.send(download.buffer);
  }

  @Get('downloads/exams/:versionId/:format')
  async downloadExamFile(
    @GetUser('tenantId') tenantId: number,
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('versionId', ParseIntPipe) versionId: number,
    @Param('format') format: 'pdf' | 'doc',
    @Res() res: Response,
  ) {
    const download = await this.assessmentService.createVersionFileDownload(
      tenantId,
      courseId,
      versionId,
      'exam',
      format,
    );

    res.setHeader('Content-Type', download.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${download.filename}"`,
    );
    res.send(download.buffer);
  }

  @Get('downloads/answer-sheets/:versionId/:format')
  async downloadAnswerSheetFile(
    @GetUser('tenantId') tenantId: number,
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('versionId', ParseIntPipe) versionId: number,
    @Param('format') format: 'pdf' | 'doc',
    @Res() res: Response,
  ) {
    const download = await this.assessmentService.createVersionFileDownload(
      tenantId,
      courseId,
      versionId,
      'answer-sheet',
      format,
    );

    res.setHeader('Content-Type', download.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${download.filename}"`,
    );
    res.send(download.buffer);
  }
}
