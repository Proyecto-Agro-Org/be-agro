# BE-08.1 — Infraestructura de errores, logging y seguridad

Actualizado: 17/11/2026, después de BE-08.3/08.4/08.5.
**Estado vigente: apta técnicamente para PR Draft; no Done.**
Sin commit, push, PR, integración ni despliegue.
Detalle: [hardening](INFORME_BE08_3_HARDENING_SEGURIDAD.md) y
[matriz](MATRIZ_BE08_SEGURIDAD_Y_REGRESION.md).

## Base y alcance

Rama: `feature/be-08-errores-logging-seguridad`.
HEAD/base: `04cf46155ca179a80127cfdda56ccbb0a59947c9`.
Identidad local: Camila Gonzalez, `camiiigonzalez1503@gmail.com`.
Sin consultas a GitHub, Vercel ni Atlas en el hardening; npm ci autorizado desde lock.
No hay modelos, endpoints de negocio, autenticación ni rate limiting distribuido.

## Arquitectura vigente

- Errores de aplicación tipados, clasificación segura y adaptador de respuesta.
- UUID servidor y logs construidos mediante campos permitidos y tipos runtime.
- 404 default HTML constante; 404 optativo JSON fijo; ninguno refleja pathname.
- Frontera terminal y callback final de dispatch propios para evitar logging raw
  de Express incluso con streams parciales o múltiples next(error) tardíos.
- Health mantiene route → controller → service → DTO, sin persistencia.
- MongoDB solo se conecta explícitamente; la app no lo invoca ni conecta al importar.

| Control | Default | Optativo |
|---|---|---|
| UUID/X-Request-ID servidor | Sí | Sí |
| Logging de errores sanitizado | Sí, 5xx a consola mediante DTO | Sí, sink inyectable |
| Logging inicio/final | No agregado globalmente | Sí |
| 404 | HTML genérico | JSON fijo |
| CORS | Política exacta existente | Misma política |
| Parser/límite/media type | No agregado globalmente | Estricto, 16 KiB configurable |
| Headers | x-powered-by off; 404 nosniff/no-store/CSP | nosniff/no-referrer/no-store/CSP |
| Frontera terminal y dispatch | Sí | Sí |

El perfil optativo se compone mediante
`createApp({ httpInfrastructure: createHttpInfrastructure() })`.
La exportación default sigue siendo Express, sin listener ni llamadas MongoDB.
Los consumidores aislados de módulos deben montar también
`http.protectApplication(app)` y `http.terminalErrorHandler`.

## Contrato de logging y errores

Los sinks reciben DTOs nuevos congelados con primitivos permitidos: timestamp,
event, UUID, método acotado, alias estático, status validado, código del catálogo
y duración/outcome cuando corresponde. La consola recibe su JSON. No se copian
Error/Request/Response, stack, cause, headers, URI, body, query o pathname.

No se muta el error original. No se usa una regex como filtro de secretos.
Un alias debe ser string primitivo e identificador estático del desarrollador.
Un sink lento o fallido no bloquea HTTP; el logging es best effort, sin garantía
de entrega durable o flush serverless. No se adoptan IDs externos ni trust proxy.

El optativo traduce Zod esperado a 400 y excepciones inesperadas a 500 seguro.
Mantiene el envelope provisional error:string; el futuro error:{code,message}
requiere BE-03. Sin body no exige tipo. Parser estricto para objetos/arrays:
400 JSON inválido, 413 exceso y 415 tipo/charset/encoding no admitido.
Límite propuesto 16384 bytes, configurable de 1 a 1048576; sin compresión.
El default no activa globalmente ese parser ni esos límites.

Después de headers o cierre no se intenta una segunda respuesta. La protección
de dispatch valida handle en runtime antes de la única aserción de integración
por ausencia del método en Application; debe revalidarse al actualizar Express.
No se cambió globalmente console ni NODE_ENV para ocultar registros.

## Evidencia y transición

- BE-08.1 original: 94 pruebas y 13 escenarios entonces equivalentes.
- BE-08.2: 102 pruebas; H01 logging raw y H05 404 abiertos en ese momento.
- Cierre actual: **120/120**, 18 nuevas sobre BE-08.2, ninguna eliminada.
- Dos expectativas de Error original sustituidas por garantías de logging seguro.
- npm ci una vez, typecheck, build y diff --check aprobados.
- Diferencial actual: **11 compatibles y 2 cambios intencionales de seguridad**.
  No son 13 respuestas idénticas; cero regresiones HTTP no deseadas detectadas.
- AST de 21 módulos: sin ciclos locales ni any explícitos.

GET/HEAD health, CORS y errores HTTP 403/500 mantienen status y body.
El HTML 404 es constante y X-Request-ID es una adición intencional.
No se aprobó el envelope final BE-03 ni se activó el perfil completo globalmente.

## Pendientes y límites

Revisión de equipo, BE-03, límites/media types por operación, configuración explícita
del perfil completo, Preview Vercel autorizado e integración. No hay garantía
universal de seguridad, de persistencia de logs o de finalización de adaptadores
arbitrarios del servidor. Su código debe ser confiable y finito.

Sin cambios package/lock, scripts, tsconfig, Vercel, Mongo ni validación BE-07.2.
main/dev y ramas anteriores intactas. Informe local BE-05 sin seguimiento e intacto:
SHA256 `6445DC2925627E49F9C8EEE03BAD3DF67362761DC155DD4E9DF422A6280A5E5D`.
Sin credenciales reales ni BE-09.
