import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
} from '@nestjs/common';
import { ClassService } from './class.service';
import { CreateClassDto } from './dto/create-class.dto';
import { UpdateClassDto } from './dto/update-class.dto';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { GetUser } from 'src/auth/decorators/get-user.decorator';
import { StudentService } from 'src/student/student.service';
import { StudentQueryDto } from './dto/student-query.dto';

@UseGuards(JwtAuthGuard)
@Controller('classes')
export class ClassController {
  constructor(
    private readonly classService: ClassService,
    private readonly studentService: StudentService,
  ) {}

  @Post()
  create(
    @GetUser('tenantId') tenantId: number,
    @Body() createClassDto: CreateClassDto,
  ) {
    return this.classService.create(tenantId, createClassDto);
  }

  @Get()
  findAll(@GetUser('tenantId') tenantId: number) {
    return this.classService.findAll(tenantId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.classService.findOne(+id);
  }

  @Get(':id/students')
  findStudents(
    @GetUser('tenantId') tenantId: number,
    @Param('id') id: string,
    @Query() query: StudentQueryDto,
  ) {
    return this.studentService.findByClass(+id, tenantId, query);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateClassDto: UpdateClassDto) {
    return this.classService.update(+id, updateClassDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.classService.remove(+id);
  }
}
