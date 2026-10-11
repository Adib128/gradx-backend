import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { GetUser } from 'src/auth/decorators/get-user.decorator';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import {
  ResumeSlideStudioDto,
  SaveSlideTemplateDto,
  StartSlideStudioDto,
} from './dto/slide-studio.dto';
import { SlideStudioService } from './slide-studio.service';
import { SlideTemplatesService } from './slide-templates.service';

/**
 * Multi-agent, human-in-the-loop slide generation. The POST endpoints stream
 * Server-Sent Events until the graph pauses for the instructor (`interrupt`)
 * or finishes (`done`).
 */
@UseGuards(JwtAuthGuard)
@Controller('slide-studio')
export class SlideStudioController {
  constructor(
    private readonly slideStudioService: SlideStudioService,
    private readonly slideTemplates: SlideTemplatesService,
  ) {}

  @Get('templates')
  templates(@GetUser('tenantId') tenantId: number) {
    return this.slideTemplates.list(tenantId);
  }

  @Post('templates')
  createTemplate(
    @GetUser('tenantId') tenantId: number,
    @GetUser('userId') userId: number,
    @Body() dto: SaveSlideTemplateDto,
  ) {
    return this.slideTemplates.create(tenantId, userId ?? null, dto);
  }

  @Post('templates/assets')
  @UseInterceptors(FileInterceptor('file'))
  uploadTemplateAsset(
    @GetUser('tenantId') tenantId: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.slideTemplates.uploadAsset(tenantId, file);
  }

  @Patch('templates/:templateId')
  updateTemplate(
    @GetUser('tenantId') tenantId: number,
    @GetUser('userId') userId: number,
    @Param('templateId') templateId: string,
    @Body() dto: SaveSlideTemplateDto,
  ) {
    return this.slideTemplates.update(tenantId, userId ?? null, templateId, dto);
  }

  @Delete('templates/:templateId')
  deleteTemplate(
    @GetUser('tenantId') tenantId: number,
    @Param('templateId') templateId: string,
  ) {
    return this.slideTemplates.remove(tenantId, templateId);
  }

  @Get('topics/:topicId/session')
  topicSession(
    @GetUser('tenantId') tenantId: number,
    @Param('topicId', ParseIntPipe) topicId: number,
  ) {
    return this.slideStudioService.getTopicSession(tenantId, topicId);
  }

  @Post('topics/:topicId/sessions')
  start(
    @GetUser('tenantId') tenantId: number,
    @GetUser('userId') userId: number,
    @Param('topicId', ParseIntPipe) topicId: number,
    @Body() dto: StartSlideStudioDto,
    @Res() res: Response,
  ) {
    return this.slideStudioService.startSession(tenantId, userId, topicId, dto, res);
  }

  @Get('sessions/:sessionId')
  session(
    @GetUser('tenantId') tenantId: number,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return this.slideStudioService.getSession(tenantId, sessionId);
  }

  @Post('sessions/:sessionId/resume')
  resume(
    @GetUser('tenantId') tenantId: number,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() dto: ResumeSlideStudioDto,
    @Res() res: Response,
  ) {
    return this.slideStudioService.resumeSession(tenantId, sessionId, dto, res);
  }

  @Post('sessions/:sessionId/continue')
  continue(
    @GetUser('tenantId') tenantId: number,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Res() res: Response,
  ) {
    return this.slideStudioService.continueSession(tenantId, sessionId, res);
  }

  @Delete('sessions/:sessionId')
  discard(
    @GetUser('tenantId') tenantId: number,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return this.slideStudioService.discardSession(tenantId, sessionId);
  }
}
