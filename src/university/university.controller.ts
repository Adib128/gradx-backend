import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { UniversityService } from './university.service';

@UseGuards(JwtAuthGuard)
@Controller('universities')
export class UniversityController {
  constructor(private readonly universityService: UniversityService) {}

  @Get()
  findAll() {
    return this.universityService.findAll();
  }

  @Get(':code')
  findByCode(@Param('code') code: string) {
    return this.universityService.findByCode(code);
  }
}
