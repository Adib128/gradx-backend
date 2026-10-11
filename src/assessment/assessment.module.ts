import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AssessmentController } from './assessment.controller';
import { AssessmentService } from './assessment.service';
import { AssessmentDownloadController } from './assessment-download.controller';
import { AssessmentGenerationProcessor } from './processors/assessment-generation.processor';
import { ReferenceVectorModule } from 'src/reference-vector/reference-vector.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'assessment-generation',
    }),
    ReferenceVectorModule,
  ],
  controllers: [AssessmentController, AssessmentDownloadController],
  providers: [AssessmentService, AssessmentGenerationProcessor],
})
export class AssessmentModule {}
