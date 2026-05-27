import { Test, TestingModule } from '@nestjs/testing';
import { DepartementService } from './departement.service';

const mockPrisma = {
  departement: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
};

describe('DepartementService', () => {
  let service: DepartementService;
  let prisma: typeof mockPrisma;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DepartementService],
    }).compile();

    service = module.get<DepartementService>(DepartementService);
    prisma = mockPrisma;
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
