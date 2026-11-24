# BE13-10B — Matriz de vectores

## Offline (`test/be13-10b-adversarial.test.js`, 13/13)

| V | Vector | Resultado | Severidad |
| --- | --- | --- | --- |
| A01 | `ownerId` o `operatorId` forjados en la credencial o el input; `lease` en el input del replay | el dueño siempre es el `operatorId` autorizado | SIN HALLAZGO |
| A02 | `acquiredAt` aportado por el llamador | ignorado; vale la autoridad temporal | SIN HALLAZGO |
| A03 | Realm forjado; store de otro realm | `realm-out-of-scope` / `not-found` / `stale` | SIN HALLAZGO |
| A04 | Autoridad temporal malformada (string, `Infinity`, estado desconocido, excepción, getter hostil) | sin adquisición | SIN HALLAZGO |
| A05 | Política maliciosa (`EXPIRED` de otro realm, campos extra, getter hostil, `always`) | sin recuperación | SIN HALLAZGO |
| A06 | Replay stale del **mismo dueño** con un token anterior | cercado; el lease nuevo queda intacto | SIN HALLAZGO (el token distingue adquisiciones) |
| A07 | Replay tras intentar descartar | discard de `REPLAYING` rechazado; replay de `DISCARDED` rechazado | SIN HALLAZGO |
| A08 | Liberación directa en el store (dueño, token o versión equivocados; `transition` genérico) | `stale` / `not-allowed` | SIN HALLAZGO |
| A09 | Saltarse el audit (append que falla, recibo vacío, recibo de otro realm) | sin liberación ni recuperación | SIN HALLAZGO |
| A10 | Capacidad inyectada en la credencial | ignorada | SIN HALLAZGO |
| A11 | Reutilizar el token de lease | stale en `settle`, en el fence y en el replay; tokens monotónicos | SIN HALLAZGO |
| A12 | Numéricos inválidos (0, negativos, fraccionarios, NaN, ≥ 2^53, strings, null) | `invalid-replay-input` / `invalid-request`; validator con min 1 y max 2^53−1 | SIN HALLAZGO |
| A13 | Worker, timer, reloj, env o aleatoriedad en el código de lease; montaje en `app.ts` | ausentes | SIN HALLAZGO |

## Mongo real

| ID | Vector | Resultado |
| --- | --- | --- |
| B04 | Realm ajeno sobre Mongo | `not-found` (el mutante M5 lo rompe) |
| B14 / B17 / B27 | Escritura stale por carrera real | bloqueada en la transacción (el mutante M6 lo rompe) |
| B19 / B20 | Lease forjado o incoherente insertado directamente | 121 |
| B24 | Saltarse el audit | `audit-unavailable` |
