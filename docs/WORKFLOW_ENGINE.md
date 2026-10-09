# Motor de workflows

Documento de diseño y de garantías. Todo lo descrito aquí está cubierto por pruebas (ver «Dónde se prueba»).

## 1. Modelo tipado

Cada nodo tiene un `type` cerrado y un `data` validado con Zod (`apps/api/src/workflows/graph.ts`). No existe ningún tipo que ejecute código.

| Tipo                                                                                               | Rol                                                     | Salida (campos tipados)                  |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------- |
| `trigger.manual` / `trigger.webhook` / `trigger.schedule` / `trigger.churn` / `trigger.late_order` | Entrada. Exactamente uno por flujo                      | `payload` (abierto)                      |
| `condition`                                                                                        | Ramas `true` / `false`                                  | `result: boolean`                        |
| `transform`                                                                                        | Asignaciones por plantilla                              | una cadena por clave asignada            |
| `data.operation`                                                                                   | `filter`, `aggregate` (`count/sum/avg/min/max`), `pick` | `items: array`, `count: number`, `value` |
| `action.notify` / `action.task`                                                                    | Alerta / tarea                                          | `alertId` / `taskId`                     |
| `action.http`                                                                                      | Llamada HTTPS (con integración)                         | `status: number`, `json`, `truncated`    |
| `action.report`                                                                                    | Informe consolidado                                     | abierta                                  |

Las **entradas** de un nodo son las rutas que consume: `{{trigger.x}}`, `{{steps.<nodo>.<campo>}}`, `{{data.<clave>}}`, el `field` de una condición y el `source` de una operación de datos.

## 2. Validación previa (al guardar, activar y ejecutar)

`validateGraph` rechaza, con un mensaje por problema:

- **Nodos desconectados** del disparador (se nombran) · **ciclos** · trigger ausente/múltiple · aristas a nodos inexistentes o con bucle · salidas de `condition` que no sean `true`/`false`.
- **Entradas faltantes**: referencia a un nodo inexistente, a un nodo que no se ejecuta antes (no es ancestro), a un campo que ese nodo no produce, o a `data.x` que ningún `transform` previo asigna.
- **Tipos incompatibles**: comparación numérica sobre `boolean/object/array`; `contains` sobre número; `in` sin lista; `data.operation` con fuente que no es lista; agregación sin campo.
- Credenciales pegadas en cabeceras de un nodo HTTP (deben ir en Integraciones).

## 3. Estados de ejecución

| Negocio    | `RunStatus` | Notas                                                     |
| ---------- | ----------- | --------------------------------------------------------- |
| pendiente  | `QUEUED`    | creada y encolada (la BD actúa de outbox)                 |
| ejecutando | `RUNNING`   | con latido (`heartbeatAt`) cada 2 s                       |
| completado | `SUCCEEDED` |                                                           |
| fallido    | `FAILED`    | `error` explica el motivo; el paso fallido guarda el suyo |
| cancelado  | `CANCELLED` | `cancelledBy`, `cancelRequestedAt`                        |

Pasos (`WorkflowRunStep`): una fila por `(runId, nodeId)` con `RUNNING/SUCCEEDED/FAILED/CANCELLED`, intentos, inicio, fin, duración y salida (con claves sensibles enmascaradas). Los nodos que no llegaron a ejecutarse no tienen fila; la interfaz los muestra como «No ejecutado».

## 4. Persistencia, reinicios y reanudación

- Cada paso se escribe en PostgreSQL **al empezar y al terminar** (checkpoint), no al final de la corrida.
- Si el proceso muere, el latido caduca (`RUN_LEASE_SECONDS`, 45 s por defecto) y `QueueService.recoverStale` devuelve la corrida a `QUEUED` (máx. 3 reanudaciones; después `FAILED`). El motor reconstruye el contexto desde los pasos `SUCCEEDED` y **continúa en el primer nodo no completado**; no repite los terminados.
- **Vallado** (fencing): toda escritura de pasos se hace dentro de una transacción que bloquea la fila de la corrida y exige `status=RUNNING` y la misma generación (`attempts`). Un proceso «zombi» que despierta tras haber sido reanudado no puede sobrescribir el trabajo del nuevo.
- Semántica de efectos: **al menos una vez con deduplicación**. Un nodo que murió a mitad puede ejecutarse de nuevo, pero su clave `runId:nodeId` se reutiliza (ver §6).

## 5. Errores, reintentos y tiempos

- `retries` (0–3) por nodo con _backoff_ exponencial; solo para errores transitorios. `PermanentError` (HTTP 4xx salvo 408/429, integración inválida, fuente no válida, salida >64 KB) **no se reintenta**.
- `timeoutMs` por nodo (100 ms–30 s, 15 s por defecto) con `AbortSignal` que corta la petición HTTP subyacente; plazo total de 120 s y máximo de 200 pasos por corrida.
- Cada intento fallido queda en la traza (`step.retry`).

## 6. Idempotencia

- `Alert.idempotencyKey` y `Task.idempotencyKey` (únicas) = `runId:nodeId`. Repetir el nodo devuelve el mismo registro (`deduplicated: true`).
- `action.http` envía la cabecera `Idempotency-Key: runId:nodeId`; el servicio externo puede deduplicar.
- `dispatchKey` único evita corridas duplicadas (programación por minuto, repetición de webhooks).

## 7. Cancelación y trazabilidad

- `POST /api/runs/:id/cancel` (rol ANALYST): `QUEUED` → `CANCELLED` al instante; `RUNNING` → se señaliza y el motor aborta el nodo en curso (≤ 2 s) y termina como `CANCELLED`.
- `WorkflowRunEvent` (append-only, `seq` único por corrida): `run.queued` (con `triggeredBy`), `run.started/resumed/requeued`, `step.started/retry/succeeded/failed/cancelled`, `run.cancel_requested/cancelled/succeeded/failed`. Visible en la interfaz (Ejecuciones → Ver pasos). Las acciones de usuario (crear, ejecutar, cancelar) además entran en la cadena de auditoría HMAC.

## 8. Dónde se prueba

| Garantía                                                                                                                            | Prueba                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Validación tipada, operaciones de datos, permanentes/timeout/cancelación en el motor                                                | `apps/api/src/workflows/typed-graph.spec.ts`, `engine.spec.ts`          |
| Persistencia por nodo, reintentos, timeout, **reanudación tras reinicio sin duplicar**, cancelación, fencing, tope de reanudaciones | `apps/api/src/workflows/runner.db.spec.ts` (PostgreSQL real)            |
| Permisos, aislamiento entre organizaciones, límites, credenciales, webhook firmado, caso de uso completo                            | `apps/api/src/workflows/api.db.spec.ts` (Nest + supertest + PostgreSQL) |
| Editor → backend → BD → historial en la interfaz                                                                                    | `apps/web/e2e/workflow-e2e.spec.ts` (Playwright)                        |

`npm run test:db -w @nexusflow/api` ejecuta las pruebas con base de datos (requiere `DATABASE_URL` con migraciones aplicadas; en CI hay un servicio PostgreSQL).
