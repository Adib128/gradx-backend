import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { GradingController } from './grading.controller';
import { GradingService } from './grading.service';
import { OpenCvGradingService } from './opencv-grading.service';
import { NodeGraderService } from './node-grader.service';
import { StudentInfoVisionService } from './student-info-vision.service';
import { GRADING_QUEUE } from './grading.constants';
import { GradingQueueService } from './grading-queue.service';
import { GradingProcessor } from './processors/grading.processor';

@Module({
  imports: [BullModule.registerQueue({ name: GRADING_QUEUE })],
  controllers: [GradingController],
  providers: [
    GradingService,
    GradingQueueService,
    GradingProcessor,
    OpenCvGradingService,
    NodeGraderService,
    StudentInfoVisionService,
  ],
})
export class GradingModule {}
