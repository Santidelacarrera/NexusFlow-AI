import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
const base = process.env.SMOKE_URL ?? 'http://localhost:8088';
const suffix = randomBytes(5).toString('hex');
const password = randomBytes(20).toString('base64url') + '-A9!';
let checks = 0;
async function request(
  path,
  body,
  token,
  expected = 200,
  method = body === undefined ? 'GET' : 'POST',
  cookie,
) {
  const headers = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
  };
  const response = await fetch(`${base}/api/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const result = response.status === 204 ? null : await response.json();
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(result)}`);
  checks++;
  return { result, response };
}
async function main() {
  await request('health/ready');
  await request('customers', undefined, undefined, 401);
  const { result: owner, response: ownerResponse } = await request(
    'auth/register',
    {
      orgName: `Smoke ${suffix}`,
      name: 'Smoke Owner',
      email: `owner-${suffix}@example.com`,
      password,
      currency: 'USD',
    },
    undefined,
    201,
  );
  const cookie = ownerResponse.headers.get('set-cookie').split(';')[0];
  const token = owner.accessToken;
  const { result: other } = await request(
    'auth/register',
    { orgName: `Other ${suffix}`, name: 'Other Owner', email: `other-${suffix}@example.com`, password },
    undefined,
    201,
  );
  const { result: viewer } = await request(
    'users',
    { name: 'Solo Lectura', email: `viewer-${suffix}@example.com`, password, role: 'VIEWER' },
    token,
    201,
  );
  const { result: viewerSession } = await request(
    'auth/login',
    { email: viewer.email, password },
    undefined,
    200,
  );
  await request('operations/simulate', { count: 10 }, viewerSession.accessToken, 403);
  await request('users', undefined, viewerSession.accessToken, 403);
  await request('users/' + viewer.id, { role: 'OWNER' }, other.accessToken, 404, 'PATCH');
  await request('users/' + owner.user.id, { isActive: false }, token, 400, 'PATCH');
  const upload = (currency = 'USD') => {
    const data = new FormData();
    data.append(
      'file',
      new Blob(
        [
          `customer_id,customer_name,transaction_id,amount,currency,date\nc1,Ana,t1,100,${currency},2026-01-01\nc2,Luis,t2,200,${currency},2026-02-01\nc1,Ana,t3,50,${currency},2026-03-01`,
        ],
        { type: 'text/csv' },
      ),
      'sales.csv',
    );
    return data;
  };
  const { result: dry } = await request('imports/transactions?dryRun=true', upload(), token, 201);
  assert.equal(dry.validRows, 3);
  const { result: imported } = await request('imports/transactions', upload(), token, 201);
  assert.equal(imported.importedRows, 3);
  const { result: repeated } = await request('imports/transactions', upload(), token, 201);
  assert.equal(repeated.skippedExisting, 3);
  const { result: wrongCurrency } = await request(
    'imports/transactions?dryRun=true',
    upload('EUR'),
    token,
    201,
  );
  assert.ok(wrongCurrency.fatal);
  const { result: overview } = await request('analytics/overview', undefined, token);
  assert.equal(overview.revenue, 350);
  assert.equal(overview.customers, 2);
  const { result: otherOverview } = await request('analytics/overview', undefined, other.accessToken);
  assert.equal(otherOverview.revenue, 0);
  const { result: rfm } = await request('analytics/rfm', undefined, token);
  assert.equal(rfm.total, 2);
  const graph = {
    nodes: [
      { id: 'start', type: 'trigger.manual', data: {} },
      {
        id: 'notify',
        type: 'action.notify',
        data: { severity: 'INFO', title: 'Smoke alert', message: 'Cliente {{trigger.customerId}}' },
      },
    ],
    edges: [{ id: 'e1', source: 'start', target: 'notify' }],
  };
  const { result: workflow } = await request('workflows', { name: 'Smoke automation', graph }, token, 201);
  await request(`workflows/${workflow.id}`, undefined, other.accessToken, 404);
  await request(
    'workflows',
    {
      name: 'Invalid',
      graph: { ...graph, edges: [...graph.edges, { id: 'e2', source: 'notify', target: 'start' }] },
    },
    token,
    400,
  );
  const { result: run } = await request(
    `workflows/${workflow.id}/run`,
    { payload: { customerId: 'c1' } },
    token,
    201,
  );
  let runResult;
  for (let i = 0; i < 30; i++) {
    ({ result: runResult } = await request(`runs/${run.runId}`, undefined, token));
    if (['SUCCEEDED', 'FAILED'].includes(runResult.status)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(runResult.status, 'SUCCEEDED');
  assert.equal(runResult.steps.length, 2);
  const { result: alerts } = await request('alerts', undefined, token);
  assert.equal(alerts.items[0].message, 'Cliente c1');
  await request(
    `alerts/${alerts.items[0].id}`,
    { status: 'RESOLVED' },
    viewerSession.accessToken,
    403,
    'PATCH',
  );
  await request(`alerts/${alerts.items[0].id}`, { status: 'RESOLVED' }, token, 200, 'PATCH');
  await request('reports/generate', {}, token, 201);
  await request('operations/simulate', { count: 100 }, token, 201);
  const { result: detected } = await request('operations/detect', {}, token, 201);
  assert.equal(detected.newAlerts, 0);
  await request('predictive/score', {}, token, 201);
  const { result: predictions } = await request('predictive', undefined, token);
  assert.equal(predictions.total, 2);
  assert.equal(predictions.model.metrics.mode, 'heuristic');
  await request('predictive/train', {}, token, 400);
  const { result: campaign } = await request(
    'security/campaigns',
    { name: 'Campaña educativa', authorizationRef: 'SMOKE-AUTHORIZED', userIds: [viewer.id] },
    token,
    201,
  );
  const trainingToken = campaign.links[0].path.split('#')[1];
  await request('security/training/event', { token: trainingToken, event: 'clicked' }, undefined, 201);
  await request('security/training/event', { token: trainingToken, event: 'reported' }, undefined, 201);
  const { result: campaigns } = await request('security/campaigns', undefined, token);
  assert.equal(campaigns[0].clicks, 1);
  assert.equal(campaigns[0].reports, 1);
  assert.equal(campaigns[0].links, undefined);
  await request(`security/campaigns/${campaign.id}/close`, {}, token, 201);
  await request('security/training/event', { token: trainingToken, event: 'clicked' }, undefined, 404);
  const hookGraph = { ...graph, nodes: [{ ...graph.nodes[0], type: 'trigger.webhook' }, graph.nodes[1]] };
  const { result: hook } = await request(
    'workflows',
    { name: 'Signed webhook', graph: hookGraph },
    token,
    201,
  );
  await request(`workflows/${hook.id}/activate`, {}, token);
  const ts = Math.floor(Date.now() / 1000),
    payload = JSON.stringify({ event: 'test' });
  const signature =
    'sha256=' + createHmac('sha256', hook.webhookSecret).update(`${ts}.${payload}`).digest('hex');
  const hookRequest = () =>
    fetch(`${base}${hook.webhookPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Nexus-Timestamp': String(ts),
        'X-Nexus-Signature': signature,
      },
      body: payload,
    });
  assert.equal((await hookRequest()).status, 202);
  checks++;
  assert.equal((await hookRequest()).status, 401);
  checks++;
  const csrf = await fetch(`${base}/api/auth/refresh`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: 'https://untrusted.example' },
  });
  assert.equal(csrf.status, 403);
  checks++;
  const { result: chain } = await request('security/audit/verify', {}, token, 201);
  assert.equal(chain.valid, true);
  await request('users/' + viewer.id + '/revoke-sessions', {}, token, 204);
  await request('customers', undefined, viewerSession.accessToken, 401);
  await request('auth/logout', {}, undefined, 204, 'POST', cookie);
  await request('customers', undefined, token, 401);
  console.log(
    `Smoke completo: ${checks} comprobaciones HTTP, aislamiento, RBAC, CSV, workflows, HMAC, IA, operaciones y revocación. Organizaciones de prueba: Smoke ${suffix} y Other ${suffix}.`,
  );
}
await main();
