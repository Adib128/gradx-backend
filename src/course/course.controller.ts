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

@UseGuards(JwtAuthGuard)
@Controller('courses')
export class CourseController {
  constructor(
    private readonly courseService: CourseService,
    private readonly courseAIService: CourseAIService,
  ) {}

  @Post()
  create(@Body() createCourseDto: CreateCourseDto) {
    return this.courseService.create(createCourseDto);
  }

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
}
