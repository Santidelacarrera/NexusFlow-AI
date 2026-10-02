import { Global, Injectable, Module } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { getEnv } from '../common/config/env';
import type { ClientInfo } from '../common/http/types';
import { PrismaService } from '../prisma/prisma.service';
import { ChainVerifier, computeAuditHash, GENESIS_HASH, type ChainVerification } from './audit-chain';

export interface AuditInput {
  orgId: string;
  userId?: string | null;
  action: string;
  resource?: string;
  resourceId?: string;
  client?: Partial<ClientInfo>;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Escribe una entrada encadenada. El lock asesor por organización serializa la cadena y evita bifurcaciones. */
  async record(input: AuditInput): Promise<void> {
    const key = getEnv().AUDIT_HMAC_KEY;
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.orgId}))`;
        const last = await tx.auditLog.findFirst({
          where: { orgId: input.orgId },
          orderBy: { seq: 'desc' },
          select: { seq: true, hash: true },
        });
        const core = {
          orgId: input.orgId,
          seq: (last?.seq ?? 0) + 1,
          userId: input.userId ?? null,
          action: input.action,
          resource: input.resource ?? null,
          resourceId: input.resourceId ?? null,
          ip: input.client?.ip ?? null,
          metadata: input.metadata ?? null,
          createdAt: new Date(),
          prevHash: last?.hash ?? GENESIS_HASH,
        };
        await tx.auditLog.create({
          data: {
            ...core,
            userAgent: input.client?.userAgent ?? null,
            metadata: (core.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
            hash: computeAuditHash(key, core),
          },
        });
      },
      { timeout: 10_000 },
    );
  }

  async list(orgId: string, page: number, pageSize: number, action?: string) {
    const where: Prisma.AuditLogWhereInput = { orgId, ...(action ? { action: { startsWith: action } } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { seq: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          seq: true,
          userId: true,
          action: true,
          resource: true,
          resourceId: true,
          ip: true,
          metadata: true,
          createdAt: true,
          hash: true,
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  /** Recorre toda la cadena de la organización por lotes y comprueba hashes, secuencia y enlaces. */
  async verify(orgId: string): Promise<ChainVerification> {
    const verifier = new ChainVerifier(getEnv().AUDIT_HMAC_KEY);
    let cursor = 0;
    for (;;) {
      const batch = await this.prisma.auditLog.findMany({
        where: { orgId, seq: { gt: cursor } },
        orderBy: { seq: 'asc' },
        take: 1000,
      });
      if (batch.length === 0) return verifier.result();
      for (const entry of batch) {
        const err = verifier.push(entry);
        if (err) return err;
      }
      cursor = batch[batch.length - 1].seq;
    }
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
