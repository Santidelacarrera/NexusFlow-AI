# Integraciones y credenciales

Una integración es un destino HTTPS con cabeceras de autenticación guardadas **cifradas** (AES-256-GCM, clave `DATA_ENCRYPTION_KEY`, el id de la integración como dato autenticado adicional).

## Ciclo de vida de una credencial

1. **Alta** (rol ADMIN, Integraciones → Nueva): plantillas para GitHub, Slack y API genérica. El navegador envía las cabeceras una vez; la API solo devuelve `id`, `name`, `baseUrl`.
2. **Almacenamiento**: `headersEnc` en PostgreSQL. Nunca se devuelven, ni aparecen en pasos, eventos, auditoría o errores (`redactDeep` por nombre de clave y `redactText` por valor para mensajes de error).
3. **Uso**: el nodo HTTP referencia `integrationId`; el motor descifra en memoria al ejecutar, verifica que la integración pertenece a la **misma organización** y que el origen de la URL coincide con `baseUrl`.
4. **Prueba** (`POST /api/integrations/:id/test`): GET al destino; solo devuelve `{ ok, status, durationMs }`.
5. **Rotación**: crear una nueva integración y apuntar el nodo; eliminar la anterior.

Los nodos HTTP no pueden contener cabeceras `Authorization`, `Cookie`, `token`, `secret`, `api-key` (validación del grafo). El destino debe estar en `HTTP_ACTION_ALLOWLIST`, ser HTTPS, sin redirecciones, sin IP privadas (el DNS se valida al conectar) y con límites de tiempo y tamaño.

## Caso de uso: pedidos de alto valor → CRM/GitHub → alerta

`webhook` → `data.operation filter (amount ≥ 1000)` → `aggregate sum` → `condition (count > 0)` → `action.http POST` (integración) → `action.notify`. La plantilla «Pedidos de alto valor» del editor carga la primera mitad; añade el nodo HTTP con tu integración (por ejemplo GitHub `POST https://api.github.com/repos/<org>/<repo>/issues`). El flujo completo con un CRM simulado está en `api.db.spec.ts`.
