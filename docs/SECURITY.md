# Seguridad

## Fronteras de confianza

Navegador → API autenticada; API → PostgreSQL/Redis internos; API → ML con token de servicio; runner → hosts HTTPS explícitos. El operador controla variables de entorno, dominio, proxy y allowlist. El rol OWNER puede administrar toda su organización; no otorga acceso entre organizaciones.

| Amenaza                      | Controles                                                                                         | Límites                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Acceso entre organizaciones  | orgId desde sesión, filtros por tenant, tests de IDs ajenos                                       | RLS no implementada; revisa filtros en cada endpoint nuevo                                   |
| Robo/reutilización de sesión | Tokens de acceso cortos en memoria, refresh hash/rotación, cookie HttpOnly, revocación de familia | XSS puede actuar durante una sesión; requiere dependencias y CSP mantenidas                  |
| Escalada de rol              | RBAC global, ADMIN gestiona solo inferiores, último OWNER conservado con lock                     | OWNER es una cuenta de alta confianza; MFA es trabajo futuro                                 |
| CSRF/login CSRF              | SameSite Strict, Origin explícito y rechazo de sec-fetch-site cross-site                          | Clientes sin Origin se admiten para uso por API; TLS/proxy correctos son necesarios          |
| Fuerza bruta                 | Rate limiting, bloqueo temporal, scrypt, respuesta uniforme de login                              | Rate limiting vive en cada instancia; usa un limitador distribuido/perimetral al escalar     |
| SSRF/exfiltración            | Allowlist exacta, HTTPS, puertos restringidos, bloqueo IP privada, DNS seguro, sin redirects      | Un dominio autorizado comprometido puede abusar de su autorización; aplica control de egreso |
| Filtración de credenciales   | AES-GCM, claves fuera de Git, metadatos seguros, no preview de HTTP autenticado                   | Cuerpos de workflows son datos auditables, no una bóveda de secretos                         |
| Alteración de auditoría      | HMAC encadenado, locks por tenant, verificador incremental                                        | El truncamiento final requiere checkpoints externos; acceso a la clave compromete la cadena  |
| Archivos hostiles            | Límite de carga/filas/registro, validación CSV, neutralización de fórmulas                        | No se aceptan XLSX, macros ni documentos arbitrarios                                         |
| Modelo malicioso             | Formato nativo JSON, entrenamiento interno, directorios por hash de org                           | El operador debe proteger volúmenes y token ML; no acepta modelos externos                   |

## Secretos y claves

`npm run setup` crea secretos independientes mediante CSPRNG. Nunca publica su contenido. El `.env` local y el de Docker son configuraciones separadas; ML_SERVICE_TOKEN debe coincidir en API y ML para el entorno que se esté usando.

En producción configura secretos mediante un gestor y el mecanismo del orquestador. No guardes `.env` en Git ni en imágenes. La clave AES es de 32 bytes en base64. Cambiarla exige recifrar integraciones y secretos de webhook. Cambiar AUDIT_HMAC_KEY requiere una estrategia de versiones o resellado verificable. La rotación del secreto JWT obliga a iniciar sesión nuevamente.

## Auditoría

El registro cubre accesos, intentos fallidos, usuarios, imports, workflows, modelos, políticas, tareas/alertas e integraciones. Las peticiones HTTP tienen requestId; los errores internos no revelan stack traces al navegador. Metadatos de eventos no deben contener secretos ni datos personales innecesarios.

Algunas acciones escriben la auditoría después de completar su transacción de negocio. Un fallo de auditoría produce error visible, pero puede dejar el efecto de negocio persistido. Debe añadirse un outbox de auditoría transaccional antes de exigir cumplimiento regulatorio o garantía de cobertura total.

## Simulaciones educativas

Solo usuarios administradores pueden crear campañas. Deben registrar autorización y escoger usuarios activos del mismo tenant. No se envía correo automáticamente. Las URLs llevan un token en el fragmento para evitar enviarlo como query/referrer; el frontend lo transmite en el cuerpo de un evento. La base guarda su hash. La landing no recoge contraseña ni códigos y se identifica como educativa.

Cerrar la campaña invalida sus enlaces. Los enlaces caducan en 30 días; clics/reportes repetidos no aumentan contadores. Los resultados de campañas exponen agregados y no tokens por destinatario.

