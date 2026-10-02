# Operación y recuperación

## Configuración

| Variable                          | Uso                                                      |
| --------------------------------- | -------------------------------------------------------- |
| DATABASE_URL                      | Conexión Prisma PostgreSQL                               |
| REDIS_URL                         | Cola BullMQ; obligatoria en producción                   |
| JWT_ACCESS_SECRET                 | Firma HS256, mínimo 32 caracteres                        |
| DATA_ENCRYPTION_KEY               | 32 bytes base64 para AES-256-GCM                         |
| AUDIT_HMAC_KEY                    | Firma de auditoría, mínimo 32 caracteres                 |
| ML_SERVICE_URL / ML_SERVICE_TOKEN | Servicio predictivo interno y credencial                 |
| CORS_ORIGINS                      | Orígenes exactos separados por coma; HTTPS en producción |
| ALLOW_REGISTRATION                | true/false; false en producción                          |
| HTTP_ACTION_ALLOWLIST             | Dominios exactos; vacío deshabilita acciones HTTP        |
| TRUST_PROXY                       | Número de proxies de confianza (0 local, 1 Nginx)        |
| POSTGRES_PASSWORD / WEB_PORT      | Preparación del stack Docker                             |

La API falla al arrancar si faltan claves o se usan ejemplos conocidos en producción. No cambies TRUST_PROXY sin conocer la topología: una mala configuración permite falsificar la IP y evade límites por cliente. Nginx sobrescribe X-Forwarded-For desde la dirección de la conexión, sin confiar en cabeceras recibidas.

La variante production está preparada para un proxy TLS externo, pero no aprovisiona dominio ni certificados. Las cookies Secure no funcionan con HTTP: no pruebes esa variante usando HTTP para login/refresh. El puerto de web está ligado a localhost para que el operador publique solamente lo previsto.

## Respaldos

Respalda PostgreSQL, el volumen de modelos y las claves criptográficas por separado en ubicaciones con permisos estrictos. El dump incluye hashes de contraseñas, información de clientes y credenciales cifradas; sigue siendo información sensible.

Ejemplo de dump textual, evitando una redirección binaria desde PowerShell:

```bash
docker compose exec -T postgres pg_dump -U nexus -d nexusflow --file=/tmp/nexusflow-backup.sql
docker compose cp postgres:/tmp/nexusflow-backup.sql ./nexusflow-backup.sql
```

Restaura primero en un entorno aislado, comprueba migraciones y auditoría, y verifica que el token ML/clave AES/clave HMAC correspondan al respaldo. Conserva checkpoints externos de auditoría para detectar truncamientos. No se ejecutan restauraciones destructivas desde scripts de este proyecto.

## Incidentes de cola

Los jobs encolados tienen representación en la base. Si Redis falla, el reconciliador reintenta el envío de QUEUED. Revisa `/runs` y logs correlacionados. Las corridas RUNNING por más de cinco minutos quedan fallidas; valida alertas, tareas y efectos externos antes de ejecutarlas manualmente otra vez.

BullMQ retiene un máximo de 1.000 jobs completados y 5.000 fallidos; el historial de negocio permanece en PostgreSQL. Debes definir una política de retención de datos en producción. No borres auditoría mediante tareas de limpieza genéricas.

## IA

Una organización sin modelo muestra heurística. Un entrenamiento con insuficiente historial o una sola clase devuelve un error de validación. Si el modelo no mejora PR-AUC frente a la línea base, no se promueve; el modelo anterior se conserva. La UI muestra el resultado de evaluación.

El entrenamiento y scoring son peticiones acotadas en esta versión (90/30 segundos desde la API), con un máximo de 100.000 transacciones/10.000 clientes. La exclusión de entrenamiento concurrente es por proceso ML; opera con una sola instancia ML hasta incorporar locks distribuidos y tareas asíncronas.

Un timeout del cliente no cancela necesariamente un cálculo ya iniciado. Consulta nuevamente el modelo/resultado antes de repetir un entrenamiento. No atribuyas valor comercial a métricas de datos sintéticos.

## Diagnóstico

```bash
docker compose ps
docker compose logs --tail 100 api ml migrate
curl http://localhost:8088/api/health/ready
```

Health readiness comprueba PostgreSQL. Compose comprueba Redis y ML por separado. El requestId aparece en las respuestas y logs para correlación. No registres tokens, contraseñas, cookies, datos personales o payloads completos durante diagnóstico.

## Límites pendientes de operación comercial

Rate limiting por instancia, ausencia de métricas Prometheus/alertas de infraestructura, ausencia de restauración automatizada, falta de outbox de auditoría/eventos de negocio, sin backups/checkpoints externos configurados por defecto, sin plan de continuidad o borrado por tenant. Requieren decisiones del entorno comercial y pruebas adicionales.
