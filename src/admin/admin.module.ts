import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminPackagesController } from './admin-packages.controller';
import { AdminPackagesService } from './admin-packages.service';
import { AdminGenerationPlansController } from './admin-generation-plans.controller';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { GenerationPlansModule } from 'src/generation-plans/generation-plans.module';
import { PackageModule } from 'src/package/package.module';

@Module({
  imports: [PackageModule, GenerationPlansModule],
  controllers: [AdminController, AdminPackagesController, AdminGenerationPlansController],
  providers: [AdminService, AdminPackagesService, RolesGuard],
  exports: [AdminService],
})
export class AdminModule {}
