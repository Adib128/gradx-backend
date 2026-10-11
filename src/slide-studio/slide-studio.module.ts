import { Module } from '@nestjs/common';
import { ReferenceVectorModule } from 'src/reference-vector/reference-vector.module';
import { SlideStudioController } from './slide-studio.controller';
import { SlideStudioLlm } from './slide-studio.llm';
import { SlideStudioService } from './slide-studio.service';
import { SlideTemplatesService } from './slide-templates.service';

@Module({
  imports: [ReferenceVectorModule],
  controllers: [SlideStudioController],
  providers: [SlideStudioService, SlideStudioLlm, SlideTemplatesService],
})
export class SlideStudioModule {}
