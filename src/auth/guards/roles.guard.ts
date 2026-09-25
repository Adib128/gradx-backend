import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from 'generated/prisma/browser';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { ErrorMessageKey } from 'src/common/constants/error-message';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredRoles?.length) return true;

    const request = context.switchToHttp().getRequest();
    const role = request.user?.role as UserRole | undefined;
    if (!role || !requiredRoles.includes(role)) {
      throw new ForbiddenException(ErrorMessageKey.FORBIDDEN || 'FORBIDDEN');
    }
    return true;
  }
}
