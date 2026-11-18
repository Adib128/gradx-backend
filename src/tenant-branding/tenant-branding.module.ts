import { Module } from '@nestjs/common';
import { TenantBrandingController } from './tenant-branding.controller';
import { TenantBrandingService } from './tenant-branding.service';

@Module({
  controllers: [TenantBrandingController],
  providers: [TenantBrandingService],
  exports: [TenantBrandingService],
})
export class TenantBrandingModule {}
