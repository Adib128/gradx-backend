import { ErrorMessageKey } from './error-message';
import { FormattedValidationError } from '../helpers/format-zod-errors.helper';

export interface IErrorResponse {
  statusCode: number;
  message: string;
  messageKey?: ErrorMessageKey | string;
  errors?: FormattedValidationError[];
  timestamp: string;
  path: string;
}
