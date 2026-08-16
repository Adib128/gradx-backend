import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { Request, Response } from 'express';

export interface ISuccessResponse<T> {
  success: boolean;
  statusCode: number;
  data: T;
  meta?: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
  timestamp: string;
  path: string;
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  ISuccessResponse<T> | undefined
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ISuccessResponse<T> | undefined> {
    const response = context.switchToHttp().getResponse<Response>();
    const request = context.switchToHttp().getRequest<Request>();

    return next.handle().pipe(
      mergeMap((payload) => {
        // Raw streams (SSE / @Res) already wrote the body — do not wrap.
        // Return a completed value (not EMPTY) so Nest's lastValueFrom does not throw.
        if (
          response.headersSent ||
          response.writableEnded ||
          String(response.getHeader('Content-Type') ?? '').includes(
            'text/event-stream',
          )
        ) {
          return of(undefined);
        }

        return of({
          success: true,
          statusCode: response.statusCode,
          data: payload?.data ?? payload,
          ...(payload?.meta && { meta: payload.meta }),
          timestamp: new Date().toISOString(),
          path: request.url,
        });
      }),
    );
  }
}
