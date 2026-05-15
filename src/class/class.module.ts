import { Module } from '@nestjs/common';
import { ClassService } from './class.service';
import { ClassController } from './class.controller';
import { StudentModule } from 'src/student/student.module';

@Module({
  imports: [StudentModule],
  controllers: [ClassController],
  providers: [ClassService],
})
export class ClassModule {}
