import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { CloService } from './clo.service';
import { CreateCloDto } from './dto/create-clo.dto';
import { UpdateCloDto } from './dto/update-clo.dto';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('clos')
export class CloController {
  constructor(private readonly cloService: CloService) {}

  @Post()
  create(@Body() createCloDto: CreateCloDto) {
    return this.cloService.create(createCloDto);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.cloService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateCloDto: UpdateCloDto) {
    return this.cloService.update(+id, updateCloDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.cloService.remove(+id);
  }
}
