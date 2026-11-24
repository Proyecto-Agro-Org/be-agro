# BE13-08A — Matriz de vectores

## Offline (`test/be13-08a-adversarial.test.js`, 10/10)

| V | Vector | Resultado | Severidad |
| --- | --- | --- | --- |
| A1 | Flag `retryable`/`retryClass`/`status` en payload o selección | ignorado; seguridad → BLOCKED; política no consultada | SIN HALLAZGO |
| A2 | Forzar replay de BLOCKED; saltos de estado ilegales; replay de DISCARDED | rechazados | SIN HALLAZGO |
| A3 | `quarantineId` forjado, malformado, inyección `$ne`; registro en otro realm | `not-found` / `invalid-replay-input` / rechazo | SIN HALLAZGO |
| A4 | Recovery malicioso (otro realm, fingerprint ajeno, incompleto, getter hostil, estado desconocido) | `realm-mismatch` / conflicto / `persistence-uncertain` | SIN HALLAZGO (H3 corregido) |
| A5 | Respuesta maliciosa del store de cuarentena | `uncertain` (`quarantine-unavailable`) | SIN HALLAZGO (H3 corregido) |
| A6 | Amplificación de reintentos (siempre `retry`, acción rara, excepción) | 10 / 1 / 1 intentos | SIN HALLAZGO |
| A7 | Envenenamiento: schema sin payload, stack ni secretos; estado y contadores acotados | verificado | SIN HALLAZGO |
| A8 | Fuga de errores (URI, contraseña, stack) | ninguna | SIN HALLAZGO |
| A9 | Bypass de idempotencia en retry | misma clave y fingerprint en los 3 intentos | SIN HALLAZGO |
| A10 | Runtime: sin montaje en `app.ts`; sin env, timers, reloj ni aleatoriedad en los módulos nuevos | verificado | SIN HALLAZGO |

## Mongo real

| ID | Vector | Resultado |
| --- | --- | --- |
| Q05 | Commit ambiguo real con retraso de replicación | `duplicate` confirmado; sin cuarentena errónea (H1) |
| Q07/Q08 | Corrupción sintética de claim o medición | cuarentena de consistencia; evidencia intacta |
| Q14 | Cross-realm | aislado; mutación del filtro detectada |
| Q16–Q18 | Abuso de replay | rechazado; 0 escrituras |
| Q21 | Replays concurrentes | 1 medición |
| Q22 | Documentos de cuarentena inválidos | 9/9 rechazados |
