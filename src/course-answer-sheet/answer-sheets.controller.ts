import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { GetUser } from 'src/auth/decorators/get-user.decorator';
import { CourseAnswerSheetService } from './course-answer-sheet.service';

@UseGuards(JwtAuthGuard)
@Controller('answer-sheets')
export class AnswerSheetsController {
  constructor(private readonly service: CourseAnswerSheetService) {}

  @Get()
  findByTenant(@GetUser('tenantId') tenantId: number) {
    return this.service.findByTenant(tenantId);
  }
}
