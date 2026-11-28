# BE-08.2 — Auditoría inicial y resolución vigente

Actualizado: 17/11/2026. BE-08.2 terminó inicialmente con 102 pruebas aprobadas y
hallazgos abiertos. Este informe registra su resolución durante BE-08.3/08.4/08.5.
La recomendación de bloqueo inicial quedó sustituida por la evaluación vigente de
[hardening](INFORME_BE08_3_HARDENING_SEGURIDAD.md) y
[matriz](MATRIZ_BE08_SEGURIDAD_Y_REGRESION.md).

## Alcance y trazabilidad

Rama `feature/be-08-errores-logging-seguridad`, HEAD/base
`04cf46155ca179a80127cfdda56ccbb0a59947c9`.
Identidad local: Camila Gonzalez, `camiiigonzalez1503@gmail.com`.
No se publicó ni se modificó historial compartido. La auditoría inicial revisó
los 12 archivos BE-08.1 y el handler legacy; corrigió defectos sin imponer
globalmente parser, JSON 404 o contrato definitivo BE-03.

## Hallazgos originales y estado vigente

| Hallazgo | Severidad inicial | Estado actual |
|---|---|---|
| H01: Error original en console.error | Alta | Cerrado: DTO seguro, marcadores/cause/metadata comprobados |
| H02: status inválido/getter escapaba al finalhandler | Media | Corregido en BE-08.2 y revalidado, 500 JSON fijo |
| H03: logger fallido exponía excepción | Media | Corregido y completado preservando retorno de Promise |
| H04: segunda escritura/carrera de headers | Media | Corregido, guardas y frontera terminal |
| H05: 404 reflejaba pathname | Media | Cerrado: HTML constante con status 404 |
| H06: perfil completo no activo default | Media operativa | Documentado; default ya protege logs/UUID/404 |
| H07: 16 KiB sin DTO aprobado | Baja | Configurable/optativo, pendiente por operación |

La reproducción inicial usó marcadores ficticios en mensaje, propiedades y cause,
sin credenciales reales. Demostró fuga al sink raw, aunque el JSON HTTP 500 ya
era fijo. Healthy requests no registraban automáticamente headers/bodies.
El pathname se reflejaba en 404; la query aislada no apareció en su body.

## Expectativas históricas y corrección

Dos aserciones exigían la referencia del Error original. BE-08.3 autorizó
revisarlas conservando HTTP 500, JSON seguro, propagación async y una llamada.
Ahora verifican DTO JSON con event/status/errorCode/ID y ausencia de diagnóstico.
No se eliminó cobertura ni se mutó el error para eludir esas expectativas.

Se corrigieron también coerción de alias a objetos, status/code no primitivos
al logger, Promise descartada por wrappers y coerción del tipo de error parser.

La frontera terminal sola no bastaba ante múltiples next(error) tardíos: agotado
el stack, Express 5.3.0 podía registrar el Error original. Una regresión falló
y luego aprobó al proteger el callback final del dispatch en ambos modos.
Se conserva el objeto Express y el routing original; los callbacks externos
reciben un error nuevo fijo, nunca el original. La integración valida handle en
runtime y debe revalidarse al actualizar Express y en Preview.

## Evidencia actual

- Base 102/102; primera corrección 106/106; cierre **120/120**, 18 nuevas.
- npm ci, typecheck, build y diff --check aprobados.
- Diferencial: 11 compatibles y 2 cambios intencionales (404/POST health).
- Concurrencia, abortos reales, errores encadenados, streams parciales, chunked,
  framing inválido, Zod, Unicode y nesting acotado probados localmente.
- Sinks propios sin Error/Request/Response ni marcadores sensibles.
- Sin evidencia remota de Vercel/Atlas ni promesa universal de seguridad.

## Recomendación vigente

**Apta técnicamente para PR Draft: SÍ.** H01/H05 y el bypass posterior de Express
fueron corregidos. No hay hallazgos altos/críticos conocidos abiertos en el alcance
propio auditado. BE-08 no está Done y no se publicó.

Pendientes: revisión de equipo, BE-03, límites/media types, activación acordada,
Preview autorizado e integración. Logger best effort sin garantía de persistencia.
Adaptadores confiables/finito y configuración operativa requieren revisión posterior.

Rollback: nunca restaurar logs raw ni 404 reflectante. Conservar esos controles
aunque se revierta una futura migración del resto del perfil HTTP. Publicar puede
generar Preview automático; esta tarea no lo autoriza ni ejecuta.

Sin commit/push/PR/merge/deploy, Atlas, frontend/IoT, modelos, auth ni BE-09.
main/dev/ramas anteriores intactas; informe local BE-05 preservado y excluido.
