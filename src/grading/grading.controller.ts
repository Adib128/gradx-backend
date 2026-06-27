import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { GetUser } from 'src/auth/decorators/get-user.decorator';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { GradingService } from './grading.service';

type JwtUser = {
  userId: number;
  tenantId: number;
};

@UseGuards(JwtAuthGuard)
@Controller('grading')
export class GradingController {
  constructor(private readonly gradingService: GradingService) {}

  @Post('assessments/:assessmentId/scans')
  @UseInterceptors(FileInterceptor('file'))
  createScan(
    @GetUser() user: JwtUser,
    @Param('assessmentId', ParseIntPipe) assessmentId: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.gradingService.createScan(user, assessmentId, file);
  }

  @Get('assessments/:assessmentId/scans')
  listAssessmentScans(
    @GetUser() user: JwtUser,
    @Param('assessmentId', ParseIntPipe) assessmentId: number,
  ) {
    return this.gradingService.listScansByAssessment(user, assessmentId);
  }

  @Get('scans/:scanId')
  getScan(
    @GetUser() user: JwtUser,
    @Param('scanId', ParseIntPipe) scanId: number,
  ) {
    return this.gradingService.getScan(user, scanId);
  }
}
