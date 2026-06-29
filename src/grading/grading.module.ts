import { Module } from '@nestjs/common';
import { GradingController } from './grading.controller';
import { GradingService } from './grading.service';
import { OpenCvGradingService } from './opencv-grading.service';
import { NodeGraderService } from './node-grader.service';

@Module({
  controllers: [GradingController],
  providers: [GradingService, OpenCvGradingService, NodeGraderService],
})
export class GradingModule {}
