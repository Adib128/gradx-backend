import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Put,
  Param,
  Delete,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  ParseIntPipe,
  Query,
  BadRequestException,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { CourseService } from './course.service';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { CourseQueryDto } from './dto/course-query.dto';
import { GetUser } from 'src/auth/decorators/get-user.decorator';
import { ApiConsumes } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { CourseAIService } from './course-ai.service';
import { CreateTopicDto } from './dto/create-topic.dto';
import { TopicService } from './topic.service';
import { UpdateTopicDto } from './dto/update-topic.dto';
import { CourseReportsService } from './course-reports.service';
import { DocxPdfService } from './docx-pdf.service';
import { normalizeReportLanguage } from './utils/course-report-document.util';
import { normalizeCloAnalysisLanguage } from './prompts/clo-analysis-stream.prompt';
import { runWithAiContext } from 'src/common/helpers/openrouter-chat.helper';
import { ReferenceVectorService } from 'src/reference-vector/reference-vector.service';

@UseGuards(JwtAuthGuard)
@Controller('courses')
export class CourseController {
  constructor(
    private readonly courseService: CourseService,
    private readonly courseAIService: CourseAIService,
    private readonly topicService: TopicService,
    private readonly courseReportsService: CourseReportsService,
    private readonly referenceVectorService: ReferenceVectorService,
    private readonly docxPdfService: DocxPdfService,
  ) {}

  @Get()
  findAll(
    @GetUser('tenantId') tenantId: number,
    @Query() courseQueryDto: CourseQueryDto,
  ) {
    return this.courseService.findAll(tenantId, courseQueryDto);
  }

  /** Authenticated stream of a stored reference PDF/DOCX/figure (tenant-scoped path). */
  @Get('reference-files')
  async getReferenceArchiveFile(
    @GetUser('tenantId') tenantId: number,
    @Query('path') path?: string,
  ) {
    if (!path?.trim()) {
      throw new BadRequestException('REFERENCE_FILE_REQUIRED');
    }
    const { filePath, fileName, mimeType } =
      await this.courseService.getReferenceArchiveFile(tenantId, path);
    return new StreamableFile(createReadStream(filePath), {
      type: mimeType,
      disposition: `inline; filename="${fileName}"`,
    });
  }

  @Get(':id')
  findOne(
    @GetUser('tenantId') tenantId: number,
    @Param('id') id: string,
    @Query('include') include?: string,
  ) {
    const includes = include
      ? include
          .split(',')
          .map((part) => part.trim().toLowerCase())
          .filter(Boolean)
      : undefined;
    return this.courseService.findOne(tenantId, +id, includes);
  }

  /** pgvector index state of each reference document (aligned with `references`). */
  @Get(':id/references/embeddings')
  getReferenceEmbeddings(
    @GetUser('tenantId') tenantId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.referenceVectorService.getCourseStatus(tenantId, id);
  }

  @Post(':id/references/embeddings/reindex')
  reindexReferenceEmbeddings(
    @GetUser('tenantId') tenantId: number,
    @GetUser('userId') userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Query('force') force?: string,
  ) {
    return this.referenceVectorService.reindexCourse(tenantId, id, {
      force: force === 'true' || force === '1',
      userId,
    });
  }

  /** Debug: stored chunks + vector previews (`referenceIndex`, `limit` ≤ 200, `offset`). */
  @Get(':id/references/embeddings/debug')
  debugReferenceEmbeddings(
    @GetUser('tenantId') tenantId: number,
    @Param('id', ParseIntPipe) id: number,
    @Query('referenceIndex') referenceIndex?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const refIndex = referenceIndex === undefined || referenceIndex === '' ? undefined : Number(referenceIndex);
    return this.referenceVectorService.debugCourse(tenantId, id, {
      referenceIndex: Number.isInteger(refIndex) ? refIndex : undefined,
      limit: Math.min(200, Math.max(1, Number(limit) || 20)),
      offset: Math.max(0, Number(offset) || 0),
    });
  }

