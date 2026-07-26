import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  ParseIntPipe,
  Query,
  BadRequestException,
} from '@nestjs/common';
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

@UseGuards(JwtAuthGuard)
@Controller('courses')
export class CourseController {
  constructor(
    private readonly courseService: CourseService,
    private readonly courseAIService: CourseAIService,
    private readonly topicService: TopicService,
    private readonly courseReportsService: CourseReportsService,
  ) {}

  @Get()
  findAll(
    @GetUser('tenantId') tenantId: number,
    @Query() courseQueryDto: CourseQueryDto,
  ) {
    return this.courseService.findAll(tenantId, courseQueryDto);
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

    return this.courseAIService.analyzeCloAchievement({
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
    });
  }

  @Get(':id/reports/clo-analysis-all')
  getAllCloAchievements(
    @GetUser('tenantId') tenantId: number,
    @Param('id', ParseIntPipe) id: number,
    @Query('force') force?: string,
  ) {
    return this.courseReportsService.getOrGenerateAllCloAnalysis(tenantId, id, {
      force: force === '1' || force === 'true',
    });
  }

  @Post(':id/reports/clo-analysis-all')
  analyzeAllCloAchievements(
    @GetUser('tenantId') tenantId: number,
    @Param('id', ParseIntPipe) id: number,
    @Query('force') force?: string,
  ) {
    return this.courseReportsService.getOrGenerateAllCloAnalysis(tenantId, id, {
      force: force === '1' || force === 'true',
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

  @Delete(':id')
  remove(
    @GetUser('tenantId') tenantId: number,
    @Param('id') id: string,
  ) {
    return this.courseService.remove(tenantId, +id);
  }

  @Post('extract')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  extractFromPdf(@UploadedFile() file: Express.Multer.File) {
    return this.courseService.extractFromPdfFile(file);
    // → { jobId: "1", status: "processing" }
  }

  @Get('extract/:jobId/status')
  getExtractionStatus(@Param('jobId') jobId: string) {
    return this.courseService.getExtractionStatus(jobId);
    // → { jobId: "1", status: "completed", progress: 100, result: {...} }
  }

  @Post('confirm')
  confirmAndSave(
    @GetUser('tenantId') tenantId: number,
    @Body() createCourseDto: CreateCourseDto, // ← typed now
  ) {
    return this.courseService.confirmAndSave(tenantId, createCourseDto);
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
