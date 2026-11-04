import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { GenerationPlansService } from './generation-plans.service';

/** Instructor-facing catalogue of active content-generation quality plans. */
@Controller('generation-plans')
@UseGuards(JwtAuthGuard)
export class GenerationPlansController {
  constructor(private readonly plans: GenerationPlansService) {}

  @Get()
  listActive() {
    return this.plans.listActive();
  }
}
