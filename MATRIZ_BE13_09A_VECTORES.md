# BE13-09A — Matriz de vectores

## Offline (`test/be13-09a-adversarial.test.js`, 8/8)

| V | Vector | Resultado | Severidad |
| --- | --- | --- | --- |
| V1 | `operatorId`, roles, capacidades o realm forjados en la credencial o en la entrada | ignorados; solo cuenta el principal del puerto | SIN HALLAZGO |
| V2 | `quarantineId` de otro realm, forjado o malformado | `quarantine-not-found` / `invalid-request` | SIN HALLAZGO |
| V3 | Evidencia con `issuedBy`/`verification` propios, texto libre, metadatos enormes | rechazada (`evidence-required`) | SIN HALLAZGO |
| V4 | Envenenamiento de audit: payload, stack, secretos, valores fuera de rango; métodos update/delete | rechazados por Zod y `$jsonSchema`; el store no los expone | SIN HALLAZGO |
| V5 | Inyección de cardinalidad en etiquetas; fuga de payload en alertas | `'other'` / claves descartadas; alerta solo `{type, severity, reasonCode}` | SIN HALLAZGO |
| V6 | Respuestas malformadas del audit store (`undefined`, otro realm, id inválido, secuencia 0) | nunca cuentan como audit durable → `audit-unavailable` | **S1 corregido** |
| V7 | Replays repetidos y replay tras resolución | rechazados; una sola medición | SIN HALLAZGO |
| V8 | Endpoints, workers, timers, variables de entorno | ausentes | SIN HALLAZGO |

## Mongo real

| ID | Vector | Resultado |
| --- | --- | --- |
| O15 | Lectura/escritura de audit cruzando realm | vacío / rechazo |
| O16 | Inserción directa con payload crudo | rechazada (121) |
| O17 | Inserción directa con stack, `x-emqx-key`, sin realm, acción/outcome inválidos, secuencia 0/−1 | rechazadas (121) |
| O18 | Audit no disponible durante acción administrativa | acción bloqueada, estado intacto |
| O10 | CAS con versión vieja directo al store | `stale` |
| O11–O13 | Carreras administrativas | un solo ganador; sin estados imposibles |
