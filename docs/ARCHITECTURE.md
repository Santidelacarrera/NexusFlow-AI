# Decisiones de arquitectura

## Monolito modular y servicio predictivo

NestJS concentra reglas de negocio, permisos y persistencia. Sus módulos comparten Prisma, auditoría y dispatch de eventos; Python se usa para el cálculo y entrenamiento. Evita duplicar autorización y facilita probar transacciones. Redis/BullMQ desacopla la recepción de eventos de la ejecución de workflows. El worker vive en el proceso de API en esta versión: múltiples instancias coordinan jobs mediante BullMQ y claims atómicos en PostgreSQL.

## Aislamiento de organizaciones

El guard valida firma, issuer/audience/expiración, familia de sesión activa y usuario vigente. La organización de cada consulta se obtiene de ese usuario. Los identificadores externos de clientes/transacciones/pedidos son únicos dentro de una organización. Los servicios ML derivan el directorio de modelos mediante SHA-256 del identificador interno, sin rutas suministradas por usuarios.

Este aislamiento se implementa en la aplicación. PostgreSQL RLS y claves foráneas compuestas serían una segunda barrera para futuras versiones; no se declara que estén presentes. Ninguna consulta pública recibe un orgId con autoridad para cambiar de organización.

## Ejecuciones y consistencia

Dispatch serializa cuota y deduplicación por organización, crea un registro QUEUED y copia el grafo dentro de una transacción. Redis recibe el ID del registro. Un reconciliador recorre registros pendientes, y el runner cambia QUEUED → RUNNING mediante un update condicional: solo un consumidor obtiene el claim.

Las acciones tienen efectos en base o servicios externos antes de guardar el resultado de la corrida. Si ocurre un error de persistencia posterior, la corrida se marca FAILED y se requiere revisar efectos. No se repiten automáticamente esas corridas para aparentar una garantía de exactamente una vez. Los endpoints externos deben aceptar idempotencia propia para reintentos por nodo.

Los cron se deduplican con claves por workflow y minuto UTC. Los webhooks se deduplican con claves por identificador y firma. Los eventos de retraso usan un índice único de alerta. La política predictiva serializa scoring por organización y comprueba tareas/alertas abiertas antes de crearlas. Las acciones originadas por esa política disparan workflows de abandono y respetan el minProbability del trigger.

El dispatch posterior al scoring y a la detección logística aún no utiliza un outbox transaccional de eventos de negocio. Un fallo entre la creación de la acción y el dispatch requiere reconciliación operativa; está documentado como límite, no como garantía de entrega total.

## Predicciones

Features calculadas antes del corte, etiqueta en los 90 días posteriores y holdout de clientes. Esta separación evita contaminación directa del target. Cada lote de scoring tiene su ModelRun y sus Prediction; la UI selecciona el último lote completo mediante modelRunId, evitando mezclar versiones o duplicar clientes por históricos.

El holdout de clientes permite una validación reproducible, pero una única ventana histórica no prueba robustez temporal. No se afirma calibración probabilística. El pipeline solo promueve si supera una línea base de prevalencia en PR-AUC, y registra tamaño de muestras, horizonte, corte y métricas. Antes de producción deben añadirse validaciones temporales repetidas, calibración y seguimiento del drift.

## Importaciones y monedas

La organización fija una moneda de reporte. Las importaciones con monedas distintas se rechazan antes de escribir. Una transacción envuelve clientes y ventas por lotes; los IDs existentes se omiten. Una fila inválida no contamina el lote válido. No se realizan conversiones de divisas implícitas ni se suman importes heterogéneos.

## Evolución

Facturación, conectores específicos, XLSX, RPA, telemetría real y comunicaciones salientes se reservan para una versión con requisitos operativos concretos. Las fuentes simuladas quedan visibles como tales. Los controles críticos del servidor cuentan con tests unitarios y recorridos HTTP reales, además de pruebas de navegador.
