import { Module } from '@nestjs/common';
import { GradingController } from './grading.controller';
import { GradingService } from './grading.service';
import { OpenCvGradingService } from './opencv-grading.service';
import { NodeGraderService } from './node-grader.service';
import { StudentInfoVisionService } from './student-info-vision.service';

@Module({
  controllers: [GradingController],
  providers: [
    GradingService,
    OpenCvGradingService,
    NodeGraderService,
    StudentInfoVisionService,
  ],
})
export class GradingModule {}
