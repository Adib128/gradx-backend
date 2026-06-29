import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createReadStream } from 'node:fs';
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
    @Body() generateContentDto: GenerateContentDto,
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

  @Post(':topicId/upload-lecture')
  @UseInterceptors(FileInterceptor('file'))
  uploadLecture(
    @GetUser('tenantId') tenantId: number,
    @Param('topicId', ParseIntPipe) topicId: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.topicContentService.uploadLecture(tenantId, topicId, file);
  }

  @Get(':topicId/lecture-file')
  async getLectureFile(
    @GetUser('tenantId') tenantId: number,
    @Param('topicId', ParseIntPipe) topicId: number,
  ) {
    const { filePath, fileName, mimeType } =
      await this.topicContentService.getLectureFile(tenantId, topicId);

    return new StreamableFile(createReadStream(filePath), {
      type: mimeType,
      disposition: `inline; filename="${fileName}"`,
    });
  }

  @Delete(':topicId/lecture')
  deleteUploadedLecture(
    @GetUser('tenantId') tenantId: number,
    @Param('topicId', ParseIntPipe) topicId: number,
  ) {
    return this.topicContentService.deleteUploadedLecture(tenantId, topicId);
  }
}
