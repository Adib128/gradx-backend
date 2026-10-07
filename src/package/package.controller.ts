import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { GetUser } from 'src/auth/decorators/get-user.decorator';
import { PackageService } from './package.service';

@Controller('packages')
export class PackageController {
  constructor(private readonly packageService: PackageService) {}

  /** Public pricing data: active packages, their prices per period and features. */
  @Get()
  getCatalogue() {
    return this.packageService.getCatalogue();
  }

  @UseGuards(JwtAuthGuard)
  @Get('current')
  getCurrentSubscription(@GetUser('tenantId') tenantId: number) {
    return this.packageService.getCurrentSubscription(tenantId);
  }
}
