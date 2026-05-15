import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Request,
  UseGuards,
} from '@nestjs/common';
import { DepartementService } from './departement.service';
import { CreateDepartementDto } from './dto/create-departement.dto';
import { UpdateDepartementDto } from './dto/update-departement.dto';
import { GetUser } from 'src/auth/decorators/get-user.decorator';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('departements')
export class DepartementController {
  constructor(private readonly departementService: DepartementService) {}

  @Post()
  create(
    @GetUser('tenantId') tenantId: number,
    @Body() createDepartementDto: CreateDepartementDto,
  ) {
    return this.departementService.create(tenantId, createDepartementDto);
  }

  @Get()
  findAll(@GetUser('tenantId') tenantId: number) {
    return this.departementService.findAll(tenantId);
  }

  @Get(':id')
  findOne(@GetUser('tenantId') tenantId: number, @Param('id') id: string) {
    return this.departementService.findOne(tenantId, +id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateDepartementDto: UpdateDepartementDto,
  ) {
    return this.departementService.update(+id, updateDepartementDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.departementService.remove(+id);
  }
}
