import { Module } from '@nestjs/common';
import { GenerationPlansModule } from 'src/generation-plans/generation-plans.module';
import { ReferenceVectorModule } from 'src/reference-vector/reference-vector.module';
import { SlideStudioController } from './slide-studio.controller';
import { SlideStudioLlm } from './slide-studio.llm';
import { SlideStudioService } from './slide-studio.service';
import { SlideTemplatesService } from './slide-templates.service';

@Module({
  imports: [ReferenceVectorModule, GenerationPlansModule],
  controllers: [SlideStudioController],
  providers: [SlideStudioService, SlideStudioLlm, SlideTemplatesService],
})
export class SlideStudioModule {}
