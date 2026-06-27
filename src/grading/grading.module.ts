import { Module } from '@nestjs/common';
import { GradingController } from './grading.controller';
import { GradingService } from './grading.service';
import { OpenCvGradingService } from './opencv-grading.service';

@Module({
  controllers: [GradingController],
  providers: [GradingService, OpenCvGradingService],
})
export class GradingModule {}
