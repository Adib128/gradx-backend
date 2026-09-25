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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserRole } from 'generated/prisma/browser';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { AdminService } from './admin.service';

@Controller('platform/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('dashboard')
  dashboard() {
    return this.adminService.dashboard();
  }

  @Get('users')
  listUsers(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('role') role?: string,
    @Query('isActive') isActive?: string,
  ) {
    return this.adminService.listUsers({
      page: Number(page),
      limit: Number(limit),
      search,
      role,
      isActive,
    });
  }

  @Get('users/:id')
  getUserDetail(@Param('id', ParseIntPipe) id: number) {
    return this.adminService.getUserDetail(id);
  }

  @Patch('users/:id')
  updateUser(
    @Param('id', ParseIntPipe) id: number,
    @Body()
    body: {
      role?: UserRole;
      isActive?: boolean;
      firstName?: string;
      lastName?: string;
      phone?: string | null;
    },
  ) {
    return this.adminService.updateUser(id, body);
  }

  @Get('universities')
  listUniversities(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.adminService.listUniversities({
      page: Number(page),
      limit: Number(limit),
      search,
    });
  }

  @Post('universities')
  createUniversity(@Body() body: Record<string, unknown>) {
    return this.adminService.createUniversity(body as any);
  }

  @Patch('universities/:id')
  updateUniversity(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.adminService.updateUniversity(id, body as any);
  }

  @Delete('universities/:id')
  deleteUniversity(@Param('id', ParseIntPipe) id: number) {
    return this.adminService.deleteUniversity(id);
  }

  @Post('universities/:id/logo')
  @UseInterceptors(FileInterceptor('file'))
  uploadLogo(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.adminService.uploadUniversityLogo(id, file);
  }

  @Get('faculties')
  listFaculties(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.adminService.listFaculties({
      page: Number(page),
      limit: Number(limit),
      search,
    });
  }

  @Post('universities/:id/faculties')
  upsertFaculty(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { facultyId?: string; en: string; ar: string },
  ) {
    return this.adminService.upsertFaculty(id, body);
  }

  @Delete('universities/:id/faculties/:facultyId')
  deleteFaculty(
    @Param('id', ParseIntPipe) id: number,
    @Param('facultyId') facultyId: string,
  ) {
    return this.adminService.deleteFaculty(id, facultyId);
  }

  @Get('plans')
  listPlans(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.adminService.listPlans({
      page: Number(page),
      limit: Number(limit),
      search,
    });
  }

  @Post('plans')
  createPlan(@Body() body: Record<string, unknown>) {
    return this.adminService.createPlan(body as any);
  }

  @Patch('plans/:id')
  updatePlan(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.adminService.updatePlan(id, body);
  }

  @Delete('plans/:id')
  deletePlan(@Param('id', ParseIntPipe) id: number) {
    return this.adminService.deletePlan(id);
  }

  @Get('subscriptions')
  listSubscriptions(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    return this.adminService.listSubscriptions({
      page: Number(page),
      limit: Number(limit),
      search,
      status,
    });
  }

  @Post('subscriptions')
  createSubscription(@Body() body: Record<string, unknown>) {
    return this.adminService.createSubscription(body as any);
  }

  @Patch('subscriptions/:id')
  updateSubscription(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.adminService.updateSubscription(id, body as any);
  }

  @Get('ai-logs')
  listAiLogs(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('purpose') purpose?: string,
    @Query('success') success?: string,
    @Query('userId') userId?: string,
  ) {
    return this.adminService.listAiLogs({
      page: Number(page),
      limit: Number(limit),
      search,
      purpose,
      success,
      userId,
    });
  }

  @Get('login-logs')
  listLoginLogs(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('success') success?: string,
    @Query('userId') userId?: string,
  ) {
    return this.adminService.listLoginLogs({
      page: Number(page),
      limit: Number(limit),
      search,
      success,
      userId,
    });
  }

  @Get('tenants')
  listTenants(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.listTenants({
      page: Number(page),
      limit: Number(limit),
    });
  }
}
