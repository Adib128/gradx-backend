import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { GetUser } from 'src/auth/decorators/get-user.decorator';
import { CourseAnswerSheetService } from './course-answer-sheet.service';
import { CreateCourseAnswerSheetDto } from './dto/create-course-answer-sheet.dto';
import { UpdateCourseAnswerSheetDto } from './dto/update-course-answer-sheet.dto';
import { CreateStudentDto } from 'src/student/dto/create-student.dto';
import { UpdateStudentDto } from 'src/student/dto/update-student.dto';

@UseGuards(JwtAuthGuard)
@Controller('answer-sheets')
export class AnswerSheetsController {
  constructor(private readonly service: CourseAnswerSheetService) {}

  @Get()
  findByTenant(
    @GetUser('tenantId') tenantId: number,
    @Query('academicYear') academicYear?: string,
    @Query('semester') semester?: string,
  ) {
    return this.service.findByTenant(tenantId, {
      academicYear,
      semester,
    });
  }

  @Post()
  create(
    @GetUser('tenantId') tenantId: number,
    @Body() dto: CreateCourseAnswerSheetDto,
  ) {
    return this.service.createForTenant(tenantId, dto);
  }

  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @GetUser('tenantId') tenantId: number,
  ) {
    return this.service.findOneById(id, tenantId);
  }

  @Get(':id/download')
  download(
    @Param('id', ParseIntPipe) id: number,
    @GetUser('tenantId') tenantId: number,
  ): Promise<StreamableFile> {
    return this.service.downloadById(id, tenantId);
  }

  @Get(':id/scans')
  listScans(
    @Param('id', ParseIntPipe) id: number,
    @GetUser('tenantId') tenantId: number,
  ) {
    return this.service.listScans(id, tenantId);
  }

  @Get(':id/report')
  getReport(
    @Param('id', ParseIntPipe) id: number,
    @GetUser('tenantId') tenantId: number,
  ) {
    return this.service.getReport(id, tenantId);
  }

  @Get(':id/students')
  listStudents(
    @Param('id', ParseIntPipe) id: number,
    @GetUser('tenantId') tenantId: number,
  ) {
    return this.service.listStudents(id, tenantId);
  }

  @Post(':id/students')
  createStudent(
    @Param('id', ParseIntPipe) id: number,
    @GetUser('tenantId') tenantId: number,
    @Body() dto: CreateStudentDto,
  ) {
    return this.service.createStudent(id, tenantId, dto);
  }

  @Post(':id/students/import')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  importStudents(
    @Param('id', ParseIntPipe) id: number,
    @GetUser('tenantId') tenantId: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.service.importStudents(id, tenantId, file);
  }

  @Patch(':id/students/:studentId')
  updateStudent(
    @Param('id', ParseIntPipe) id: number,
    @Param('studentId', ParseIntPipe) studentId: number,
    @GetUser('tenantId') tenantId: number,
    @Body() dto: UpdateStudentDto,
  ) {
    return this.service.updateStudent(id, studentId, tenantId, dto);
  }

  @Delete(':id/students/:studentId')
  removeStudent(
    @Param('id', ParseIntPipe) id: number,
    @Param('studentId', ParseIntPipe) studentId: number,
    @GetUser('tenantId') tenantId: number,
  ) {
    return this.service.removeStudent(id, studentId, tenantId);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @GetUser('tenantId') tenantId: number,
    @Body() dto: UpdateCourseAnswerSheetDto,
  ) {
    return this.service.updateById(id, tenantId, dto);
  }

  @Delete(':id')
  remove(
    @Param('id', ParseIntPipe) id: number,
    @GetUser('tenantId') tenantId: number,
  ) {
    return this.service.removeById(id, tenantId);
  }
}
