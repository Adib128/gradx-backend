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
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { AdminPackagesService } from './admin-packages.service';
import {
  CreateBillingPeriodDto,
  CreatePackageDto,
  CreatePlanFeatureDto,
  UpdateBillingPeriodDto,
  UpdatePackageDto,
  UpdatePlanFeatureDto,
} from './dto/packages.dto';

/** Packages ("plans"), their feature values and per-period prices. */
@Controller('platform/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminPackagesController {
  constructor(private readonly packages: AdminPackagesService) {}

  @Get('plans')
  listPackages(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.packages.listPackages({
      page: Number(page),
      limit: Number(limit),
      search,
    });
  }

  @Get('plans/:id')
  getPackage(@Param('id', ParseIntPipe) id: number) {
    return this.packages.getPackage(id);
  }

  @Post('plans')
  createPackage(@Body() body: CreatePackageDto) {
    return this.packages.createPackage(body);
  }

  @Patch('plans/:id')
  updatePackage(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdatePackageDto,
  ) {
    return this.packages.updatePackage(id, body);
  }

  @Delete('plans/:id')
  deletePackage(@Param('id', ParseIntPipe) id: number) {
    return this.packages.deletePackage(id);
  }

  @Get('billing-periods')
  listBillingPeriods() {
    return this.packages.listBillingPeriods();
  }

  @Post('billing-periods')
  createBillingPeriod(@Body() body: CreateBillingPeriodDto) {
    return this.packages.createBillingPeriod(body);
  }

  @Patch('billing-periods/:id')
  updateBillingPeriod(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateBillingPeriodDto,
  ) {
    return this.packages.updateBillingPeriod(id, body);
  }

  @Delete('billing-periods/:id')
  deleteBillingPeriod(@Param('id', ParseIntPipe) id: number) {
    return this.packages.deleteBillingPeriod(id);
  }

  @Get('plan-features')
  listPlanFeatures() {
    return this.packages.listPlanFeatures();
  }

  @Post('plan-features')
  createPlanFeature(@Body() body: CreatePlanFeatureDto) {
    return this.packages.createPlanFeature(body);
  }

  @Patch('plan-features/:id')
  updatePlanFeature(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdatePlanFeatureDto,
  ) {
    return this.packages.updatePlanFeature(id, body);
  }

  @Delete('plan-features/:id')
  deletePlanFeature(@Param('id', ParseIntPipe) id: number) {
    return this.packages.deletePlanFeature(id);
  }
}
