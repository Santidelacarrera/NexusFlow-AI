import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
const base = process.env.SMOKE_URL ?? 'http://localhost:8088';
const suffix = randomBytes(5).toString('hex');
async function call(path, body, token, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${base}/api/${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const result = await response.json();
  assert.ok(response.ok, `${path}: ${JSON.stringify(result)}`);
  return result;
}
const session = await call('auth/register', {
  orgName: `ML Smoke ${suffix}`,
  name: 'ML Tester',
  email: `ml-${suffix}@example.com`,
  password: randomBytes(24).toString('base64url') + '-A9!',
});
const token = session.accessToken;
const lines = ['customer_id,customer_name,transaction_id,amount,currency,date'];
for (let i = 0; i < 200; i++) {
  const days = i < 100 ? [240, 210, 180 + (i % 30)] : [240, 135, 95 + (i % 5), 10 + (i % 20)];
  days.forEach((d, j) =>
    lines.push(
      `c${i},Cliente ${i},t${i}-${j},${50 + i},USD,${new Date(Date.now() - d * 86400000).toISOString()}`,
    ),
  );
}
const form = new FormData();
form.append('file', new Blob([lines.join('\n')], { type: 'text/csv' }), 'training.csv');
assert.equal((await call('imports/transactions', form, token)).importedRows, 700);
const training = await call('predictive/train', {}, token);
assert.equal(training.promoted, true);
assert.ok(training.metrics.prAuc > training.metrics.baseline.prAuc);
await call('predictive/policy', { enabled: true, threshold: 0.7, action: 'TASK' }, token, 'PUT');
await call(
  'workflows',
  {
    name: 'Retención automática',
    graph: {
      nodes: [
        { id: 'churn', type: 'trigger.churn', data: { minProbability: 0.7 } },
        {
          id: 'alert',
          type: 'action.notify',
          data: { severity: 'WARNING', title: 'Cliente con riesgo', message: '{{trigger.customerId}}' },
        },
      ],
      edges: [{ id: 'e', source: 'churn', target: 'alert' }],
    },
  },
  token,
).then((w) => call(`workflows/${w.id}/activate`, {}, token));
const score = await call('predictive/score', {}, token);
assert.ok(score.actions > 0);
assert.equal(score.workflowsFired, score.actions);
const predictions = await call('predictive', undefined, token);
assert.equal(predictions.total, 200);
assert.equal(predictions.model.metrics.mode, 'trained');
assert.equal(predictions.items[0].explanation.method, 'SHAP');
const repeat = await call('predictive/score', {}, token);
assert.equal(repeat.actions, 0);
assert.equal((await call('predictive', undefined, token)).total, 200);
assert.equal((await call('security/audit/verify', {}, token)).valid, true);
console.log(
  `IA integrada verificada: 700 transacciones, 200 predicciones SHAP, ${score.actions} acciones y workflows; evaluación repetida sin duplicar tareas. Datos sintéticos. Organización ML Smoke ${suffix}.`,
);
