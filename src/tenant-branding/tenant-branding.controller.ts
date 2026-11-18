import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { GetUser } from 'src/auth/decorators/get-user.decorator';
import { TenantBrandingService } from './tenant-branding.service';
import type { TenantBranding } from './tenant-branding.types';

@UseGuards(JwtAuthGuard)
@Controller('tenant/branding')
export class TenantBrandingController {
  constructor(private readonly tenantBrandingService: TenantBrandingService) {}

  @Get()
  get(@GetUser('tenantId') tenantId: number) {
    return this.tenantBrandingService.get(tenantId);
  }

  @Patch()
  update(
    @GetUser('tenantId') tenantId: number,
    @Body() body: Partial<TenantBranding>,
  ) {
    return this.tenantBrandingService.update(tenantId, body || {});
  }

  @Post('logo')
  @UseInterceptors(FileInterceptor('file'))
  uploadLogo(
    @GetUser('tenantId') tenantId: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.tenantBrandingService.uploadLogo(tenantId, file);
  }
}
