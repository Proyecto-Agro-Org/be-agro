# MATRIZ BE13-11J — Escenarios (`LOCAL_LAB_EVIDENCE` / tests offline)

## A. Escenarios offline (`test/be13-11j-e2e-confirmation.test.js`, modelo en memoria con la clave real `(realm, sourceId, eventId)`)
| # | Escenario | Resultado esperado | Test |
|---|---|---|---|
| 1 | contrato | 6 estados, exactamente 3 confirman, `eventId` validado, resultado inmutable | J1, J2 |
| 2 | baseline: 1 evento | publish → PUBACK → confirmación `processed`, 1 intento, sin retry | J8 |
| 3 | F-E2 simulado: PUBACK pero el backend no recibe | `not-found` → reintento con el **mismo** `eventId` → `processed`; 1 medición | J9 |
| 4 | duplicado: el primero llegó, la confirmación se perdió | reintento mismo `eventId`, **1 medición**, `duplicate-confirmed` | J5, J10 |
| 5 | stale replay: 3 entregas del mismo `eventId` | idempotente, 1 medición, confirmable | J11 |
| 6 | cuarentena | `quarantined`, no éxito, el loop termina `QUARANTINED` | J6, J12 |
| 7 | cross-tenant | B ve `not-found` idéntico a un evento inexistente, también con un store que filtra filas ajenas | J7, J20 |
| 8 | backend no disponible | evidencia caída ⇒ `pending`; HTTP 503; publisher `UNCONFIRMED_EXPLICIT` | J3, J13, J21 |
| 9 | retry agotado | por intentos y por tiempo ⇒ `UNCONFIRMED_EXPLICIT` (ni éxito ni "pérdida") | J14 |
| 10 | política | default `BLOCKED`, valores inválidos rechazados, backoff acotado | J15 |
| 11 | PUBACK nunca decide | solo PUBACK ⇒ `UNCONFIRMED_EXPLICIT` | J17 |
| 12 | HTTP | 401/403/400/200/503, `no-store`, scope no ampliable por query, sin ids internos | J19–J21 |
| 13 | desacople | router solo `TEST_ONLY`; no referenciado en `app.ts`/`http/`; adapter Mongo solo lectura, con `sourceId` en cada filtro y `majority` | J22, J23 |

## B. Mutantes (`test/be13-11j-mutants.test.js`; control sin mutar: 0 invariantes violados)
| Mutante | Cambio | Invariante que lo mata | Estado |
|---|---|---|---|
| M1 | el publisher trata PUBACK como final | INV-A | muerto |
| M2 | el reintento usa un `eventId` nuevo | INV-B | muerto |
| M3 | la confirmación acepta evento de otro tenant | INV-C | muerto |
| M4 | `pending` se interpreta como confirmado | INV-D | muerto |
| M5 | un duplicado obtiene otra identidad de idempotencia (segunda medición) — se muta `idempotencyDocumentId` real | INV-E | muerto |
| M6 | el agotamiento de reintentos se vuelve éxito | INV-F (y A) | muerto |
**Score 6/6.** Nota honesta sobre M5: se muta la función real que identifica la idempotencia, pero la propiedad "una sola medición" en Mongo la garantiza el store de BE13-06 (no modificado); la campaña EMQX lo verificó con conteo real.

## C. Campaña EMQX local única (`.local-evidence/be13-11j-J1.json`, no versionado)
Secuencia `D13 → D13b` (config histórica sin cambios) con reconciliación del publisher por el router HTTP real sobre evidencia Mongo real. Política `TEST_ONLY`: 2 s inicial, ×1,5, tope 6 s, 4 intentos, 60 s. El intento 1 es el publish original (PUBACK previo, solo `BROKER_ACCEPTED`); los intentos ≥ 2 re-publican el mismo `eventId`.
| Métrica | Valor |
|---|---|
| eventos con PUBACK del publisher | 60 |
| ventana original (sin reconciliar), como 11H/11I | 1 entregado propio, 59 no, 60 stale |
| `CONFIRMED` | **57** (54 `processed`, 2 `duplicate-confirmed`, 1 `received-durable`) |
| `QUARANTINED` | 0 |
| `UNCONFIRMED_EXPLICIT` | **3** (`d13b-7`, `d13b-13`, `d13b-16`; 4 intentos, `not-found`) |
| eventos reintentados | 59 (99 re-publicaciones) |
| confirmados tras reintento | 56 |
| eventos con > 1 medición | **0** (los 2 `duplicate-confirmed` tienen 1 medición) |
| mediciones al verificar / tras la recuperación del arnés | 56 / 57 |
| `processed` sin claim | 0 |
| sondeo cross-tenant (B pregunta por un evento de A) | `not-found`; el dueño ve `received-durable` |
| duración de la reconciliación | 67 s |
Criterio de éxito: cada `eventId` con PUBACK terminó en exactamente uno de CONFIRMED / QUARANTINED / UNCONFIRMED_EXPLICIT (60 = 57 + 0 + 3). Ninguno se asumió exitoso sin evidencia.

Lecturas y límites:
- Los 3 `UNCONFIRMED_EXPLICIT` **no son pérdida demostrada**: sus 3 reintentos no obtuvieron PUBACK (`brokerAccepted=false`). La causa probable es del arnés: 20 publishers concurrentes comparten el mismo `clientId` MQTT (`lab-device-a`) y EMQX expulsa al anterior. No se verificó con otra corrida (límite de 1 campaña).
- El proceso terminó con exit 1 por `EMQX_LAB_CONFIG_FAILED_authn_400` al configurar el *siguiente* grupo del arnés, **después** de que D13b terminó (`KNOWN_LIMITATION`, evidencia escrita y aserciones de 11J cumplidas). No hubo recursos Docker residuales.
- `d13b-0` estaba `received-durable` (inbox sin claim) cuando se consultó; la recuperación posterior del arnés lo procesó (57 mediciones).
