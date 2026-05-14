import {
  ArgumentsHost,
  ExceptionFilter,
  Global,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ErrorMessageKey } from '../constants/error-message';
import { IErrorResponse } from '../constants/error-response';
import { Request, Response } from 'express';

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

    const messageKey =
      exception instanceof HttpException
        ? exception.getResponse()
        : ErrorMessageKey.INTERNAL_SERVER_ERROR;

    console.log(exception);

    const errorBody: IErrorResponse = {
      statusCode,
      messageKey: messageKey as ErrorMessageKey,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    response.status(statusCode).json(errorBody);
  }
}
