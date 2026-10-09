# Validación local

Fecha: 2 de octubre de 2026, America/Santiago. Entorno: Windows, Node.js 24, Docker Desktop Linux; PostgreSQL 16, Redis 7 y Python 3.12 en contenedores.

| Verificación                  | Resultado                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Tipos TypeScript de API y web | Correctos con modo strict                                                                                                      |
| Build NestJS/Prisma + Vite    | Correcto                                                                                                                       |
| Pruebas Jest                  | 104 casos, 11 suites correctas                                                                                                 |
| Pruebas Vitest                | 3 casos correctos                                                                                                              |
| Pruebas Python en contenedor  | 3 casos correctos: features/etiquetas, auth/validación, entrenamiento/scoring/SHAP/aislamiento                                 |
| Smoke HTTP                    | 48 respuestas comprobadas, sin fallo                                                                                           |
| Circuito integrado de IA      | 700 transacciones → 200 predicciones SHAP → 100 acciones y 100 workflows; repetición sin duplicar tareas                       |
| Navegador Chromium            | Registro, importación, RFM, editor, ejecución, predicciones, Security Center, refresh por recarga y cierre de sesión correctos |
| Interfaz móvil/escritorio     | Capturas revisadas a 390 px y 1440 px                                                                                          |
| Stack Compose                 | PostgreSQL/Redis/ML/API saludables, web en localhost:8088; migraciones aplicadas                                               |
| Auditoría npm                 | 0 vulnerabilidades conocidas al ejecutar, incluidas dependencias de desarrollo                                                 |

La auditoría `pip-audit` de las dependencias Python fijadas en `requirements.lock` también devuelve **0 vulnerabilidades conocidas**. Se ejecutó en un contenedor temporal, sin modificar el servicio activo.

## Qué comprueban las pruebas HTTP

Rechazo de acceso anónimo, VIEWER sin permisos de escritura/administración, IDs de otras organizaciones, conservación del OWNER, validación CSV, importación repetida sin ventas duplicadas, moneda ajena rechazada, ingresos/RFM, grafos inválidos, ejecución y pasos persistidos, alertas, reportes, logística sin repetir alertas, heurística identificada, entrenamiento insuficiente rechazado, campañas con eventos agregados/enlaces cerrados, HMAC válido/replay rechazado, CSRF y revocación inmediata de sesiones.

Las pruebas de integración ML verifican que el modelo se promueva solo tras comparar PR-AUC con la línea base, que el último lote tenga un registro por cliente, que SHAP esté presente y que las políticas y triggers trabajen con resultados entrenados. Las muestras son sintéticas y no sirven como evidencia de eficacia de retención en un negocio real.

## Alcances

No se han ejecutado pruebas de carga, penetración externa, restauración de backups en producción, evaluación estadística sobre datos comerciales, pruebas exhaustivas en Safari/Firefox ni publicación con TLS real. La configuración CI está versionada; una ejecución local no prueba que la ejecución alojada en GitHub haya terminado.

Windows bloqueó una DLL de Pandas por Control de aplicaciones. Se comprobó el servicio predictivo en Docker, donde las pruebas y el circuito HTTP funcionan. No se alteraron las políticas de seguridad de Windows.

Las pruebas de navegador crean datos propios y no usan respuestas mock. Sus capturas y trazas se guardan en `apps/web/test-results`, que no forma parte del repositorio. Los smoke generan organizaciones aisladas identificadas en su salida.

## Actualización: motor, seguridad de ejecución, integración y ML (9 de octubre de 2026)

Entorno: Linux, Node 22, PostgreSQL 16 local (sin Docker ni Redis: cola en proceso), Python 3.13 con las versiones de `requirements.txt`. **No se ejecutó el stack Compose, el smoke HTTP ni Playwright contra el stack Docker en esta pasada**; se ejecutaron contra una API real y PostgreSQL locales.

| Verificación                      | Resultado                                                                                                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jest (API)                        | 148 casos, 16 suites, incluidas 3 suites sobre PostgreSQL real (`npm run test:db`): motor (12), API/seguridad/caso de uso (16) y validación tipada (12 sin BD)                                                                                    |
| Reanudación tras reinicio         | Prueba: un proceso se «muere» en el nodo 3 de 4; el latido caduca; otro proceso reanuda; los nodos 1–2 no se repiten, no se duplican tareas/alertas, el run termina `SUCCEEDED` con `resumeCount=1` y traza `run.requeued → run.resumed`          |
| Playwright `workflow-e2e.spec.ts` | Editor (plantilla) → API → PostgreSQL → webhook firmado → historial con estado, tiempos, motivo del fallo y traza: correcto contra Vite + API local                                                                                               |
| Playwright `platform.spec.ts`     | Los pasos de registro, importación, RFM y workflow pasan; falla en «Predictive AI → Evaluar clientes» porque el servicio ML no se levantó en esta pasada. No se re-ejecutó con ML                                                                 |
| pytest (ML)                       | 10 casos (3 previos + 7 de evaluación: métricas, bootstrap, dataset determinista, hash reproducible, líneas base, control de fugas, SHAP)                                                                                                         |
| Evaluación ML                     | Reproducible (hash idéntico en dos ejecuciones). XGBoost supera con claridad a la línea base de prevalencia, **pero no demuestra ventaja sobre ordenar solo por recencia** (+0,019 PR-AUC, IC 95 % [−0,001, +0,041]). Ver `docs/ML_EVALUATION.md` |

No se realizaron pruebas de carga, de penetración, de fallo de Redis/BullMQ ni de reinicio real de contenedores; la reanudación se probó simulando la muerte del proceso a nivel de aplicación (latido caducado), no matando un proceso del sistema operativo.
