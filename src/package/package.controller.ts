import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { GetUser } from 'src/auth/decorators/get-user.decorator';
import { PackageService } from './package.service';
import { RenewDto, SubscribeDto } from './dto/subscribe.dto';

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

  @UseGuards(JwtAuthGuard)
  @Get('me')
  getMine(@GetUser('tenantId') tenantId: number) {
    return this.packageService.getMine(tenantId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('renew')
  renew(
    @GetUser() user: { userId: number; tenantId: number },
    @Body() body: RenewDto,
  ) {
    return this.packageService.renew(user, body);
  }

  @UseGuards(JwtAuthGuard)
  @Post('subscriptions/:id/cancel')
  cancelOrder(
    @GetUser('tenantId') tenantId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.packageService.cancelOrder(tenantId, id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('subscribe')
  subscribe(
    @GetUser() user: { userId: number; tenantId: number },
    @Body() body: SubscribeDto,
  ) {
    return this.packageService.subscribe(user, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get('subscriptions/:id')
  getSubscription(
    @GetUser('tenantId') tenantId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.packageService.getSubscription(tenantId, id);
  }
}
