import { Controller, Get, Module, ServiceUnavailableException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule, PrismaService } from './prisma/prisma.service';
import { AuditModule } from './audit/audit.service';
import { AuthModule } from './auth/auth.controller';
import { UsersModule } from './users/users.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ImportsModule } from './imports/imports.module';
import { OperationsModule } from './operations/operations.module';
import { WorkflowsModule } from './workflows/workflows.controller';
import { TriggersModule } from './triggers/triggers.module';
import { JwtAuthGuard, RolesGuard } from './common/http/guards';
import { Public } from './common/http/decorators';
import { InboxModule } from './inbox/inbox.module';
import { SecurityModule } from './security/security.module';
import { PredictiveModule } from './predictive/predictive.module';
import { IntegrationsModule } from './integrations/integrations.module';

@Controller('health')
class HealthController {
  constructor(private readonly prisma: PrismaService) {}
  @Public() @Get() live() {
    return { status: 'ok', service: 'nexusflow-api' };
  }
  @Public() @Get('ready') async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException();
    }
  }
}

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 150 }]),
    PrismaModule,
    AuditModule,
    TriggersModule,
    AuthModule,
    UsersModule,
    AnalyticsModule,
    ImportsModule,
    OperationsModule,
    WorkflowsModule,
    InboxModule,
    SecurityModule,
    PredictiveModule,
    IntegrationsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
