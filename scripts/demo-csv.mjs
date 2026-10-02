import { writeFileSync } from 'node:fs';
const lines = ['customer_id,customer_name,email,transaction_id,amount,currency,date'];
const currency = process.argv[3] ?? 'USD';
if (!['USD', 'CLP', 'EUR'].includes(currency)) throw new Error('Moneda: USD, CLP o EUR');
for (let i = 0; i < 200; i++) {
  const days = i < 100 ? [240, 210, 180 + (i % 30)] : [240, 135, 95 + (i % 5), 10 + (i % 20)];
  days.forEach((d, j) =>
    lines.push(
      `DEMO-C${i},Cliente Demo ${i + 1},cliente${i}@example.com,DEMO-T${i}-${j},${50 + ((i * 7 + j * 13) % 500)},${currency},${new Date(Date.now() - d * 86400000).toISOString()}`,
    ),
  );
}
const path = process.argv[2] ?? 'demo-transacciones.csv';
writeFileSync(path, lines.join('\n') + '\n');
console.log(`CSV sintético creado: ${path}. 200 clientes, 700 transacciones, moneda ${currency}.`);
