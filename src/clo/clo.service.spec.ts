import { Test, TestingModule } from '@nestjs/testing';
import { CloService } from './clo.service';

describe('CloService', () => {
  let service: CloService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CloService],
    }).compile();

    service = module.get<CloService>(CloService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
