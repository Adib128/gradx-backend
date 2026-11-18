import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { GetUser } from 'src/auth/decorators/get-user.decorator';
import {
  CourseSurveyService,
  type SurveyBrand,
  type UpdateCourseSurveyDto,
} from './course-survey.service';

@UseGuards(JwtAuthGuard)
@Controller('courses/:courseId/surveys')
export class CourseSurveyController {
  constructor(private readonly courseSurveyService: CourseSurveyService) {}

  @Get()
  getForCourse(
    @GetUser('tenantId') tenantId: number,
    @Param('courseId', ParseIntPipe) courseId: number,
  ) {
    return this.courseSurveyService.getForCourse(tenantId, courseId);
  }

  @Post('generate')
  generate(
    @GetUser('tenantId') tenantId: number,
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() body?: { brand?: SurveyBrand | null },
  ) {
    return this.courseSurveyService.generate(tenantId, courseId, body?.brand);
  }

  @Get(':surveyId/results')
  getResults(
    @GetUser('tenantId') tenantId: number,
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('surveyId', ParseIntPipe) surveyId: number,
  ) {
    return this.courseSurveyService.getResults(tenantId, courseId, surveyId);
  }

  @Patch(':surveyId')
  update(
    @GetUser('tenantId') tenantId: number,
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('surveyId', ParseIntPipe) surveyId: number,
    @Body() body: UpdateCourseSurveyDto,
  ) {
    return this.courseSurveyService.update(tenantId, courseId, surveyId, body);
  }

  @Post(':surveyId/share')
  enableShare(
    @GetUser('tenantId') tenantId: number,
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('surveyId', ParseIntPipe) surveyId: number,
    @Body()
    body?: { rotate?: boolean; expiresInDays?: number | null },
  ) {
    return this.courseSurveyService.enableShare(
      tenantId,
      courseId,
      surveyId,
      body,
    );
  }

  @Post(':surveyId/share/disable')
  disableShare(
    @GetUser('tenantId') tenantId: number,
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('surveyId', ParseIntPipe) surveyId: number,
  ) {
    return this.courseSurveyService.disableShare(tenantId, courseId, surveyId);
  }
}
