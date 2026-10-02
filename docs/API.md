# API REST

Base: `/api`. Salvo health, login/registro/refresh/logout, hooks firmados y training/event, las rutas requieren `Authorization: Bearer <accessToken>`. Se validan cuerpos y parámetros con Zod. El servidor obtiene organización y rol de la sesión, no de parámetros del cliente.

Roles jerárquicos: OWNER > ADMIN > ANALYST > VIEWER. Los errores tienen `statusCode`, `message` y `requestId`. Una mutación POST suele devolver 201; login/refresh/activar/pausar devuelven 200 y los webhooks 202. Logout, cambio de contraseña y borrado devuelven 204.

| Ruta                                                | Método             | Mínimo                   | Función                                       |
| --------------------------------------------------- | ------------------ | ------------------------ | --------------------------------------------- |
| `/health`, `/health/ready`                          | GET                | Público                  | Liveness / conexión PostgreSQL                |
| `/auth/register`, `/auth/login`                     | POST               | Público                  | Organización OWNER / sesión                   |
| `/auth/refresh`, `/auth/logout`                     | POST               | Cookie                   | Rotación / cierre de familia                  |
| `/auth/me`                                          | GET                | VIEWER                   | Usuario y organización actuales               |
| `/auth/logout-all`, `/auth/change-password`         | POST               | VIEWER                   | Revocación / cambio                           |
| `/users`                                            | GET / POST         | ADMIN                    | Listar / crear usuarios                       |
| `/users/:id`                                        | PATCH              | ADMIN                    | Nombre, rol, activación                       |
| `/users/:id/password`, `/users/:id/revoke-sessions` | POST               | ADMIN                    | Reset / revocación                            |
| `/analytics/overview`, `/analytics/rfm`             | GET                | VIEWER                   | Indicadores / segmentos                       |
| `/customers`, `/customers/:id`                      | GET                | VIEWER                   | Clientes / detalle                            |
| `/imports/transactions?dryRun=true`                 | POST multipart     | ANALYST                  | Analizar CSV en campo file                    |
| `/imports/transactions`                             | POST multipart     | ANALYST                  | Importar lote válido                          |
| `/imports`, `/imports/latest`                       | GET                | VIEWER                   | Historial / reporte reciente                  |
| `/workflows`                                        | GET / POST         | VIEWER / ANALYST         | Listar / crear                                |
| `/workflows/:id`                                    | GET / PUT / DELETE | VIEWER / ANALYST / ADMIN | Consultar / editar / borrar                   |
| `/workflows/:id/activate`, `/workflows/:id/pause`   | POST               | ANALYST                  | Estado                                        |
| `/workflows/:id/run`                                | POST               | ANALYST                  | Encolar con `{payload:{}}`                    |
| `/workflows/:id/webhook-secret`                     | POST               | ADMIN                    | Rotar secreto                                 |
| `/workflows/stats`, `/runs`, `/runs/:id`            | GET                | VIEWER                   | Métricas / historial / pasos                  |
| `/hooks/:webhookId`                                 | POST               | HMAC                     | Webhook autenticado y deduplicado             |
| `/reports/generate`                                 | POST               | ANALYST                  | Reporte consolidado como alerta               |
| `/predictive`, `/predictive/policy`                 | GET                | VIEWER                   | Último lote / política                        |
| `/predictive/policy`                                | PUT                | ADMIN                    | `{threshold,action:TASK\|ALERT,enabled}`      |
| `/predictive/train`                                 | POST               | ADMIN                    | Entrenar con historial observado              |
| `/predictive/score`                                 | POST               | ANALYST                  | Evaluar y aplicar política si está habilitada |
| `/operations/kpis`, `/operations/orders`            | GET                | VIEWER                   | KPIs / pedidos                                |
| `/operations/simulate`, `/operations/detect`        | POST               | ANALYST                  | Simular / detectar atrasos                    |
| `/alerts`, `/tasks`                                 | GET                | VIEWER                   | Bandejas paginadas                            |
| `/alerts/:id`, `/tasks/:id`                         | PATCH              | ANALYST                  | Actualizar estado                             |
| `/integrations`                                     | GET / POST         | VIEWER / ADMIN           | Metadatos / credenciales cifradas             |
| `/integrations/:id`                                 | DELETE             | ADMIN                    | Borrar integración                            |
| `/security/audit`, `/security/campaigns`            | GET                | ADMIN                    | Auditoría / campañas agregadas                |
| `/security/audit/verify`                            | POST               | ADMIN                    | Verificar cadena                              |
| `/security/campaigns`                               | POST               | ADMIN                    | `{name,authorizationRef,userIds}`             |
| `/security/campaigns/:id/close`                     | POST               | ADMIN                    | Invalidar enlaces                             |
| `/security/training/event`                          | POST               | Token de campaña         | `{token,event:clicked\|reported}`             |

Listas paginadas usan `page` y `pageSize` (1–100, por defecto 25) y devuelven `{items,total,page,pageSize}`. Workflows, integraciones, usuarios e importaciones tienen límites fijos de consulta documentados en código. Customers admite `search`; RFM `segment`; orders `status` y `late=true`; auditoría `action` como prefijo.

## Ejemplo de grafo

```json
{
  "name": "Retención",
  "graph": {
    "nodes": [
      { "id": "start", "type": "trigger.churn", "data": { "minProbability": 0.7 } },
      { "id": "task", "type": "action.task", "data": { "title": "Contactar {{trigger.customerId}}" } }
    ],
    "edges": [{ "id": "e1", "source": "start", "target": "task" }]
  }
}
```

Los payloads de abandono contienen customerId y probability; los de atraso contienen orderId, externalId, carrier y delayHours. Los nombres/campos se consultan en los servicios de dominio. No confíes en datos de webhooks para otorgar permisos.

## Firma de webhook desde Node

Define `WEBHOOK_SECRET` y `WEBHOOK_URL` por entorno, sin registrarlos en consola:

```js
import { createHmac } from 'node:crypto';
const body = JSON.stringify({ customerId: 'C001', event: 'venta' });
const timestamp = Math.floor(Date.now() / 1000).toString();
const signature = createHmac('sha256', process.env.WEBHOOK_SECRET)
  .update(`${timestamp}.${body}`)
  .digest('hex');
const response = await fetch(process.env.WEBHOOK_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Nexus-Timestamp': timestamp,
    'X-Nexus-Signature': `sha256=${signature}`,
  },
  body,
});
if (!response.ok) throw new Error(`Webhook HTTP ${response.status}`);
```

El receptor verifica el cuerpo exacto; cambiar espacios o serializar nuevamente después de firmar invalida la firma. Usa un timestamp nuevo para una solicitud nueva. No reintentes con otra firma si una acción anterior pudo completarse: reconcilia con el historial para evitar efectos duplicados.
