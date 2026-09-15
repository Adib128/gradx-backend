import {
  ArgumentsHost,
  ExceptionFilter,
  Global,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ErrorMessageKey } from '../constants/error-message';
import { IErrorResponse } from '../constants/error-response';
import {
  formatZodIssues,
  FormattedValidationError,
} from '../helpers/format-zod-errors.helper';
import { Request, Response } from 'express';
import { ZodError, ZodIssue } from 'zod';
import { Prisma } from 'generated/prisma/client';
import { isRetryableDbError } from '../helpers/db-retry.helper';

@Global()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let statusCode =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    let message: string = ErrorMessageKey.INTERNAL_SERVER_ERROR;
    let messageKey: ErrorMessageKey | string | undefined =
      ErrorMessageKey.INTERNAL_SERVER_ERROR;
    let detail: string | undefined;
    let errors: FormattedValidationError[] | undefined;

    if (isPayloadTooLargeError(exception)) {
      statusCode = HttpStatus.PAYLOAD_TOO_LARGE;
      message = ErrorMessageKey.REQUEST_PAYLOAD_TOO_LARGE;
      messageKey = ErrorMessageKey.REQUEST_PAYLOAD_TOO_LARGE;
    } else if (exception instanceof ZodError) {
      statusCode = HttpStatus.BAD_REQUEST;
      message = 'Validation failed';
      messageKey = ErrorMessageKey.VALIDATION_FAILED;
      errors = formatZodIssues(exception.issues);
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      statusCode = HttpStatus.BAD_REQUEST;
      message = ErrorMessageKey.VALIDATION_FAILED;
      messageKey = ErrorMessageKey.VALIDATION_FAILED;
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = mapPrismaKnownError(exception);
      statusCode = mapped.statusCode;
      message = mapped.message;
      messageKey = mapped.messageKey;
    } else if (isRetryableDbError(exception)) {
      statusCode = HttpStatus.SERVICE_UNAVAILABLE;
      message = ErrorMessageKey.DATABASE_UNAVAILABLE;
      messageKey = ErrorMessageKey.DATABASE_UNAVAILABLE;
    } else if (exception instanceof HttpException) {
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
        messageKey = exceptionResponse;
      } else if (
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null
      ) {
        const body = exceptionResponse as Record<string, unknown>;

        if (Array.isArray(body.errors)) {
          message =
            typeof body.message === 'string'
              ? body.message
              : 'Validation failed';
          messageKey = ErrorMessageKey.VALIDATION_FAILED;
          errors = formatZodIssues(body.errors as ZodIssue[]);
        } else {
          const rawMessage = body.message;

          if (typeof rawMessage === 'string') {
            message = rawMessage;
            messageKey = Object.values(ErrorMessageKey).includes(
              rawMessage as ErrorMessageKey,
            )
              ? (rawMessage as ErrorMessageKey)
              : rawMessage;
          } else if (Array.isArray(rawMessage)) {
            message = rawMessage.map(String).join(', ');
            messageKey = message;
          } else if (typeof body.error === 'string') {
            message = body.error;
            messageKey = body.error;
          }

          if (typeof body.detail === 'string' && body.detail.trim()) {
            detail = body.detail.trim();
          }
        }
      }
    }

    console.log(exception);

    if (response.headersSent || response.writableEnded) {
      return;
    }

    const errorBody: IErrorResponse = {
      statusCode,
      message,
      messageKey,
      ...(detail && { detail }),
      errors,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    response.status(statusCode).json(errorBody);
  }
}

function mapPrismaKnownError(error: Prisma.PrismaClientKnownRequestError): {
  statusCode: number;
  message: string;
  messageKey: string;
} {
  if (isRetryableDbError(error)) {
    return {
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      message: ErrorMessageKey.DATABASE_UNAVAILABLE,
      messageKey: ErrorMessageKey.DATABASE_UNAVAILABLE,
    };
  }

  switch (error.code) {
    case 'P2002':
      return {
        statusCode: HttpStatus.CONFLICT,
        message: ErrorMessageKey.TOPIC_EXIST,
        messageKey: ErrorMessageKey.TOPIC_EXIST,
      };
    case 'P2003':
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        message: ErrorMessageKey.VALIDATION_FAILED,
        messageKey: ErrorMessageKey.VALIDATION_FAILED,
      };
    case 'P2025':
      return {
        statusCode: HttpStatus.NOT_FOUND,
        message: ErrorMessageKey.COURSE_NOT_FOUND,
        messageKey: ErrorMessageKey.COURSE_NOT_FOUND,
      };
    case 'P2028':
      return {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        message: ErrorMessageKey.DATABASE_UNAVAILABLE,
        messageKey: ErrorMessageKey.DATABASE_UNAVAILABLE,
      };
    default:
      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: ErrorMessageKey.INTERNAL_SERVER_ERROR,
        messageKey: ErrorMessageKey.INTERNAL_SERVER_ERROR,
      };
  }
}

function isPayloadTooLargeError(exception: unknown): boolean {
  if (!exception || typeof exception !== 'object') return false;
  const typed = exception as { type?: unknown; status?: unknown; statusCode?: unknown };
  return (
    typed.type === 'entity.too.large' ||
    typed.status === 413 ||
    typed.statusCode === 413
  );
}
