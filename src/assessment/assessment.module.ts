import { Module } from '@nestjs/common';
import { AssessmentController } from './assessment.controller';
import { AssessmentService } from './assessment.service';
import { AssessmentDownloadController } from './assessment-download.controller';

@Module({
  controllers: [AssessmentController, AssessmentDownloadController],
  providers: [AssessmentService],
})
export class AssessmentModule {}
