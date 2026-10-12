import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminPackagesController } from './admin-packages.controller';
import { AdminPackagesService } from './admin-packages.service';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { PackageModule } from 'src/package/package.module';

@Module({
  imports: [PackageModule],
  controllers: [AdminController, AdminPackagesController],
  providers: [AdminService, AdminPackagesService, RolesGuard],
  exports: [AdminService],
})
export class AdminModule {}
