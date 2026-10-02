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

## Reporte de vulnerabilidades

Para un repositorio público, utiliza el canal privado de seguridad del alojamiento si está habilitado. No publiques credenciales ni PoCs con datos de clientes en issues públicos. Documenta versiones afectadas, impacto, pasos reproducibles y medidas de mitigación. Conserva evidencias sin datos sensibles.

La implementación mejora la resistencia a ataques, pero no sustituye una revisión externa, pruebas de penetración autorizadas ni operación segura. La auditoría de dependencias se evalúa contra avisos conocidos al momento de ejecución.
