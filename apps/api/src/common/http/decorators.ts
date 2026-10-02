import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { RoleName } from '../rbac';
import { AuthedRequest, ClientInfo, clientInfo } from './types';

export const IS_PUBLIC = 'isPublic';
export const ROLE_KEY = 'minRole';

/** Marca un endpoint como público (por defecto TODO requiere autenticación: deny-by-default). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Exige al menos este rol (jerarquía VIEWER < ANALYST < ADMIN < OWNER). */
export const Roles = (minimum: RoleName) => SetMetadata(ROLE_KEY, minimum);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().user;
});

export const Client = createParamDecorator((_: unknown, ctx: ExecutionContext): ClientInfo => {
  return clientInfo(ctx.switchToHttp().getRequest());
});
