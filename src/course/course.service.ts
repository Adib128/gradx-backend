import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';
import { PrismaService } from 'prisma/prisma.service';
import { CourseQueryDto } from './dto/course-query.dto';
import { paginate } from 'src/common/helpers/paginate.helper';
import { Job, Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { ErrorMessageKey } from 'src/common/constants/error-message';
import { GenerationStatus } from 'generated/prisma/enums';

@Injectable()
export class CourseService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('course-extraction') private readonly extractionQueue: Queue,
  ) {}

  async confirmAndSave(tenantId: number, createCourseDto: CreateCourseDto) {
    const {
      clos,
      topics,
      assessments,
      references,
      prerequisites,
      ...courseData
    } = createCourseDto;

    return await this.prisma.course.create({
      data: {
        ...courseData,
        tenantId,
        prerequisites,
        references,
        assessments: {
          create: assessments.map((assessment) => ({
            title: assessment.title,
            type: assessment.type,
            tenantId,
          })),
        },
        clos: {
          create: clos.map((clo) => ({
            code: clo.code,
            category: clo.category,
            programCLOCode: clo.programCLOCode,
            description: clo.description,
            teachingStrategies: clo.teachingStrategies,
            assessmentMethods: clo.assessmentMethods,
          })),
        },
        topics: {
          create: topics.map((topic) => ({
            topicNumber: topic.topicNumber,
            title: topic.title,
            contactHours: topic.contactHours,
          })),
        },
      },
      include: {
        clos: true,
        topics: true,
      },
    });
  }

  async findAll(tenantId: number, courseQueryDto: CourseQueryDto) {
    const { page, limit, search } = courseQueryDto;

    const skip = (page - 1) * limit;

    const where = {
      tenantId,
      ...(search && {
        OR: [
          { title: { contains: search, mode: 'insensitive' as const } },
          { code: { contains: search, mode: 'insensitive' as const } },
        ],
      }),
    };

    const [courses, total] = await Promise.all([
      this.prisma.course.findMany({
        where,
        skip,
        take: limit,
        select: {
          id: true,
          title: true,
          code: true,
        },
      }),
      this.prisma.course.count({ where }),
    ]);

    return paginate(courses, total, page, limit);
  }

  async extractFromPdfFile(file: Express.Multer.File) {
    const base64 = file.buffer.toString('base64');

    const job = await this.extractionQueue.add(
      'extract',
      { base64 },
      {
        attempts: 3, // ← retry 3 times on failure
        backoff: {
          type: 'exponential',
          delay: 2000, // ← wait 2s, 4s, 8s between retries
        },
        removeOnComplete: false, // ← keep result in Redis for polling
        removeOnFail: false,
      },
    );

    return { jobId: job.id, status: 'processing' };
  }

  async getExtractionStatus(jobId: string) {
    const job = await Job.fromId(this.extractionQueue, jobId);

    if (!job) throw new NotFoundException('Job not found');

    const state = await job.getState(); // waiting | active | completed | failed

    return {
      jobId,
      status: state,
      progress: job.progress,
      result: state === 'completed' ? job.returnvalue : null,
      error: state === 'failed' ? job.failedReason : null,
    };
  }

  async findOne(id: number) {
    const course = await this.prisma.course.findUnique({
      where: { id },
      include: {
        clos: true,
        assessments: true,
        topics: {
          include: {
            // Drill down into the topicContents table for each topic
            topicContents: {
              where: {
                // Only return content that is completely generated
                status: GenerationStatus.COMPLETED,
              },
              select: {
                id: true,
                type: true,
                status: true,
                content: true, // This contains your raw generated JSON payload
                createdAt: true,
              },
            },
          },
        },
      },
    });

    if (!course) {
      throw new ConflictException(ErrorMessageKey.COURSE_NOT_FOUND);
    }
    return course;
  }

  update(id: number, updateCourseDto: UpdateCourseDto) {
    return `This action updates a #${id} course`;
  }

  remove(id: number) {
    return `This action removes a #${id} course`;
  }
}
