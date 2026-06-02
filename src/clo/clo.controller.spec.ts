import { Test, TestingModule } from '@nestjs/testing';
import { CloController } from './clo.controller';
import { CloService } from './clo.service';

describe('CloController', () => {
  let controller: CloController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CloController],
      providers: [CloService],
    }).compile();

    controller = module.get<CloController>(CloController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
