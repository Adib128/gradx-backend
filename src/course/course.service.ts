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
import { generationErrorPayload } from 'src/common/helpers/generation-error.helper';
import { GenerationStatus } from 'generated/prisma/enums';
import { Prisma } from 'generated/prisma/client';
import {
  normalizeClosForStorage,
  remapMappedClos,
} from './utils/normalize-clos';
import { requireTenantId } from 'src/common/helpers/require-tenant.helper';

@Injectable()
export class CourseService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('course-extraction') private readonly extractionQueue: Queue,
  ) {}

  async confirmAndSave(tenantId: number, createCourseDto: CreateCourseDto) {
    const {
      clos: rawClos,
      topics: rawTopics,
      assessments = [],
      references,
      prerequisites,
      coRequisites,
      teachingModes,
      requiredFacilitiesAndEquipment,
      ...courseData
    } = createCourseDto;

    const { clos, codeRemap } = normalizeClosForStorage(rawClos ?? []);
    const topics = (rawTopics ?? []).map((topic) => ({
      ...topic,
      mappedClos: remapMappedClos(topic.mappedClos, codeRemap),
    }));

    return await this.prisma.$transaction(async (tx) => {
      const assessmentPlan = (assessments ?? [])
        .map((assessment) => ({
          title: String(assessment.title ?? '').trim() || null,
          type: assessment.type,
          timing: assessment.timing ?? null,
          percentage:
            assessment.percentage != null &&
            Number.isFinite(Number(assessment.percentage))
              ? Math.round(Number(assessment.percentage))
              : null,
        }))
        .filter((item) => Boolean(item.type));

      const courseCreateData: Prisma.CourseUncheckedCreateInput = {
        ...(courseData as Prisma.CourseUncheckedCreateInput),
        tenantId,
        prerequisites,
        coRequisites,
        teachingModes: (teachingModes ?? []) as Prisma.InputJsonValue,
        requiredFacilitiesAndEquipment:
          (requiredFacilitiesAndEquipment ?? []) as Prisma.InputJsonValue,
        references: (references ?? []) as Prisma.InputJsonValue,
        assessmentPlan: assessmentPlan as Prisma.InputJsonValue,
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

      // Syllabus only stores assessment type plan metadata on the course.
      // Real Assessment records are created later by the user.

      return {
        ...course,
        topics: createdTopics,
        assessments: [],
        assessmentPlan,
      };
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
      throw new BadRequestException(ErrorMessageKey.COURSE_EXTRACT_FILE_REQUIRED);
    }

    const base64 = file.buffer.toString('base64');

    try {
      const job = await this.extractionQueue.add(
        'extract',
        {
          base64,
          mimeType: file.mimetype,
          filename: file.originalname,
        },
        {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
          removeOnComplete: false,
          removeOnFail: false,
        },
      );

      return { jobId: job.id, status: 'processing' };
    } catch {
      throw new BadRequestException(ErrorMessageKey.GENERATION_QUEUE_UNAVAILABLE);
    }
  }

  async getExtractionStatus(jobId: string) {
    const job = await Job.fromId(this.extractionQueue, jobId);

    if (!job) throw new NotFoundException(ErrorMessageKey.GENERATION_JOB_NOT_FOUND);

    const state = await job.getState();
    const failure = generationErrorPayload(
      state === 'failed' ? job.failedReason : null,
      ErrorMessageKey.COURSE_EXTRACT_FAILED,
    );

    return {
      jobId,
      status: state,
      progress: job.progress,
      result: state === 'completed' ? job.returnvalue : null,
      error: failure.error,
      errorKey: failure.errorKey,
    };
  }

  async findOne(tenantId: number, id: number) {
    const tid = requireTenantId(tenantId);
    const course = await this.prisma.course.findFirst({
      where: { id, tenantId: tid },
      include: {
        clos: true,
        assessments: {
          where: { tenantId: tid },
          orderBy: { createdAt: 'desc' },
        },
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

  async update(tenantId: number, id: number, updateCourseDto: UpdateCourseDto) {
    await this.findCourse(tenantId, id);

    const {
      title, code, program, description, creditHours, level, passRate,
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
        ...(passRate !== undefined &&
          passRate !== null &&
          Number.isFinite(Number(passRate)) && {
            passRate: Math.min(100, Math.max(0, Math.round(Number(passRate)))),
          }),
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
    tenantId: number,
    id: number,
    body: {
      title?: string;
      code?: string;
      program?: string;
      description?: string;
      creditHours?: number | null;
      level?: string;
      passRate?: number | null;
      totalContactHours?: number | null;
      lectureHours?: number | null;
      labHours?: number | null;
      prerequisites?: string[];
      coRequisites?: string[];
      teachingModes?: Array<{ modeOfInstruction: string; contactHours?: number | null; percentage?: number | null }>;
      requiredFacilitiesAndEquipment?: Array<{ item: string; resources?: string | null }>;
    },
  ) {
    await this.findCourse(tenantId, id);
    const passRate =
      body.passRate === null || body.passRate === undefined
        ? undefined
        : Math.min(100, Math.max(0, Math.round(Number(body.passRate))));

    return this.prisma.course.update({
      where: { id },
      data: {
        ...(body.title !== undefined && { title: body.title }),
        ...(body.code !== undefined && { code: body.code }),
        ...(body.program !== undefined && { program: body.program }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.creditHours !== undefined && { creditHours: body.creditHours }),
        ...(body.level !== undefined && { level: body.level }),
        ...(passRate !== undefined && Number.isFinite(passRate) && { passRate }),
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

  async remove(tenantId: number, id: number) {
    await this.findCourse(tenantId, id);
    return await this.prisma.extended.course.delete({
      where: { id },
    });
  }

  private async findCourse(tenantId: number, id: number) {
    const tid = requireTenantId(tenantId);
    const course = await this.prisma.course.findFirst({
      where: { id, tenantId: tid },
    });
    if (!course) {
      throw new NotFoundException(ErrorMessageKey.COURSE_NOT_FOUND);
    }
    return course;
  }
}
