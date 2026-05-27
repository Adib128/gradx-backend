import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { GetUser } from 'src/auth/decorators/get-user.decorator';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { GenerateAssessmentDto } from './dto/generate-assessment.dto';
import { AssessmentService } from './assessment.service';

@UseGuards(JwtAuthGuard)
@Controller('assessments')
export class AssessmentController {
  constructor(private readonly assessmentService: AssessmentService) {}

  @Post(':courseId/generate')
  generate(
    @GetUser('tenantId') tenantId: number,
    @Param() courseId: number,
    @Body() generateAssessmentDto: GenerateAssessmentDto,
  ) {
    return this.assessmentService.generate(
      tenantId,
      courseId,
      generateAssessmentDto,
    );
  }
}
