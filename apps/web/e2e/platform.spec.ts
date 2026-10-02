import { test, expect } from '@playwright/test';
test('registro, importación, navegación, workflow, recarga y cierre de sesión', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Crear una organización', exact: true }).click();
  await page.getByLabel('Organización', { exact: true }).fill('Browser Test');
  await page.getByLabel('Tu nombre', { exact: true }).fill('Browser Owner');
  await page.getByLabel('Correo electrónico').fill(`browser-${Date.now()}@example.com`);
  await page.getByLabel('Contraseña', { exact: true }).fill('Safe-Test-Passphrase-2026!');
  await page.getByRole('button', { name: 'Crear organización', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Hola, Browser' })).toBeVisible();
  await page.getByRole('link', { name: 'AutoOps', exact: true }).click();
  await page.getByLabel('Archivo de transacciones CSV').setInputFiles({
    name: 'browser.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'customer_id,customer_name,transaction_id,amount,currency,date\nC1,Cliente Browser,T1,100,USD,2026-01-01\n',
    ),
  });
  await page.getByRole('button', { name: 'Validar archivo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Resultado de validación' })).toBeVisible();
  await page.getByRole('button', { name: 'Importar datos', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Resultado de importación' })).toBeVisible();
  await page.getByRole('link', { name: 'Customer Intelligence', exact: true }).click();
  await expect(page.getByText('Cliente Browser', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Segmentación RFM', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Recencia' })).toBeVisible();
  await page.getByRole('link', { name: 'Flow Engine', exact: true }).click();
  await page.getByRole('link', { name: 'Nuevo workflow', exact: true }).click();
  await expect(page.getByText('Inicio manual', { exact: true }).first()).toBeVisible();
  await page.getByLabel('Nombre', { exact: true }).fill('Browser workflow');
  await page.getByRole('button', { name: 'Guardar workflow', exact: true }).click();
  await expect(page).toHaveURL(/workflows\/c[a-z0-9]+$/);
  await page.getByRole('link', { name: 'Volver', exact: true }).click();
  await page.getByRole('button', { name: 'Ejecutar Browser workflow', exact: true }).click();
  await page.getByRole('button', { name: 'Ejecutar', exact: true }).click();
  await page.getByRole('link', { name: 'Ejecuciones', exact: true }).click();
  await expect(page.getByText('SUCCEEDED', { exact: true })).toBeVisible({ timeout: 15000 });
  await page.getByRole('link', { name: 'Predictive AI', exact: true }).click();
  await page.getByRole('button', { name: 'Evaluar clientes', exact: true }).click();
  await expect(page.getByText('Cliente Browser', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Security Center', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Equipo de tu organización' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Equipo de tu organización' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Abrir menú', exact: true }).click();
  await page.getByRole('link', { name: 'Vista general', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Hola, Browser' })).toBeVisible();
  await page.screenshot({ path: 'test-results/dashboard-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'test-results/dashboard-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Todo empieza aquí' })).toBeVisible();
  expect(errors).toEqual([]);
});
