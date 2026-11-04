import { Module } from '@nestjs/common';
import { GenerationPlansController } from './generation-plans.controller';
import { GenerationPlansService } from './generation-plans.service';

@Module({
  controllers: [GenerationPlansController],
  providers: [GenerationPlansService],
  exports: [GenerationPlansService],
})
export class GenerationPlansModule {}
