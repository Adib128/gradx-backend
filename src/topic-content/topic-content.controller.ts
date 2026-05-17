import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { GetUser } from 'src/auth/decorators/get-user.decorator';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { GenerateContentDto } from './dto/generate-content.dto';
import { TopicContentService } from './topic-content.service';

@UseGuards(JwtAuthGuard)
@Controller('topic-contents')
export class TopicContentController {
  constructor(private readonly topicContentService: TopicContentService) {}
  @Post(':topicId/generate')
  generate(
    @GetUser('tenantId') tenantId: number,
    @Param('topicId', ParseIntPipe) topicId: number,
    generateContentDto: GenerateContentDto,
  ) {
    return this.topicContentService.generate(
      tenantId,
      topicId,
      generateContentDto,
    );
  }

  @Get('generate/:jobId/status')
  getGenerateStatus(@Param('jobId') jobId: string) {
    return this.topicContentService.getGenerateStatus(jobId);
  }
}
