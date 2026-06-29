import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
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

  /** Confirm a completed grading scan (verifies it is saved and returns it). */
  @Patch('scans/:scanId/confirm')
  confirmScan(
    @GetUser() user: JwtUser,
    @Param('scanId', ParseIntPipe) scanId: number,
  ) {
    return this.gradingService.confirmScan(user, scanId);
  }

  @Delete('scans/:scanId')
  deleteScan(
    @GetUser() user: JwtUser,
    @Param('scanId', ParseIntPipe) scanId: number,
  ) {
    return this.gradingService.deleteScan(user, scanId);
  }

  /** Full grading history for the tenant (all completed scans). */
  @Get('history')
  getGradingHistory(@GetUser() user: JwtUser) {
    return this.gradingService.getGradingHistory(user);
  }

  /** All grading scans attributed to a student (by their detected student code). */
  @Get('students/:studentCode/history')
  getStudentHistory(
    @GetUser() user: JwtUser,
    @Param('studentCode') studentCode: string,
  ) {
    return this.gradingService.getStudentHistory(user, studentCode);
  }
}
