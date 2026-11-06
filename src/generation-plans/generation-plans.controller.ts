import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { STUDIO_REFERENCE_SLIDES } from './generation-plan.presets';
import { GenerationPlansService } from './generation-plans.service';

/** Instructor-facing catalogue of active content-generation quality plans. */
@Controller('generation-plans')
@UseGuards(JwtAuthGuard)
export class GenerationPlansController {
  constructor(private readonly plans: GenerationPlansService) {}

  @Get()
  listActive(@Query('slideCount') slideCount?: string) {
    const parsed = Number(slideCount);
    return this.plans.listActive(
      Number.isFinite(parsed) ? parsed : STUDIO_REFERENCE_SLIDES,
    );
  }
}
