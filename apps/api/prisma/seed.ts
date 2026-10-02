import { PrismaClient } from '@prisma/client';
import { checkPasswordPolicy, hashPassword } from '../src/common/security/password';
import { getEnv } from '../src/common/config/env';
import { simulateOrders } from '../src/operations/metrics';

async function main() {
  const env = getEnv();
  if (env.NODE_ENV === 'production')
    throw new Error('El seed de demostración está deshabilitado en producción');
  const email = process.env.SEED_EMAIL?.toLowerCase(),
    password = process.env.SEED_PASSWORD;
  if (!email || !password || !checkPasswordPolicy(password, { email }).ok)
    throw new Error(
      'Define SEED_EMAIL y SEED_PASSWORD (política de 12 caracteres/3 tipos). No existen credenciales predeterminadas.',
    );
  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new Error('El usuario ya existe. Seed cancelado para conservar sus datos.');
    const org = await prisma.organization.create({
      data: {
        name: 'NexusFlow Demo',
        currency: 'USD',
        users: {
          create: { name: 'Demo Owner', email, passwordHash: await hashPassword(password), role: 'OWNER' },
        },
      },
      include: { users: true },
    });
    const now = Date.now();
    for (let i = 0; i < 200; i++) {
      const customer = await prisma.customer.create({
        data: {
          orgId: org.id,
          externalId: `DEMO-C${i}`,
          name: `Cliente Demo ${i + 1}`,
          email: `cliente${i}@example.com`,
        },
      });
      const days = i < 100 ? [240, 210, 180 + (i % 30)] : [240, 135, 95 + (i % 5), 10 + (i % 20)];
      await prisma.transaction.createMany({
        data: days.map((d, j) => ({
          orgId: org.id,
          customerId: customer.id,
          externalId: `DEMO-T${i}-${j}`,
          amount: 50 + ((i * 7 + j * 13) % 500),
          currency: 'USD',
          occurredAt: new Date(now - d * 86400000),
        })),
      });
    }
    await prisma.order.createMany({
      data: simulateOrders(100, new Date(), 42, 'SIM-DEMO').map((order) => ({ ...order, orgId: org.id })),
    });
    console.log(
      'Organización demo creada: 200 clientes, 700 transacciones, 100 pedidos simulados. Accede con las credenciales que definiste.',
    );
  } finally {
    await prisma.$disconnect();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Seed falló');
  process.exitCode = 1;
});
