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
import { ZodIssue } from 'zod';

@Global()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const statusCode =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    let message: string = ErrorMessageKey.INTERNAL_SERVER_ERROR;
    let messageKey: ErrorMessageKey | string | undefined =
      ErrorMessageKey.INTERNAL_SERVER_ERROR;
    let errors: FormattedValidationError[] | undefined;

    if (exception instanceof HttpException) {
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
        }
      }
    }

    console.log(exception);

    const errorBody: IErrorResponse = {
      statusCode,
      message,
      messageKey,
      errors,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    response.status(statusCode).json(errorBody);
  }
}
