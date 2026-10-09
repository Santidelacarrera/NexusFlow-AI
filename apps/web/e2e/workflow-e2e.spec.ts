import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';

/**
 * Caso de uso: pedidos de alto valor. Editor (plantilla) → API → PostgreSQL → webhook firmado →
 * motor → historial en la interfaz con estado, tiempos, motivos de fallo y traza.
 */
test('editor → backend → base de datos → historial con nodos, errores y tiempos', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Crear una organización', exact: true }).click();
  await page.getByLabel('Organización', { exact: true }).fill('E2E Pedidos');
  await page.getByLabel('Tu nombre', { exact: true }).fill('Ana Operaciones');
  await page.getByLabel('Correo electrónico').fill(`e2e-${Date.now()}@example.com`);
  await page.getByLabel('Contraseña', { exact: true }).fill('Safe-Test-Passphrase-2026!');
  await page.getByRole('button', { name: 'Crear organización', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Hola, Ana' })).toBeVisible();

  // 1. Editor: plantilla, nombre y guardado (validación tipada en el backend).
  await page.getByRole('link', { name: 'Flow Engine', exact: true }).click();
  await page.getByRole('link', { name: 'Nuevo workflow', exact: true }).click();
  await page.getByLabel('Plantilla').selectOption({ label: 'Pedidos de alto valor (webhook → datos → alerta)' });
  await page.getByLabel('Nombre', { exact: true }).fill('Pedidos de alto valor E2E');
  await page.getByRole('button', { name: 'Guardar workflow', exact: true }).click();
  const secretModal = page.getByRole('dialog');
  await expect(secretModal).toContainText('webhookSecret');
  const { webhookPath, webhookSecret } = JSON.parse((await secretModal.locator('pre').innerText()) ?? '{}');
  expect(webhookPath).toMatch(/^\/api\/hooks\//);
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Volver', exact: true }).click();
  await page.getByRole('button', { name: 'Activar', exact: true }).click();
  await expect(page.getByText('ACTIVE', { exact: true })).toBeVisible();

  // 2. Webhook firmado: dos pedidos grandes y uno pequeño.
  const send = async (body: unknown) => {
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const signature = `sha256=${createHmac('sha256', webhookSecret).update(`${ts}.${raw}`).digest('hex')}`;
    return request.post(webhookPath, {
      data: raw,
      headers: { 'content-type': 'application/json', 'x-nexus-timestamp': String(ts), 'x-nexus-signature': signature },
    });
  };
  expect((await request.post(webhookPath, { data: { orders: [] } })).status()).toBe(401);
  const ok = await send({
    orders: [
      { id: 1, amount: 400 },
      { id: 2, amount: 1500 },
      { id: 3, amount: 2500 },
    ],
  });
  expect(ok.status()).toBe(202);
  // 3. Entrada inválida en tiempo de ejecución: el motivo debe quedar visible.
  expect((await send({ orders: 'no-es-una-lista' })).status()).toBe(202);

  // 4. Historial.
  await page.getByRole('link', { name: 'Ejecuciones', exact: true }).click();
  await expect(page.getByText('SUCCEEDED', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.getByText('FAILED', { exact: true })).toBeVisible({ timeout: 20000 });

  await page.getByRole('row', { name: /SUCCEEDED/ }).getByRole('button', { name: 'Ver pasos' }).click();
  const nodes = page.getByRole('table', { name: 'Nodos de la ejecución' });
  for (const id of ['hook', 'big', 'total', 'any', 'alert'])
    await expect(nodes.locator(`tr[data-node="${id}"]`)).toContainText('SUCCEEDED');
  await expect(nodes.locator('tr[data-node="total"]')).toContainText('4000');
  await expect(nodes.locator('tr[data-node="alert"]')).toContainText('ms');
  const trace = page.getByRole('list', { name: 'Traza de la ejecución' });
  await expect(trace).toContainText('run.queued');
  await expect(trace).toContainText('step.succeeded');
  await expect(trace).toContainText('run.succeeded');
  await page.keyboard.press('Escape');

  await page.getByRole('row', { name: /FAILED/ }).getByRole('button', { name: 'Ver pasos' }).click();
  const failed = page.getByRole('table', { name: 'Nodos de la ejecución' });
  await expect(failed.locator('tr[data-node="big"]')).toContainText('FAILED');
  await expect(failed.locator('tr[data-node="big"]')).toContainText('no es una lista');
  await expect(failed.locator('tr[data-node="total"]')).toContainText('No ejecutado');
  await page.keyboard.press('Escape');

  // 5. Filtro por estado y efecto final persistido: la alerta creada por el workflow.
  await page.getByLabel('Estado').selectOption('FAILED');
  await expect(page.getByText('SUCCEEDED', { exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Alertas y tareas', exact: true }).click();
  await expect(page.getByText('2 pedidos de alto valor')).toBeVisible();
  expect(errors).toEqual([]);
});
