import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { GetUser } from 'src/auth/decorators/get-user.decorator';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { GenerateAssessmentDto } from './dto/generate-assessment.dto';
import { AssessmentService } from './assessment.service';
import { UpdateAssessmentDto } from './dto/update-assessment.dto.ts';
import { CreateAssessmentDto } from './dto/create-assessment.dto';

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

  @Get(':courseId')
  findAll(@Param('courseId', ParseIntPipe) courseId: number) {
    return this.assessmentService.findAll(courseId);
  }

  @Delete(':assessmentId')
  remove(@Param('assessmentId', ParseIntPipe) assessmentId: number) {
    return this.assessmentService.remove(assessmentId);
  }
}
