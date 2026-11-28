# MATRIZ BE13-11C — Pruebas offline

Todo SINTÉTICO, TEST_ONLY. Archivos: `test/be13-11c-reconciliation.test.js` (32), `test/be13-11c-adversarial.test.js` (17). Fixtures: `test-support/be13-11c-reconciliation.fixtures.js`.

## Funcionales (32)

| ID | Qué prueba |
|---|---|
| R01 / R01b | Candidato detectado solo tras la antigüedad de la política (reloj de BD); un registro joven no es candidato. |
| R02 | Un registro confirmado no se considera perdido; sus bytes quedan idénticos tras inspect, reconcile y recuperación. |
| R03 | Realm distinto: store, scan y claim no ven nada; el constructor rechaza realm ≠ admisión. |
| R04 | Claim exitoso (versión 1, token) y un segundo claim vigente es rechazado. |
| R05 | Claim vencido → takeover (versión 2); el titular anterior no puede completar; completed es final. |
| R06 / R07 | 2 y 10 reconciliadores concurrentes: un solo ganador, una medición. |
| R08 | Integridad fallida: no se procesa, resultado pegajoso (`duplicate` al reintentar), alerta y audit. |
| R09 | Ya procesado: `already-processed`, sin segunda medición. |
| R10 / R11 | Recuperado y procesado una sola vez; segunda reconciliación `duplicate`. |
| R12 | Crash tras claim: takeover tras el lease; el titular viejo queda fuera; una medición. |
| R13 | Audit: candidate/claimed/completed sin payload, topic ni ids. |
| R14 | Métricas con labels cerrados. |
| R15 | `inspect-only` no muta nada. |
| R16 | Límite de barrido respetado; límites inválidos (0, 501, no entero, string, Infinity) rechazados; `maxBatch` de la política acota. |
| R17 / R18 | Contrato del adapter: sin clientId de negocio ni realm derivado/enviado por el adapter. |
| R19 | QoS 0: falla de persistencia ⇒ `loss-possible-qos0`, nunca "reintentable". |
| R20 | QoS 1: redelivery ⇒ 2 registros, 1 medición. |
| R21 | Política BLOCKED por defecto (placeholder y valores inválidos): nada se lista, reclama ni procesa. |
| R22 | Admisión normal deja marcador y completion; esos registros no son candidatos. |
| R23 | Marcador perdido ⇒ candidato ⇒ `already-processed`. |
| R24 | `persist-only` deja `receipted`: no reclamable. |
| R25, R27–R31 | N1: reglas exactas de `invalid-timestamp` (ver informe), igualdad aceptada, reloj de BD adelantado aceptado, `deviceTimestamp` independiente, skew extremo, registro intacto. |
| R26 | Store o inbox no disponible: nada final; recuperación posterior correcta. |

## Adversariales (17)

| ID | Vector |
|---|---|
| A01 | Realm falsificado en store/claim/scan/count. |
| A02 | Estado de reconciliación falsificado / ids inventados. |
| A03 | Token o versión stale. |
| A04 | Completion directa sin claim. |
| A05 | Manipulación de bytes, contexto, hash. |
| A06 | Manipulación de procedencia (verifiedAt, revisión, sourceId, principal). |
| A07 | Dos completions concurrentes: una gana. |
| A08 | Barrido entre realms. |
| A09 | Respuestas maliciosas del store (claim ajeno, forma inválida, `complete` truthy no `true`, candidatos/conteos inválidos). |
| A10 | Fuga de payload hacia audit/métricas/alertas/reporte. |
| A11 | Adapter envía clientId de negocio. |
| A12 | Adapter envía `trusted`/`verified`. |
| A13 | Realm derivado del topic. |
| A14 | Principal autenticado falso. |
| A15 | `packetId` como identidad. |
| A16 | Estructural: sin worker, cron, polling, MQTT, env, borrado, TTL; `app.ts` intacto. |
| A17 | El reconciliador no acepta payload nuevo. |

## Mutantes (7: 6 requeridos + 1 adicional)

| # | Mutación | Capa | Detectado por |
|---|---|---|---|
| M1 | Realm fuera del scan del store Mongo | Mongo real | C06 (4 checks pasaron antes de fallar) |
| M2 | CAS fuera del primer claim | Mongo real | C05 (8 checks antes) |
| M3 | Hash crudo no comparado en recuperación | Offline | A04, A05 (2 fallos) |
| M4a | Completion stale aceptada (respuesta ≠ `undefined` cuenta) | Offline | A09 (1 fallo) |
| M4b | `complete()` sin token/versión | Mongo real | C10b (14 checks antes) |
| M5 | Detección `already-processed` ignorada | Offline | R09, R23 (2 fallos) |
| M6 | `integrity-failed` reintentable (sin completion pegajosa) | Offline | R08 (1 fallo) |

Un primer intento de M4b **sobrevivió**: la campaña no tenía una completion stale mientras el estado seguía `claimed`. Se agregó C10b y el mutante murió. Línea base restaurada: 81/81 en los 4 archivos de pruebas relevantes.
