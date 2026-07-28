import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createReadStream } from 'node:fs';
import { GetUser } from 'src/auth/decorators/get-user.decorator';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { GenerateContentDto } from './dto/generate-content.dto';
import { TopicContentService } from './topic-content.service';

type UploadMaterialParam = 'lecture' | 'slides' | 'lab';

function toMaterialType(type: string): 'LECTURE' | 'SLIDES' | 'LAB' {
  const normalized = type.toLowerCase();
  if (normalized === 'lecture') return 'LECTURE';
  if (normalized === 'slides' || normalized === 'slide') return 'SLIDES';
  if (normalized === 'lab') return 'LAB';
  throw new BadRequestException('type must be lecture, slides, or lab');
}

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

  @Post('generate/:jobId/cancel')
  cancelGenerate(@Param('jobId') jobId: string) {
    return this.topicContentService.cancelGenerate(jobId);
  }

  @Patch(':topicId/slides')
  updateSlides(
    @GetUser('tenantId') tenantId: number,
    @Param('topicId', ParseIntPipe) topicId: number,
    @Body() body: { content?: Record<string, unknown>; slides?: unknown[] },
  ) {
    return this.topicContentService.updateSlidesDeck(tenantId, topicId, body);
  }

  @Patch(':topicId/lab')
  updateLab(
    @GetUser('tenantId') tenantId: number,
    @Param('topicId', ParseIntPipe) topicId: number,
    @Body() body: { content?: Record<string, unknown> },
  ) {
    return this.topicContentService.updateLabManual(tenantId, topicId, body);
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

  @Post(':topicId/upload/:type')
  @UseInterceptors(FileInterceptor('file'))
  uploadMaterial(
    @GetUser('tenantId') tenantId: number,
    @Param('topicId', ParseIntPipe) topicId: number,
    @Param('type') type: UploadMaterialParam,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.topicContentService.uploadTopicMaterial(
      tenantId,
      topicId,
      toMaterialType(type),
      file,
    );
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

  @Get(':topicId/slides-file')
  async getSlidesFile(
    @GetUser('tenantId') tenantId: number,
    @Param('topicId', ParseIntPipe) topicId: number,
  ) {
    const { filePath, fileName, mimeType } =
      await this.topicContentService.getSlidesFile(tenantId, topicId);

    return new StreamableFile(createReadStream(filePath), {
      type: mimeType,
      disposition: `attachment; filename="${fileName}"`,
    });
  }

  @Get(':topicId/lab-file')
  async getLabFile(
    @GetUser('tenantId') tenantId: number,
    @Param('topicId', ParseIntPipe) topicId: number,
  ) {
    const { filePath, fileName, mimeType } =
      await this.topicContentService.getLabFile(tenantId, topicId);

    return new StreamableFile(createReadStream(filePath), {
      type: mimeType,
      disposition: `attachment; filename="${fileName}"`,
    });
  }

  @Delete(':topicId/lecture')
  deleteUploadedLecture(
    @GetUser('tenantId') tenantId: number,
    @Param('topicId', ParseIntPipe) topicId: number,
  ) {
    return this.topicContentService.deleteUploadedLecture(tenantId, topicId);
  }

  @Delete(':topicId/:type')
  deleteUploadedMaterial(
    @GetUser('tenantId') tenantId: number,
    @Param('topicId', ParseIntPipe) topicId: number,
    @Param('type') type: UploadMaterialParam,
  ) {
    return this.topicContentService.deleteUploadedMaterial(
      tenantId,
      topicId,
      toMaterialType(type),
    );
  }
}