  /** Debug: semantic search over the course's indexed references. */
  @Post(':id/references/embeddings/debug/search')
  debugSearchReferenceEmbeddings(
    @GetUser('tenantId') tenantId: number,
    @GetUser('userId') userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { query?: unknown; referenceIndex?: unknown; limit?: unknown },
  ) {
    const query = typeof body?.query === 'string' ? body.query.trim() : '';
    if (!query) throw new BadRequestException('QUERY_REQUIRED');
    const refIndex = Number(body.referenceIndex);
    return runWithAiContext({ userId, tenantId }, () =>
      this.referenceVectorService.debugSearch(tenantId, id, {
        query: query.slice(0, 2000),
        referenceIndex:
          body.referenceIndex === undefined || body.referenceIndex === null || body.referenceIndex === ''
            ? undefined
            : Number.isInteger(refIndex)
              ? refIndex
              : undefined,
        limit: Math.min(50, Math.max(1, Number(body.limit) || 10)),
      }),
    );
  }

  @Get(':id/references/:refIndex/file')
  async getCourseReferenceDocumentFile(
    @GetUser('tenantId') tenantId: number,
    @Param('id', ParseIntPipe) id: number,
    @Param('refIndex', ParseIntPipe) refIndex: number,
  ) {
    const { filePath, fileName, mimeType } =
      await this.courseService.getCourseReferenceDocumentFile(
        tenantId,
        id,
        refIndex,
      );
    return new StreamableFile(createReadStream(filePath), {
      type: mimeType,
      disposition: `inline; filename="${fileName}"`,
    });
  }

  @Get(':id/reports/clo-achievement')
  getCloAchievementReport(
    @GetUser('tenantId') tenantId: number,
    @Param('id', ParseIntPipe) id: number,
    @Query('assessmentId') assessmentId?: string,
  ) {
    return this.courseReportsService.getCloAchievementReport(
      tenantId,
      id,
      this.parseOptionalAssessmentId(assessmentId),
    );
  }

  @Get(':id/reports/grade-distribution')
  getGradeDistributionReport(
    @GetUser('tenantId') tenantId: number,
    @Param('id', ParseIntPipe) id: number,
    @Query('assessmentId') assessmentId?: string,
  ) {
    return this.courseReportsService.getGradeDistributionReport(
      tenantId,
      id,
      this.parseOptionalAssessmentId(assessmentId),
    );
  }

  @Get(':id/reports/assessments')
  getAssessmentsReport(
    @GetUser('tenantId') tenantId: number,
    @Param('id', ParseIntPipe) id: number,
    @Query('assessmentId') assessmentId?: string,
  ) {
    return this.courseReportsService.getAssessmentsReport(
      tenantId,
      id,
      this.parseOptionalAssessmentId(assessmentId),
    );
  }

  @Get(':id/reports/plo-alignment')
  getPloAlignmentReport(
    @GetUser('tenantId') tenantId: number,
    @Param('id', ParseIntPipe) id: number,
    @Query('assessmentId') assessmentId?: string,
  ) {
    return this.courseReportsService.getPloAlignmentReport(
      tenantId,
      id,
      this.parseOptionalAssessmentId(assessmentId),
    );
  }

  /** Computed data of the Course Report document (student counts, grades, CLOs, topics). */
  @Get(':id/reports/course-report-data')
  getCourseReportData(
    @GetUser('tenantId') tenantId: number,
    @Param('id', ParseIntPipe) id: number,
    @Query('assessmentId') assessmentId?: string,
    @Query('language') language?: string,
  ) {
    return this.courseReportsService.getCourseReportData(tenantId, id, {
      assessmentId: this.parseOptionalAssessmentId(assessmentId),
      language: normalizeReportLanguage(language),
    });
  }

  /** AI-written sections of the Course Report document. */
  @Post(':id/reports/course-report-narrative')
  generateCourseReportNarrative(
    @GetUser('tenantId') tenantId: number,
    @GetUser('userId') userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { assessmentId?: number | string; language?: string },
  ) {
    return this.courseReportsService.generateCourseReportNarrative(tenantId, id, {
      assessmentId: this.parseOptionalAssessmentId(
        body?.assessmentId != null ? String(body.assessmentId) : undefined,
      ),
      language: normalizeReportLanguage(body?.language),
      userId,
    });
  }

