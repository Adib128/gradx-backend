import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from 'generated/prisma/browser';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import {
  CreateGenerationPlanDto,
  UpdateGenerationPlanDto,
  UpdateGenerationPlanModelDto,
  UpsertGenerationPlanModelDto,
} from 'src/generation-plans/dto/generation-plans.dto';
import { GenerationPlansService } from 'src/generation-plans/generation-plans.service';

@Controller('platform/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminGenerationPlansController {
  constructor(private readonly plans: GenerationPlansService) {}

  @Get('generation-plans')
  list(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.plans.listAdmin({
      page: Number(page),
      limit: Number(limit),
      search,
    });
  }

  @Get('generation-plans/:id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.plans.getById(id);
  }

  @Post('generation-plans')
  create(@Body() body: CreateGenerationPlanDto) {
    return this.plans.create(body);
  }

  @Patch('generation-plans/:id')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: UpdateGenerationPlanDto) {
    return this.plans.update(id, body);
  }

  @Delete('generation-plans/:id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.plans.remove(id);
  }

  @Post('generation-plans/:id/models')
  upsertModel(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpsertGenerationPlanModelDto,
  ) {
    return this.plans.upsertModel(id, body);
  }

  @Patch('generation-plans/:planId/models/:modelId')
  updateModel(
    @Param('planId', ParseIntPipe) planId: number,
    @Param('modelId', ParseIntPipe) modelId: number,
    @Body() body: UpdateGenerationPlanModelDto,
  ) {
    return this.plans.updateModel(planId, modelId, body);
  }

  @Delete('generation-plans/:planId/models/:modelId')
  removeModel(
    @Param('planId', ParseIntPipe) planId: number,
    @Param('modelId', ParseIntPipe) modelId: number,
  ) {
    return this.plans.removeModel(planId, modelId);
  }
}
