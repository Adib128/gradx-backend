import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ReferenceEmbeddingProcessor } from './processors/reference-embedding.processor';
import {
  REFERENCE_EMBEDDING_QUEUE,
  ReferenceVectorService,
} from './reference-vector.service';

@Module({
  imports: [BullModule.registerQueue({ name: REFERENCE_EMBEDDING_QUEUE })],
  providers: [ReferenceVectorService, ReferenceEmbeddingProcessor],
  exports: [ReferenceVectorService],
})
export class ReferenceVectorModule {}