  /** Converts the filled course-report .docx to PDF (headless LibreOffice). */
  @Post(':id/reports/course-report-pdf')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  async convertCourseReportToPdf(
    @GetUser('tenantId') tenantId: number,
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('A .docx file is required.');
    }
    if (file.buffer.length > 8 * 1024 * 1024) {
      throw new BadRequestException('The report file is too large.');
    }
    await this.courseService.findOne(tenantId, id);
    const pdf = await this.docxPdfService.convert(file.buffer);
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: 'attachment; filename="course-report.pdf"',
    });
  }

  @Get(':id/reports/course-report-draft')
  getCourseReportDraft(
    @GetUser('tenantId') tenantId: number,
    @Param('id', ParseIntPipe) id: number,
    @Query('assessmentId') assessmentId?: string,
  ) {
    return this.courseReportsService.getCourseReportDraft(
      tenantId,
      id,
      this.parseOptionalAssessmentId(assessmentId),
    );
  }

  @Put(':id/reports/course-report-draft')
  saveCourseReportDraft(
    @GetUser('tenantId') tenantId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { assessmentId?: number | string | null; report?: unknown },
  ) {
    if (!body?.report || typeof body.report !== 'object') {
      throw new BadRequestException('A report is required.');
    }
    return this.courseReportsService.saveCourseReportDraft(
      tenantId,
      id,
      this.parseOptionalAssessmentId(
        body.assessmentId != null ? String(body.assessmentId) : undefined,
      ),
      body.report,
    );
  }

  @Get(':id/reports/student-results')
  getStudentResultsReport(
    @GetUser('tenantId') tenantId: number,
    @Param('id', ParseIntPipe) id: number,
    @Query('assessmentId') assessmentId?: string,
  ) {
    return this.courseReportsService.getStudentResultsReport(
      tenantId,
      id,
      this.parseOptionalAssessmentId(assessmentId),
    );
  }

  @Post(':id/reports/clo-analysis')
  async analyzeCloAchievement(
    @GetUser('tenantId') tenantId: number,
    @GetUser('userId') userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { cloId: number },
  ) {
    const report = await this.courseReportsService.getCloAchievementReport(tenantId, id);
    const row = report.rows.find((item) => item.id === body.cloId) ?? report.rows[0];
    if (!row) {
      throw new BadRequestException('No CLO data available for analysis.');
    }

    const assessmentSourcesSummary = this.formatAssessmentSourcesSummary(
      row.assessmentSources ?? [],
    );

    return runWithAiContext(
      { userId, tenantId, purpose: 'clo_analysis' },
      () =>
        this.courseAIService.analyzeCloAchievement({
          code: row.code,
          description: row.description,
          achievementRate: row.achievementRate,
          thresholdScore: row.thresholdScore,
          maxScore: row.maxScore,
          studentsMet: row.studentsMet,
          totalStudents: row.totalStudents,
          avgScore: row.avgScore,
          avgScoreLabel: row.avgScoreLabel,
          achieved: row.achieved,
          statusLabel: row.statusLabel,
          passRatePercent: report.thresholdPercent,
          hasGradingData: row.hasGradingData,
          assessmentSources: row.assessmentSources ?? [],
          assessmentSourcesSummary,
        }),
    );
  }

  @Get(':id/reports/clo-student-details')
  getCloStudentDetailsReport(
    @GetUser('tenantId') tenantId: number,
    @Param('id', ParseIntPipe) id: number,
    @Query('assessmentId') assessmentId?: string,
  ) {
    return this.courseReportsService.getCloStudentDetailsReport(
      tenantId,
      id,
      this.parseOptionalAssessmentId(assessmentId),
    );
  }

  /** SSE: streams the plain-text AI analysis in the requested language. */
  @Post(':id/reports/clo-analysis-stream')
  streamCloAnalysis(
    @GetUser('tenantId') tenantId: number,
    @GetUser('userId') userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { assessmentId?: number | string; language?: string },
    @Res() res: Response,
  ) {
    return this.courseReportsService.streamCloAnalysis(
      tenantId,
      id,
      {
        assessmentId: this.parseOptionalAssessmentId(
          body?.assessmentId != null ? String(body.assessmentId) : undefined,
        ),
        language: normalizeCloAnalysisLanguage(body?.language),
        userId,
      },
      res,
    );
  }

  @Get(':id/reports/clo-analysis-all')
  getAllCloAchievements(
    @GetUser('tenantId') tenantId: number,
    @GetUser('userId') userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Query('force') force?: string,
  ) {
    return this.courseReportsService.getOrGenerateAllCloAnalysis(tenantId, id, {
      force: force === '1' || force === 'true',
      userId,
    });
  }

  @Post(':id/reports/clo-analysis-all')
  analyzeAllCloAchievements(
    @GetUser('tenantId') tenantId: number,
    @GetUser('userId') userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Query('force') force?: string,
  ) {
    return this.courseReportsService.getOrGenerateAllCloAnalysis(tenantId, id, {
      force: force === '1' || force === 'true',
      userId,
    });
  }

  private parseOptionalAssessmentId(value?: string) {
    if (value == null || value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  private formatAssessmentSourcesSummary(
    sources: Array<{
      title: string;
      cloMarks: number;
      questionNumbers: number[];
    }>,
  ) {
    if (!sources.length) {
      return 'Assessment sources for this CLO are not linked yet.';
    }

    const parts = sources.map((source) => {
      const questions = (source.questionNumbers ?? []).filter((n) =>
        Number.isFinite(n),
      );
      if (questions.length === 1) {
        return `Question ${questions[0]} on the ${source.title}`;
      }
      if (questions.length > 1) {
        return `Questions ${questions.join(', ')} on the ${source.title}`;
      }
      return source.title;
    });

    if (parts.length === 1) {
      return `This CLO is primarily assessed by ${parts[0]}.`;
    }

    return `This CLO is assessed by ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}.`;
  }

  @Patch(':id')
  update(
    @GetUser('tenantId') tenantId: number,
    @Param('id') id: string,
    @Body() updateCourseDto: UpdateCourseDto,
  ) {
    return this.courseService.update(tenantId, +id, updateCourseDto);
  }

  /** Lightweight meta-only update — used by the Course Details edit modal */
  @Patch(':id/meta')
  updateMeta(
    @GetUser('tenantId') tenantId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, any>,
  ) {
    return this.courseService.updateMeta(tenantId, id, body);
  }

  /** Persist syllabus builder data. Merges extras; does not rewrite CLOs/topics. */
  @Patch(':id/syllabus')
  saveSyllabus(
    @GetUser('tenantId') tenantId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, any>,
  ) {
    return this.courseService.saveSyllabus(tenantId, id, body);
  }

  @Delete(':id')
  remove(
    @GetUser('tenantId') tenantId: number,
    @Param('id') id: string,
  ) {
    return this.courseService.remove(tenantId, +id);
  }

  @Post('extract/stream')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  streamExtractFromPdf(
    @UploadedFile() file: Express.Multer.File,
    @Res() res: Response,
    @GetUser('userId') userId?: number,
    @GetUser('tenantId') tenantId?: number,
  ) {
    return this.courseService.streamExtractFromPdfFile(file, res, {
      userId,
      tenantId,
    });
  }

  @Post('extract')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  extractFromPdf(
    @UploadedFile() file: Express.Multer.File,
    @GetUser('userId') userId?: number,
    @GetUser('tenantId') tenantId?: number,
  ) {
    return this.courseService.extractFromPdfFile(file, { userId, tenantId });
    // → { jobId: "1", status: "processing" }
  }

  @Get('extract/:jobId/status')
  getExtractionStatus(@Param('jobId') jobId: string) {
    return this.courseService.getExtractionStatus(jobId);
    // → { jobId: "1", status: "completed", progress: 100, result: {...} }
  }

  @Post('references/extract-document')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  extractReferenceDocument(
    @GetUser('tenantId') tenantId: number,
    @GetUser('userId') userId: number,
    @UploadedFile() file: Express.Multer.File,
    @Body('courseTitle') courseTitle?: string,
    @Body('courseCode') courseCode?: string,
    @Body('courseDescription') courseDescription?: string,
    @Body('topicTitles') topicTitles?: string,
  ) {
    let parsedTopicTitles: string[] | undefined;
    if (topicTitles) {
      try {
        const parsed = JSON.parse(topicTitles);
        if (Array.isArray(parsed)) {
          parsedTopicTitles = parsed
            .map((value) => String(value || '').trim())
            .filter(Boolean);
        }
      } catch {
        parsedTopicTitles = topicTitles
          .split(/[,;\n]+/)
          .map((value) => value.trim())
          .filter(Boolean);
      }
    }

    return this.courseService.extractReferenceDocument(tenantId, file, {
      courseTitle,
      courseCode,
      courseDescription,
      topicTitles: parsedTopicTitles,
      userId,
    });
  }

  @Post('references/extract-document/stream')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  streamExtractReferenceDocument(
    @GetUser('tenantId') tenantId: number,
    @GetUser('userId') userId: number,
    @UploadedFile() file: Express.Multer.File,
    @Res() res: Response,
    @Body('courseTitle') courseTitle?: string,
    @Body('courseCode') courseCode?: string,
    @Body('courseDescription') courseDescription?: string,
    @Body('topicTitles') topicTitles?: string,
  ) {
    let parsedTopicTitles: string[] | undefined;
    if (topicTitles) {
      try {
        const parsed = JSON.parse(topicTitles);
        if (Array.isArray(parsed)) {
          parsedTopicTitles = parsed
            .map((value) => String(value || '').trim())
            .filter(Boolean);
        }
      } catch {
        parsedTopicTitles = topicTitles
          .split(/[,;\n]+/)
          .map((value) => value.trim())
          .filter(Boolean);
      }
    }

    return this.courseService.streamExtractReferenceDocument(
      tenantId,
      file,
      res,
      {
        courseTitle,
        courseCode,
        courseDescription,
        topicTitles: parsedTopicTitles,
        userId,
      },
    );
  }

  @Post('confirm')
  confirmAndSave(
    @GetUser('tenantId') tenantId: number,
    @GetUser('userId') userId: number,
    @Body() createCourseDto: CreateCourseDto, // ← typed now
  ) {
    return runWithAiContext(
      { userId, tenantId, purpose: 'course_clo_topic_matching' },
      () => this.courseService.confirmAndSave(tenantId, createCourseDto),
    );
  }

  @Post('clo-topic-matching')
  async matchClosToTopics(
    @GetUser('tenantId') tenantId: number,
    @GetUser('userId') userId: number,
    @Body()
    body: {
      clos?: Array<{ code?: string; description?: string; category?: string; programCLOCode?: string }>;
      topics?: Array<{ title?: string }>;
    },
  ) {
    const clos = (Array.isArray(body?.clos) ? body.clos : [])
      .map((clo) => ({
        code: String(clo?.code ?? '').trim(),
        description: String(clo?.description ?? '').trim(),
        category: String(clo?.category ?? '').trim(),
        programCLOCode: String(clo?.programCLOCode ?? '').trim(),
      }))
      .filter((clo) => clo.code);
    const topics = (Array.isArray(body?.topics) ? body.topics : []).map(
      (topic, index) => ({
        title: String(topic?.title ?? '').trim() || `Topic ${index + 1}`,
      }),
    );
    if (clos.length === 0 || topics.length === 0) {
      throw new BadRequestException(
        'At least one CLO with a code and one topic are required.',
      );
    }

    return runWithAiContext(
      { userId, tenantId, purpose: 'course_clo_topic_matching' },
      () => this.courseAIService.matchClosToTopics(clos, topics),
    );
  }

  @Post(':id/topics')
  createTopic(
    @Param('id', ParseIntPipe) id: number,
    @Body() createTopicDto: CreateTopicDto,
  ) {
    return this.topicService.create(id, createTopicDto);
  }

  @Patch(':id/topics/:topicId')
  updateTopic(
    @Param('id', ParseIntPipe) id: number,
    @Param('topicId', ParseIntPipe) topicId: number,
    @Body() updateTopicDto: UpdateTopicDto,
  ) {
    return this.topicService.updateTopic(topicId, updateTopicDto);
  }

  @Delete(':id/topics/:topicId')
  deleteTOpic(
    @Param('id', ParseIntPipe) id: number,
    @Param('topicId', ParseIntPipe) topicId: number,
  ) {
    return this.topicService.deleteTopic(topicId);
  }

  @Delete(':courseId')
  deleteCourse(
    @GetUser('tenantId') tenantId: number,
    @Param('courseId', ParseIntPipe) courseId: number,
  ) {
    return this.courseService.remove(tenantId, courseId);
  }
}
