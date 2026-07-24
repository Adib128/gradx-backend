import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { GetUser } from 'src/auth/decorators/get-user.decorator';
import { CourseAnswerSheetService } from './course-answer-sheet.service';
import { CreateCourseAnswerSheetDto } from './dto/create-course-answer-sheet.dto';
import { UpdateCourseAnswerSheetDto } from './dto/update-course-answer-sheet.dto';

@UseGuards(JwtAuthGuard)
@Controller('courses/:courseId/answer-sheets')
export class CourseAnswerSheetController {
  constructor(private readonly service: CourseAnswerSheetService) {}

  @Get()
  findByCourse(
    @Param('courseId', ParseIntPipe) courseId: number,
    @GetUser('tenantId') tenantId: number,
  ) {
    return this.service.findByCourse(courseId, tenantId);
  }

  @Get(':id/download')
  async download(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('id', ParseIntPipe) id: number,
    @GetUser('tenantId') tenantId: number,
  ): Promise<StreamableFile> {
    return this.service.download(courseId, id, tenantId);
  }

  @Get(':id')
  findOne(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('id', ParseIntPipe) id: number,
    @GetUser('tenantId') tenantId: number,
  ) {
    return this.service.findOne(courseId, id, tenantId);
  }

  @Post()
  create(
    @Param('courseId', ParseIntPipe) courseId: number,
    @GetUser('tenantId') tenantId: number,
    @Body() dto: CreateCourseAnswerSheetDto,
  ) {
    return this.service.create(courseId, tenantId, dto);
  }

  @Patch(':id')
  update(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('id', ParseIntPipe) id: number,
    @GetUser('tenantId') tenantId: number,
    @Body() dto: UpdateCourseAnswerSheetDto,
  ) {
    return this.service.update(courseId, id, tenantId, dto);
  }

  @Delete(':id')
  remove(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('id', ParseIntPipe) id: number,
    @GetUser('tenantId') tenantId: number,
  ) {
    return this.service.remove(courseId, id, tenantId);
  }
}
