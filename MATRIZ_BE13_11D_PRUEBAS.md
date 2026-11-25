# MATRIZ BE13-11D — Pruebas offline y mutantes

Archivos: `test/be13-11d-adapter.test.js` (22), `test/be13-11d-adversarial.test.js` (9). Fixtures reutilizadas: `test-support/be13-11c-reconciliation.fixtures.js`. Cliente MQTT **falso** (EventEmitter que captura las opciones y ejecuta `customHandleAcks` como la librería): sin red, sin broker.

## Funcionales (22)

| ID | Qué prueba |
|---|---|
| D01 | Guard de red: solo `mqtt://` + IP loopback literal + puerto de laboratorio (rechaza `mqtts`, `ws`, `localhost`, dominios, `emqxcloud`, IP privadas, `0.0.0.0`, `127.0.0.1.evil.com`, userinfo, `mongodb+srv`, valores no string). |
| D02 | Solo credenciales `labpw-<hex>`; una configuración rechazada no crea cliente. |
| D03 | Envelope → hechos observados: bytes exactos (incluidos no UTF-8), principal del broker, sin campos de autoridad. |
| D04 | Esquema cerrado: claves extra, QoS inconsistente, usernames inválidos, base64 no canónico, UTF-8 inválido. |
| D05 | Cliente configurado para ACK diferido: MQTT 5, `clean:false`, sin reconexión, `customHandleAcks`. |
| D06 | El PUBACK se retiene hasta que el handler decide; se libera una sola vez. |
| D07 | Fallo del handler o decisión transitoria ⇒ **nunca ACK** y conexión cortada. |
| D08 | Política de mensajes veneno explícita (withhold por defecto; ack-and-drop contado); envelope inválido nunca llega al handler. |
| D09 | QoS 0 sin ACK; QoS > 0 no se procesa dos veces. |
| D10 | Nueva `connectionReference` en cada arranque. |
| D11 | **Persist-before-ack**: el registro está durable y `receipted` antes del ACK; sin medición todavía. |
| D12 | Inbox caído: sin registro, sin ACK, sin medición. |
| D13 | Principal desconocido, cruce de clave, sourceId/realm en el payload, JSON inválido, payload enorme, retained: sin inbox ni cuarentena. |
| D14 | Redelivery QoS 1: 2 registros, 1 medición. |
| R-A | Recuperación de `receipted` BLOCKED por defecto. |
| R-B | Con política TEST_ONLY: joven no se reclama; tras la edad, recuperada una vez; segunda `duplicate`; versiones 1→2→3. |
| R-C | Barrido solo bajo su política; si el dueño termina primero, la recuperación es no-op. |
| R-D | 5 recuperadores: un ganador, una medición. |
| R-E | Integridad antes de procesar. |
| R-F | Políticas inválidas ⇒ BLOCKED. |
| D15 | Readiness de laboratorio; `productionReady` siempre `false`. |
| D16 | Estructural: sin env, temporizadores, `from 'mqtt'` ni credenciales en el adapter; `app.ts` intacto. |

## Adversariales offline (9)

A01 credential stuffing (credenciales débiles ni crean cliente) · A02 clientId spoof · A03 topic spoof · A04/A05 sourceId y realm en el payload · A06–A09 retained, UTF-8 inválido, claves peligrosas anidadas, payload enorme · A10/A11 identidad de reconexión y de sesión · A12/A13 packet id reutilizado y eventId duplicado · A17/A18 `rawPersistedAt` y flags de autenticación falsos · A19 mensaje que no es del broker ⇒ *poison*.

## Mutantes (7/7)

| # | Mutación | Capa | Detectado por (fallos) |
|---|---|---|---|
| M1 | Principal tomado del `mqttClientId` | Offline | D03, D11 y otros (13 fallos) |
| M2 | ACK liberado **antes** de la decisión del inbox | Offline | D06, D07, D08, D12 (4) |
| M3 | Principal desconocido aceptado | **EMQX real** | E03/E26/E27 |
| M4 | `sourceId` aceptado desde el payload | Offline | A04 y A09 de 11A/11B, D13, A04/A05 de 11D (4) |
| M5 | Cruce de clave técnica ignorado | Offline | D26 (11B), A11 (11C), R17, D13, A02 (5) |
| M6 | Recuperación de `receipted` omitida | Offline | R-B, R-D, R-E (3) |
| M7 | Realm omitido en el claim de `receipted` | **EMQX real + Mongo** | E21c |

Línea base tras restaurar: 0 fallos. `dist` se reconstruyó antes de cada campaña.
