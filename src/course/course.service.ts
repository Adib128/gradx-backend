import {
  BadRequestException,
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
import { Prisma } from 'generated/prisma/client';

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
      assessments: _assessments,
      references,
      prerequisites,
      coRequisites,
      teachingModes,
      requiredFacilitiesAndEquipment,
      ...courseData
    } = createCourseDto;
    void _assessments;

    return await this.prisma.$transaction(async (tx) => {
      const courseCreateData: Prisma.CourseUncheckedCreateInput = {
        ...(courseData as Prisma.CourseUncheckedCreateInput),
        tenantId,
        prerequisites,
        coRequisites,
        teachingModes: (teachingModes ?? []) as Prisma.InputJsonValue,
        requiredFacilitiesAndEquipment:
          (requiredFacilitiesAndEquipment ?? []) as Prisma.InputJsonValue,
        references: (references ?? []) as Prisma.InputJsonValue,
      };

      const course = await tx.course.create({
        data: courseCreateData,
      });

      const createdClos = await Promise.all(
        clos.map((clo) =>
          tx.clo.create({
            data: {
              code: clo.code,
              category: clo.category,
              programCLOCode: clo.programCLOCode,
              description: clo.description,
              teachingStrategies: clo.teachingStrategies,
              assessmentMethods: clo.assessmentMethods,
              courseId: course.id,
            },
          }),
        ),
      );

      const cloCodeToId = new Map<string, number>(
        createdClos
          .filter((clo) => typeof clo.code === 'string' && clo.code.trim())
          .map((clo) => [clo.code, clo.id]),
      );

      const createdTopics = await Promise.all(
        topics.map(async (topic) => {
          const { mappedClos = [], ...topicData } = topic;

          const createdTopic = await tx.topic.create({
            data: {
              ...topicData,
              courseId: course.id,
            },
          });

          const mappedClosCodes = Array.isArray(mappedClos) ? mappedClos : [];
          if (mappedClosCodes.length > 0) {
            const topicCloRows: Array<{ topicId: number; cloId: number }> =
              mappedClosCodes
              .filter((code): code is string => typeof code === 'string')
              .map((code) => ({
                topicId: createdTopic.id,
                cloId: cloCodeToId.get(code),
              }))
              .filter((row): row is { topicId: number; cloId: number } =>
                typeof row.cloId === 'number',
              );

            if (topicCloRows.length > 0) {
              await tx.topicClo.createMany({ data: topicCloRows });
            }
          }

          return createdTopic;
        }),
      );

      return { ...course, topics: createdTopics };
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
      this.prisma.extended.course.findMany({
        where,
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          title: true,
          code: true,
          program: true,
          creditHours: true,
          totalContactHours: true,
          updatedAt: true,
          _count: {
            select: {
              students: true,
              assessments: true,
              topics: true,
            },
          },
        },
      }),
      this.prisma.extended.course.count({ where }),
    ]);

    return paginate(courses, total, page, limit);
  }

  async extractFromPdfFile(file: Express.Multer.File) {
    if (!file?.buffer) {
      throw new BadRequestException('File is required');
    }

    const base64 = file.buffer.toString('base64');

    const job = await this.extractionQueue.add(
      'extract',
      {
        base64,
        mimeType: file.mimetype,
        filename: file.originalname,
      },
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
            topicContents: {
              where: {
                status: GenerationStatus.COMPLETED,
              },
              select: {
                id: true,
                type: true,
                status: true,
                content: true,
                createdAt: true,
              },
            },
            topicClos: {
              include: {
                clo: true,
              },
            },
          },
        },
        students: true,
      },
    });

    if (!course) {
      throw new ConflictException(ErrorMessageKey.COURSE_NOT_FOUND);
    }
    return course;
  }

  async update(id: number, updateCourseDto: UpdateCourseDto) {
    await this.findCourse(id);

    const {
      title, code, program, description, creditHours, level,
      teachingMode, teachingModes, totalContactHours, lectureHours, labHours,
      prerequisites, coRequisites, requiredFacilitiesAndEquipment, references,
    } = updateCourseDto;

    return this.prisma.course.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(code !== undefined && { code }),
        ...(program !== undefined && { program }),
        ...(description !== undefined && { description }),
        ...(creditHours !== undefined && { creditHours }),
        ...(level !== undefined && { level }),
        ...(teachingMode !== undefined && { teachingMode }),
        ...(teachingModes !== undefined && { teachingModes: teachingModes as unknown as Prisma.InputJsonValue }),
        ...(totalContactHours !== undefined && { totalContactHours }),
        ...(lectureHours !== undefined && { lectureHours }),
        ...(labHours !== undefined && { labHours }),
        ...(prerequisites !== undefined && { prerequisites }),
        ...(coRequisites !== undefined && { coRequisites }),
        ...(requiredFacilitiesAndEquipment !== undefined && {
          requiredFacilitiesAndEquipment: requiredFacilitiesAndEquipment as unknown as Prisma.InputJsonValue,
        }),
        ...(references !== undefined && { references: references as unknown as Prisma.InputJsonValue }),
      },
    });
  }

  /** Update only meta fields — safe shorthand used by the Course Details edit modal. */
  async updateMeta(
    id: number,
    body: {
      title?: string;
      code?: string;
      program?: string;
      description?: string;
      creditHours?: number | null;
      level?: string;
      totalContactHours?: number | null;
      lectureHours?: number | null;
      labHours?: number | null;
      prerequisites?: string[];
      coRequisites?: string[];
      teachingModes?: Array<{ modeOfInstruction: string; contactHours?: number | null; percentage?: number | null }>;
      requiredFacilitiesAndEquipment?: Array<{ item: string; resources?: string | null }>;
    },
  ) {
    await this.findCourse(id);
    return this.prisma.course.update({
      where: { id },
      data: {
        ...(body.title !== undefined && { title: body.title }),
        ...(body.code !== undefined && { code: body.code }),
        ...(body.program !== undefined && { program: body.program }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.creditHours !== undefined && { creditHours: body.creditHours }),
        ...(body.level !== undefined && { level: body.level }),
        ...(body.totalContactHours !== undefined && { totalContactHours: body.totalContactHours }),
        ...(body.lectureHours !== undefined && { lectureHours: body.lectureHours }),
        ...(body.labHours !== undefined && { labHours: body.labHours }),
        ...(body.prerequisites !== undefined && { prerequisites: body.prerequisites }),
        ...(body.coRequisites !== undefined && { coRequisites: body.coRequisites }),
        ...(body.teachingModes !== undefined && {
          teachingModes: body.teachingModes as unknown as Prisma.InputJsonValue,
        }),
        ...(body.requiredFacilitiesAndEquipment !== undefined && {
          requiredFacilitiesAndEquipment: body.requiredFacilitiesAndEquipment as unknown as Prisma.InputJsonValue,
        }),
      },
    });
  }

  async remove(id: number) {
    await this.findCourse(id);
    return await this.prisma.extended.course.delete({
      where: { id },
    });
  }

  private async findCourse(id: number) {
    const course = await this.prisma.course.findUnique({ where: { id } });
    if (!course) {
      throw new NotFoundException(ErrorMessageKey.COURSE_NOT_FOUND);
    }
  }
}