## Endurecimiento de contenedores y red

- `compose.production.yaml` ejecuta api, ml y web con sistema de ficheros de solo lectura, `cap_drop: ALL`, `no-new-privileges`, `tmpfs` con `noexec`, límite de procesos y de memoria. Redis corre como usuario no-root.
- Postgres, Redis y el servicio ML no publican puertos en el despliegue normal; solo la web escucha (en `127.0.0.1`). Redis exige contraseña (`REDIS_PASSWORD`, generada por `npm run setup`).
- La API responde siempre con `Cache-Control: no-store`, CSP `default-src 'none'` y CORP/COOP `same-origin`; no existe ninguna respuesta autenticada cacheable.
- La validación de entorno impide arrancar en producción con secretos de ejemplo, Redis ausente u orígenes CORS sin HTTPS.

## Ejecución segura de workflows

| Requisito                                  | Control                                                                                                                                                                            | Prueba                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| El editor no ejecuta código en el servidor | Tipos de nodo cerrados (`z.enum`), plantillas `{{ruta}}` de solo lectura sobre propiedades propias (sin `eval`, sin prototipos), operaciones de datos implementadas en el servidor | `typed-graph.spec.ts`, `api.db.spec.ts` («grafos con código ejecutable») |
| Tiempo                                     | 15 s por nodo (configurable ≤ 30 s) con `AbortSignal`, 120 s por corrida, 200 pasos                                                                                                | `runner.db.spec.ts` (timeout), `typed-graph.spec.ts`                     |
| Memoria                                    | Payload ≤ 50 KB, salida por nodo ≤ 64 KB, listas ≤ 5000 elementos, heap de Node limitado (`--max-old-space-size=384`) y contenedor `mem_limit: 512m`, `pids_limit`                 | `typed-graph.spec.ts` («salidas desmedidas»)                             |
| Concurrencia                               | 5 ejecuciones simultáneas por proceso (BullMQ y modo en proceso), tope de 200 activas por organización con bloqueo asesor                                                          | `api.db.spec.ts` (tope por organización)                                 |
| Abuso                                      | Límite de 30 ejecuciones manuales/min, 60 webhooks/min, 150 peticiones/min globales; webhooks con HMAC, ventana anti-replay y firma de un solo uso                                 | `api.db.spec.ts` (429, firma repetida)                                   |
| Credenciales                               | Cifradas en reposo; fuera de respuestas, pasos, eventos, auditoría y errores; no se permiten en el grafo                                                                           | `api.db.spec.ts`                                                         |
| Permisos                                   | VIEWER lee; ANALYST crea/ejecuta/cancela; ADMIN elimina/gestiona integraciones; toda consulta filtra por `orgId` de la sesión                                                      | `api.db.spec.ts`                                                         |
| Aislamiento entre organizaciones           | Lecturas, escrituras, ejecución, cancelación e integraciones ajenas devuelven 404; una integración de otra organización no se puede usar desde un workflow                         | `api.db.spec.ts`, `runner.db.spec.ts`                                    |

Límites conocidos: el aislamiento es a nivel de aplicación (sin RLS en PostgreSQL); los límites de memoria son por proceso/contenedor, no por ejecución; un dominio de la lista de permitidos comprometido sigue siendo un riesgo de egreso.

## Verificación continua

`.github/workflows/security.yml` ejecuta CodeQL (`security-extended`) para TypeScript y Python, gitleaks sobre todo el historial y Trivy sobre las tres imágenes (falla con HIGH/CRITICAL que tengan parche). Dependabot actualiza npm, pip y GitHub Actions semanalmente. La política de divulgación está en [SECURITY.md](../SECURITY.md).

## Reporte de vulnerabilidades

Para un repositorio público, utiliza el canal privado de seguridad del alojamiento si está habilitado. No publiques credenciales ni PoCs con datos de clientes en issues públicos. Documenta versiones afectadas, impacto, pasos reproducibles y medidas de mitigación. Conserva evidencias sin datos sensibles.

La implementación mejora la resistencia a ataques, pero no sustituye una revisión externa, pruebas de penetración autorizadas ni operación segura. La auditoría de dependencias se evalúa contra avisos conocidos al momento de ejecución.
