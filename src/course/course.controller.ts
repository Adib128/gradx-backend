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

@UseGuards(JwtAuthGuard)
@Controller('courses')
export class CourseController {
  constructor(
    private readonly courseService: CourseService,
    private readonly courseAIService: CourseAIService,
    private readonly topicService: TopicService,
  ) {}

  @Get()
  findAll(
    @GetUser('tenantId') tenantId: number,
    @Body() courseQueryDto: CourseQueryDto,
  ) {
    return this.courseService.findAll(tenantId, courseQueryDto);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.courseService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateCourseDto: UpdateCourseDto) {
    return this.courseService.update(+id, updateCourseDto);
  }

  /** Lightweight meta-only update — used by the Course Details edit modal */
  @Patch(':id/meta')
  updateMeta(@Param('id', ParseIntPipe) id: number, @Body() body: Record<string, any>) {
    return this.courseService.updateMeta(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.courseService.remove(+id);
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
  deleteCourse(@Param('courseId', ParseIntPipe) courseId: number) {
    return this.courseService.remove(courseId);
  }
}
