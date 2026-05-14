import { ErrorMessageKey } from './error-message';

export interface IErrorResponse {
  statusCode: number;
  messageKey: ErrorMessageKey;
  timestamp: string;
  path: string;
}
