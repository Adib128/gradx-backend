import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import {
  CourseSurveyService,
  type SubmitPublicSurveyDto,
} from './course-survey.service';

/** Unauthenticated CLO survey by share token. No JWT. */
@Controller('public/surveys')
export class PublicSurveyController {
  constructor(private readonly courseSurveyService: CourseSurveyService) {}

  @Get(':token')
  findByToken(@Param('token') token: string) {
    return this.courseSurveyService.findPublicByToken(token);
  }

  @Post(':token/responses')
  submit(
    @Param('token') token: string,
    @Body() body: SubmitPublicSurveyDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.courseSurveyService.submitPublicResponse(
      token,
      body,
      userAgent,
    );
  }
}
