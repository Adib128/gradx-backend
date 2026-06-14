import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { GetUser } from 'src/auth/decorators/get-user.decorator';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { GenerateAssessmentDto } from './dto/generate-assessment.dto';
import { AssessmentService } from './assessment.service';
import { UpdateAssessmentDto } from './dto/update-assessment.dto.ts';
import { CreateAssessmentDto } from './dto/create-assessment.dto';
import { AddQuestionDto, UpdateQuestionDto } from './dto/question.dto';

@UseGuards(JwtAuthGuard)
@Controller('assessments')
export class AssessmentController {
  constructor(private readonly assessmentService: AssessmentService) {}

  @Post(':courseId/create')
  create(
    @GetUser('tenantId') tenantId: number,
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() createAssessmentDto: CreateAssessmentDto,
  ) {
    return this.assessmentService.create(
      tenantId,
      courseId,
      createAssessmentDto,
    );
  }

  @Post(':courseId/generate/:assessmentId')
  async generate(
    @GetUser('tenantId') tenantId: number,
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('assessmentId', ParseIntPipe) assessmentId: number,
    @Body() generateAssessmentDto: GenerateAssessmentDto,
  ) {
    return await this.assessmentService.generate(
      tenantId,
      courseId,
      assessmentId,
      generateAssessmentDto,
    );
  }

  @Get(':courseId')
  findAll(@Param('courseId', ParseIntPipe) courseId: number) {
    return this.assessmentService.findAll(courseId);
  }

  @Get(':assessmentId/show')
  findOne(@Param('assessmentId', ParseIntPipe) assessmentId: number) {
    return this.assessmentService.findOne(assessmentId);
  }

  @Get(':assessmentId/downloads')
  listDownloads(
    @GetUser('tenantId') tenantId: number,
    @Param('assessmentId', ParseIntPipe) assessmentId: number,
  ) {
    return this.assessmentService.getVersionDownloadFilesByAssessmentId(
      tenantId,
      assessmentId,
    );
  }

  @Get(':assessmentId/downloads/archive')
  async downloadVersionsArchive(
    @GetUser('tenantId') tenantId: number,
    @Param('assessmentId', ParseIntPipe) assessmentId: number,
    @Res() res: Response,
  ) {
    const download =
      await this.assessmentService.createVersionDownloadsByAssessmentId(
        tenantId,
        assessmentId,
      );

    res.setHeader('Content-Type', download.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${download.filename}"`,
    );
    res.send(download.buffer);
  }

  @Get(':assessmentId/downloads/exams/:versionId/:format')
  async downloadExamFile(
    @GetUser('tenantId') tenantId: number,
    @Param('assessmentId', ParseIntPipe) assessmentId: number,
    @Param('versionId', ParseIntPipe) versionId: number,
    @Param('format') format: 'pdf' | 'doc',
    @Res() res: Response,
  ) {
    const download =
      await this.assessmentService.createVersionFileDownloadByAssessmentId(
        tenantId,
        assessmentId,
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

  @Get(':assessmentId/downloads/answer-sheets/:versionId/:format')
  async downloadAnswerSheetFile(
    @GetUser('tenantId') tenantId: number,
    @Param('assessmentId', ParseIntPipe) assessmentId: number,
    @Param('versionId', ParseIntPipe) versionId: number,
    @Param('format') format: 'pdf' | 'doc',
    @Res() res: Response,
  ) {
    const download =
      await this.assessmentService.createVersionFileDownloadByAssessmentId(
        tenantId,
        assessmentId,
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

  @Patch(':assessmentId')
  update(
    @GetUser('tenantId') tenantId: number,
    @Param('assessmentId', ParseIntPipe) assessmentId: number,
    @Body() updateAssessmentDto: UpdateAssessmentDto,
  ) {
    return this.assessmentService.update(
      tenantId,
      assessmentId,
      updateAssessmentDto,
    );
  }

  @Post(':assessmentId/questions')
  addQuestion(
    @GetUser('tenantId') tenantId: number,
    @Param('assessmentId', ParseIntPipe) assessmentId: number,
    @Body() addQuestionDto: AddQuestionDto,
  ) {
    return this.assessmentService.addQuestion(
      tenantId,
      assessmentId,
      addQuestionDto,
    );
  }

  @Patch(':assessmentId/questions/:questionId')
  updateQuestion(
    @GetUser('tenantId') tenantId: number,
    @Param('assessmentId', ParseIntPipe) assessmentId: number,
    @Param('questionId', ParseIntPipe) questionId: number,
    @Body() updateQuestionDto: UpdateQuestionDto,
  ) {
    return this.assessmentService.updateQuestion(
      tenantId,
      assessmentId,
      questionId,
      updateQuestionDto,
    );
  }

  @Delete(':assessmentId/questions/:questionId')
  removeQuestion(
    @GetUser('tenantId') tenantId: number,
    @Param('assessmentId', ParseIntPipe) assessmentId: number,
    @Param('questionId', ParseIntPipe) questionId: number,
  ) {
    return this.assessmentService.removeQuestion(
      tenantId,
      assessmentId,
      questionId,
    );
  }

  @Delete(':assessmentId')
  remove(@Param('assessmentId', ParseIntPipe) assessmentId: number) {
    return this.assessmentService.remove(assessmentId);
  }
}
