/**
 * Pruebas de extremo a extremo de API + PostgreSQL (sin mocks de base de datos): seguridad, aislamiento entre
 * organizaciones, webhook firmado, integración con credenciales y el caso de uso empresarial completo.
 */
jest.mock('@nestjs/schedule', () => ({
  Cron: () => () => undefined,
  ScheduleModule: { forRoot: () => ({ module: class ScheduleStub {} }) },
}));
process.env.HTTP_ACTION_ALLOWLIST = 'api.crm.example.com';
process.env.RUN_LEASE_SECONDS = '45';

import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/http/exception.filter';
import { PrismaService } from '../prisma/prisma.service';
import { HTTP_CLIENT } from './workflows.service';
import type { WorkflowGraph } from './graph';

const enabled = process.env.RUN_DB_TESTS === '1';
const d = enabled ? describe : describe.skip;
const PASSWORD = 'Safe-Test-Passphrase-2026!';
const TOKEN = 'crm-super-secret-token-1234567890';

d('API de workflows: seguridad y caso de uso extremo a extremo', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const outbound: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
  let crmStatus = 201;
  const crm = async (url: string, opts: { headers?: Record<string, string>; body?: string }) => {
    outbound.push({ url, headers: opts.headers ?? {}, body: opts.body });
    return {
      status: crmStatus,
      body: JSON.stringify({
        id: 'DEAL-77',
        echo: opts.headers?.Authorization ? 'auth-recibido' : 'sin-auth',
      }),
      truncated: false,
    };
  };
  const suffix = Date.now().toString(36);
  const A: { token: string; orgId: string } = { token: '', orgId: '' };
  const B: { token: string; orgId: string } = { token: '', orgId: '' };
  let viewerToken = '';
  const api = () => request(app.getHttpServer());
  const as = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function register(name: string) {
    const r = await api()
      .post('/api/auth/register')
      .send({
        orgName: `${name} ${suffix}`,
        name: `${name} Owner`,
        email: `${name.toLowerCase()}-${suffix}@example.com`,
        password: PASSWORD,
      })
      .expect(201);
    return { token: r.body.accessToken as string, orgId: r.body.user.orgId as string };
  }
  async function waitRun(token: string, id: string, until = ['SUCCEEDED', 'FAILED', 'CANCELLED']) {
    for (let i = 0; i < 100; i++) {
      const r = await api().get(`/api/runs/${id}`).set(as(token)).expect(200);
      if (until.includes(r.body.status)) return r.body;
      await new Promise((x) => setTimeout(x, 100));
    }
    throw new Error('La ejecución no terminó');
  }

  const dealFlow = (integrationId: string): WorkflowGraph => ({
    nodes: [
      { id: 'hook', type: 'trigger.webhook', data: {} },
      {
        id: 'big',
        type: 'data.operation',
        data: { operation: 'filter', source: 'trigger.orders', field: 'amount', op: 'gte', value: 1000 },
      },
      {
        id: 'total',
        type: 'data.operation',
        data: { operation: 'aggregate', source: 'steps.big.items', fn: 'sum', field: 'amount' },
      },
      { id: 'any', type: 'condition', data: { field: 'steps.big.count', op: 'gt', value: 0 } },
      {
        id: 'crm',
        type: 'action.http',
        data: {
          integrationId,
          url: 'https://api.crm.example.com/deals',
          method: 'POST',
          body: '{"title":"{{steps.big.count}} pedidos grandes","amount":"{{steps.total.value}}"}',
          retries: 1,
        },
      },
      {
        id: 'alert',
        type: 'action.notify',
        data: {
          severity: 'INFO',
          title: 'Deal {{steps.crm.json.id}}',
          message: 'Total {{steps.total.value}}',
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'hook', target: 'big' },
      { id: 'e2', source: 'big', target: 'total' },
      { id: 'e3', source: 'total', target: 'any' },
      { id: 'e4', source: 'any', target: 'crm', sourceHandle: 'true' },
      { id: 'e5', source: 'crm', target: 'alert' },
    ],
  });

  beforeAll(async () => {
    Logger.overrideLogger(false);
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(HTTP_CLIENT)
      .useValue(crm)
      .compile();
    app = mod.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    prisma = app.get(PrismaService);
    Object.assign(A, await register('Alfa'));
    Object.assign(B, await register('Beta'));
    const v = await api()
      .post('/api/users')
      .set(as(A.token))
      .send({
        name: 'Solo Lectura',
        email: `viewer-${suffix}@example.com`,
        password: PASSWORD,
        role: 'VIEWER',
      })
      .expect(201);
    viewerToken = (
      await api().post('/api/auth/login').send({ email: v.body.email, password: PASSWORD }).expect(200)
    ).body.accessToken;
  }, 60_000);
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: [A.orgId, B.orgId] } } });
    await app.close();
  });

  describe('permisos y aislamiento entre organizaciones', () => {
    let wfId: string;
    let runId: string;
    const simple: WorkflowGraph = {
      nodes: [
        { id: 't', type: 'trigger.manual', data: {} },
        { id: 'a', type: 'action.task', data: { title: 'Tarea de Alfa' } },
      ],
      edges: [{ id: 'e', source: 't', target: 'a' }],
    };
    beforeAll(async () => {
      wfId = (
        await api()
          .post('/api/workflows')
          .set(as(A.token))
          .send({ name: 'Privado de Alfa', graph: simple })
          .expect(201)
      ).body.id;
      runId = (await api().post(`/api/workflows/${wfId}/run`).set(as(A.token)).send({}).expect(201)).body
        .runId;
      await waitRun(A.token, runId);
    });

    it('rechaza peticiones anónimas y tokens manipulados', async () => {
      await api().get('/api/workflows').expect(401);
      await api().get('/api/workflows').set(as('x.y.z')).expect(401);
      await api().post(`/api/workflows/${wfId}/run`).send({}).expect(401);
    });

    it('otra organización no puede leer, modificar, ejecutar, activar, borrar ni cancelar', async () => {
      const h = as(B.token);
      await api().get(`/api/workflows/${wfId}`).set(h).expect(404);
      await api().put(`/api/workflows/${wfId}`).set(h).send({ name: 'hackeado', graph: simple }).expect(404);
      await api().post(`/api/workflows/${wfId}/run`).set(h).send({}).expect(404);
      await api().post(`/api/workflows/${wfId}/activate`).set(h).expect(404);
      await api().post(`/api/workflows/${wfId}/webhook-secret`).set(h).expect(404);
      await api().delete(`/api/workflows/${wfId}`).set(h).expect(404);
      await api().get(`/api/runs/${runId}`).set(h).expect(404);
      await api().post(`/api/runs/${runId}/cancel`).set(h).expect(404);
      expect((await api().get('/api/workflows').set(h).expect(200)).body).toEqual([]);
      expect((await api().get('/api/runs').set(h).expect(200)).body.total).toBe(0);
      expect((await api().get(`/api/runs?workflowId=${wfId}`).set(h).expect(200)).body.total).toBe(0);
      expect((await prisma.workflow.findUniqueOrThrow({ where: { id: wfId } })).name).toBe('Privado de Alfa');
    });

    it('un VIEWER lee pero no crea, modifica, ejecuta ni cancela', async () => {
      const h = as(viewerToken);
      await api().get(`/api/workflows/${wfId}`).set(h).expect(200);
      await api().get(`/api/runs/${runId}`).set(h).expect(200);
      await api().post('/api/workflows').set(h).send({ name: 'nuevo', graph: simple }).expect(403);
      await api().put(`/api/workflows/${wfId}`).set(h).send({ name: 'x', graph: simple }).expect(403);
      await api().post(`/api/workflows/${wfId}/run`).set(h).send({}).expect(403);
      await api().post(`/api/runs/${runId}/cancel`).set(h).expect(403);
      await api().delete(`/api/workflows/${wfId}`).set(h).expect(403);
      await api().post('/api/integrations').set(h).send({}).expect(403);
    });

    it('no se puede referenciar una integración de otra organización', async () => {
      const integ = (
        await api()
          .post('/api/integrations')
          .set(as(B.token))
          .send({
            name: 'CRM Beta',
            baseUrl: 'https://api.crm.example.com',
            headers: { Authorization: 'Bearer beta-secret-0000' },
          })
          .expect(201)
      ).body;
      const wf = (
        await api()
          .post('/api/workflows')
          .set(as(A.token))
          .send({ name: 'Robo', graph: dealFlow(integ.id) })
          .expect(201)
      ).body;
      outbound.length = 0;
      const { runId: id } = (
        await api()
          .post(`/api/workflows/${wf.id}/run`)
          .set(as(A.token))
          .send({ payload: { orders: [{ amount: 5000 }] } })
          .expect(201)
      ).body;
      const run = await waitRun(A.token, id);
      expect(run.status).toBe('FAILED');
      expect(run.steps.find((s: { nodeId: string }) => s.nodeId === 'crm').error).toMatch(
        /Integración inválida/,
      );
      expect(outbound).toHaveLength(0);
    });

    it('aplica el tope de ejecuciones activas por organización', async () => {
      const cap = await prisma.workflow.create({
        data: {
          orgId: B.orgId,
          name: 'cap',
          graph: simple as never,
          triggerType: 'trigger.manual',
          createdBy: 'x',
        },
      });
      await prisma.workflowRun.createMany({
        data: Array.from({ length: 200 }, () => ({
          workflowId: cap.id,
          orgId: B.orgId,
          triggerType: 'manual',
          status: 'RUNNING' as const,
          heartbeatAt: new Date(),
        })),
      });
      await api().post(`/api/workflows/${cap.id}/run`).set(as(B.token)).send({}).expect(400);
      await prisma.workflowRun.deleteMany({ where: { orgId: B.orgId, status: 'RUNNING' } });
    });

    it('rechaza payloads excesivos y grafos con código ejecutable', async () => {
      await api()
        .post(`/api/workflows/${wfId}/run`)
        .set(as(A.token))
        .send({ payload: { blob: 'x'.repeat(60_000) } })
        .expect(400);
      const evil = {
        nodes: [{ id: 'x', type: 'code.eval', data: { source: 'process.exit(1)' } }],
        edges: [],
      };
      await api().post('/api/workflows').set(as(A.token)).send({ name: 'evil', graph: evil }).expect(400);
    });
  });

  describe('caso de uso empresarial: pedidos grandes → CRM → alerta', () => {
    let integrationId: string;
    let wf: { id: string; webhookPath: string; webhookSecret: string };

    it('guarda credenciales cifradas y nunca las devuelve', async () => {
      const created = await api()
        .post('/api/integrations')
        .set(as(A.token))
        .send({
          name: 'CRM',
          baseUrl: 'https://api.crm.example.com',
          headers: { Authorization: `Bearer ${TOKEN}` },
        })
        .expect(201);
      integrationId = created.body.id;
      expect(JSON.stringify(created.body)).not.toContain(TOKEN);
      expect(
        JSON.stringify((await api().get('/api/integrations').set(as(A.token)).expect(200)).body),
      ).not.toContain(TOKEN);
      const row = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
      expect(row.headersEnc).not.toContain(TOKEN);
      expect(row.headersEnc.length).toBeGreaterThan(20);
    });

    it('prueba la conexión de una integración sin exponer la respuesta ni las credenciales', async () => {
      const r = await api()
        .post(`/api/integrations/${integrationId}/test`)
        .set(as(A.token))
        .send({ path: '/' })
        .expect(200);
      expect(r.body).toMatchObject({ ok: true, status: 201 });
      expect(JSON.stringify(r.body)).not.toContain(TOKEN);
      await api().post(`/api/integrations/${integrationId}/test`).set(as(B.token)).send({}).expect(404);
      await api().post(`/api/integrations/${integrationId}/test`).set(as(viewerToken)).send({}).expect(403);
    });

    it('un workflow no puede llevar credenciales dentro del grafo', async () => {
      const g = dealFlow(integrationId);
      (g.nodes[4].data as Record<string, unknown>).headers = { Authorization: 'Bearer pegado-a-mano' };
      await api().post('/api/workflows').set(as(A.token)).send({ name: 'x', graph: g }).expect(400);
    });

    it('valida el grafo antes de guardar (campos inexistentes)', async () => {
      const g = dealFlow(integrationId);
      (g.nodes[5].data as Record<string, unknown>).title = '{{steps.crm.noExiste}}';
      const r = await api()
        .post('/api/workflows')
        .set(as(A.token))
        .send({ name: 'xx', graph: g })
        .expect(400);
      expect(JSON.stringify(r.body)).toMatch(/no produce el campo/);
    });

    it('crea y activa el workflow', async () => {
      wf = (
        await api()
          .post('/api/workflows')
          .set(as(A.token))
          .send({ name: 'Pedidos grandes → CRM', graph: dealFlow(integrationId) })
          .expect(201)
      ).body;
      expect(wf.webhookSecret).toBeTruthy();
      await api().post(`/api/workflows/${wf.id}/activate`).set(as(A.token)).expect(200);
    });

    const signedPost = (body: unknown, secret = wf.webhookSecret, ts = Math.floor(Date.now() / 1000)) => {
      const raw = JSON.stringify(body);
      const sig = `sha256=${createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`;
      return api()
        .post(wf.webhookPath)
        .set({
          'content-type': 'application/json',
          'x-nexus-timestamp': String(ts),
          'x-nexus-signature': sig,
        })
        .send(raw);
    };

    it('rechaza webhooks sin firma, con firma ajena o repetidos', async () => {
      await api().post(wf.webhookPath).send({ orders: [] }).expect(401);
      await signedPost({ orders: [] }, 'otro-secreto-otro-secreto-otro-secreto').expect(401);
      const ts = Math.floor(Date.now() / 1000);
      await signedPost({ orders: [{ amount: 1 }], n: 1 }, wf.webhookSecret, ts).expect(202);
      await signedPost({ orders: [{ amount: 1 }], n: 1 }, wf.webhookSecret, ts).expect(401);
    });

    it('webhook → datos → CRM con credenciales → alerta; el historial muestra nodos, tiempos y traza', async () => {
      outbound.length = 0;
      const res = await signedPost({
        orders: [
          { id: 1, amount: 500 },
          { id: 2, amount: 1500 },
          { id: 3, amount: 2500, token: 'no-debe-persistirse' },
        ],
      }).expect(202);
      const run = await waitRun(A.token, res.body.runId);
      expect(run.status).toBe('SUCCEEDED');

      // Servicio externo recibió credenciales e idempotency key, y datos calculados por el workflow.
      expect(outbound).toHaveLength(1);
      expect(outbound[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(outbound[0].headers['Idempotency-Key']).toBe(`${run.id}:crm`);
      expect(JSON.parse(outbound[0].body as string)).toEqual({ title: '2 pedidos grandes', amount: '4000' });

      // Historial: nodos ejecutados con estado, tiempos y salidas.
      expect(run.steps.map((s: { nodeId: string }) => s.nodeId).sort()).toEqual([
        'alert',
        'any',
        'big',
        'crm',
        'hook',
        'total',
      ]);
      for (const s of run.steps) {
        expect(s.status).toBe('SUCCEEDED');
        expect(typeof s.durationMs).toBe('number');
        expect(s.startedAt && s.finishedAt).toBeTruthy();
      }
      const alert = await prisma.alert.findFirstOrThrow({
        where: { orgId: A.orgId, idempotencyKey: `${run.id}:alert` },
      });
      expect(alert.title).toBe('Deal DEAL-77');
      expect(run.events.map((e: { type: string }) => e.type)).toEqual(
        expect.arrayContaining([
          'run.queued',
          'run.started',
          'step.started',
          'step.succeeded',
          'run.succeeded',
        ]),
      );

      // Credenciales y datos sensibles fuera de pasos, eventos, auditoría y respuesta.
      const everything =
        JSON.stringify(run) + JSON.stringify(await prisma.auditLog.findMany({ where: { orgId: A.orgId } }));
      expect(everything).not.toContain(TOKEN);
      expect(everything).not.toContain('no-debe-persistirse');
      const listed = await api().get('/api/runs?pageSize=100').set(as(A.token)).expect(200);
      expect(listed.body.items.find((r: { id: string }) => r.id === run.id)).toMatchObject({
        status: 'SUCCEEDED',
        workflow: { name: 'Pedidos grandes → CRM' },
      });
    });

    it('sin pedidos grandes la rama falsa no llama al CRM', async () => {
      outbound.length = 0;
      const run = await waitRun(
        A.token,
        (await signedPost({ orders: [{ amount: 10 }] }).expect(202)).body.runId,
      );
      expect(run.status).toBe('SUCCEEDED');
      expect(outbound).toHaveLength(0);
      expect(run.steps.find((s: { nodeId: string }) => s.nodeId === 'crm')).toBeUndefined();
    });

    it('si el CRM rechaza (4xx) falla sin reintentos y explica el motivo sin filtrar el token', async () => {
      crmStatus = 401;
      outbound.length = 0;
      const run = await waitRun(
        A.token,
        (await signedPost({ orders: [{ amount: 9000 }] }).expect(202)).body.runId,
      );
      crmStatus = 201;
      expect(run.status).toBe('FAILED');
      expect(outbound).toHaveLength(1);
      const crmStep = run.steps.find((s: { nodeId: string }) => s.nodeId === 'crm');
      expect(crmStep).toMatchObject({ status: 'FAILED', attempts: 1 });
      expect(crmStep.error).toMatch(/HTTP 401/);
      expect(JSON.stringify(run)).not.toContain(TOKEN);
      expect(run.steps.find((s: { nodeId: string }) => s.nodeId === 'alert')).toBeUndefined();
    });
  });

  describe('abuso', () => {
    it('limita las ejecuciones manuales por minuto (protección contra abuso)', async () => {
      const wfId = (
        await api()
          .post('/api/workflows')
          .set(as(A.token))
          .send({
            name: 'Abuso',
            graph: { nodes: [{ id: 't', type: 'trigger.manual', data: {} }], edges: [] },
          })
          .expect(201)
      ).body.id;
      const codes: number[] = [];
      for (let i = 0; i < 35; i++)
        codes.push(
          (
            await api()
              .post(`/api/workflows/${wfId}/run`)
              .set(as(A.token))
              .send({})
              .catch((e) => e)
          ).status,
        );
      expect(codes).toContain(429);
    }, 60_000);
  });
});
