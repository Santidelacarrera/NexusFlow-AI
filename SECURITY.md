# Política de seguridad

## Versiones soportadas

Solo la rama `main` recibe correcciones de seguridad.

## Cómo reportar una vulnerabilidad

**No abras un issue público.** Usa _Security → Report a vulnerability_ (GitHub Private Vulnerability Reporting) en este repositorio, o escribe al mantenedor por el canal privado indicado en su perfil.

Incluye: componente afectado, pasos para reproducir, impacto esperado y, si es posible, una propuesta de mitigación.

| Fase                          | Objetivo       |
| ----------------------------- | -------------- |
| Acuse de recibo               | 72 horas       |
| Evaluación y severidad (CVSS) | 7 días         |
| Corrección crítica/alta       | 30 días        |
| Divulgación coordinada        | tras el parche |

## Alcance

Dentro de alcance: API (`apps/api`), web (`apps/web`), servicio ML (`services/ml`), configuración Docker/CI y documentación de despliegue.

Fuera de alcance: ataques de denegación de servicio volumétricos, ingeniería social contra mantenedores, hallazgos que requieran acceso físico o un administrador ya comprometido, y pruebas contra instalaciones de terceros sin su autorización.

## Reglas de pruebas (safe harbor)

Prueba solo contra tu propia instancia local (`docker compose up`). No accedas a datos de otras personas, no persistas ni exfiltres información, y detente al confirmar el hallazgo. Quien actúe de buena fe bajo estas reglas no será perseguido.

Los controles implementados y el modelo de amenazas están en [docs/SECURITY.md](docs/SECURITY.md).
