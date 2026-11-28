# INFORME BE14-02 — Alineación canónica de `eventId` extremo a extremo

Estado: `LOCAL`. `productionReady=false`. BE13 y BE14-01 no se reabrieron: solo se unificó la definición de `eventId`; no hay migración de datos ni cambios de auth/retry/rate limit/almacenamiento del outbox.

## 1. Inconsistencia (hallazgo LOW de BE14-01)
La API de reconciliación (y algunas capas de persistencia del Durable Inbox y de la cuarentena) aceptaban `.` en el `eventId` (`^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$`), mientras el parser real del payload, el esquema protegido y el trust gate exigían `^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$`. Consecuencia: la API respondía sobre ids que **nunca** podían ingerirse.

## 2. Inventario (antes)
| Ubicación | Acepta `.` | Normaliza | Usa como clave |
|---|---|---|---|
| `broker-payload.parser.ts` (`eventId`) | no | no | identidad del evento |
| `protected-ingest.schemas.ts`, `trust-gate.schemas.ts` (incl. `idempotencyKey`) | no | no | clave de idempotencia |
| `ingest-confirmation.contracts.ts` (`EVENT_ID_PATTERN`, API + servicio + logs) | **sí** | no | clave de consulta |
| `mongo-broker-inbox.store.ts` (`eventId`), validador del inbox, `recordSchema` del boundary | **sí** | no | índice `inbox_realm_source_event` |
| validador/zod de cuarentena (`declaredEventId`) | **sí** | no | lookup por principal |
| `inbox-eventid-migration.ts` | **sí** | no | backfill |
| publisher de referencia (`EVENT_ID_RE`) | no | no | identidad |
| capas de almacenamiento (`idempotency`, `measurements`, `audit`, `quarantine.eventId`) | cualquier string ≤ 256 (aguas abajo del parser) | no | clave |
Además `iot-ingest` (repo hermano) usa el mismo patrón estricto y `.` como delimitador de claves.

## 3. Definición canónica (`src/iot/event-id.ts`, única)
`^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$` — longitud **1–128**; primer carácter letra o dígito; luego letras, dígitos, `:`, `_`, `-`; **sensible a mayúsculas**; sin normalización de ningún tipo. Exporta `EVENT_ID_PATTERN`, `EVENT_ID_PATTERN_SOURCE` (para validadores BSON), `EVENT_ID_MIN/MAX_LENGTH`, `isValidEventId`, `validateEventId` (devuelve el mismo string o lanza `TypeError('INVALID_EVENT_ID')` sin eco del input) y `eventIdSchema` (zod).
| Válidos (ejemplos) | Inválidos |
|---|---|
| `device-01:1`, `device_01:2`, `ESP32-AGRO-001:42`, UUID, `a`, `0`, 128 caracteres | vacío, espacios/tabs/CR/LF/NUL, **`.`**, `/`, `\`, `..`, `%`, comillas, `$`, `{}`, `<>`, unicode (é, fullwidth, RTL, zero-width), 129 caracteres, inicio con `-`/`_`/`:` |
Longitud 128: compatible con MQTT/HTTP (ruta ≤ 1024), logs, firmware y claves únicas de Mongo (≪ 1024 bytes).

## 4. Cambios
Parser, esquemas protegidos, trust gate, validadores del inbox y de la cuarentena, zod del inbox y de la cuarentena, `recordSchema` del boundary, API/servicio/observabilidad (`EVENT_ID_PATTERN` re-exportado), clasificador de migración y publisher de referencia **importan la definición canónica**; se eliminó toda regex propia. El formato `<claveTécnica>:<seq>` del publisher ya cumplía: sin cambios en el formato, los golden vectors ni los hashes.

## 5. Compatibilidad: **tightening-compatible**
| Aspecto | Resultado |
|---|---|
| ids históricos con `.` | **ninguno posible**: el parser rechazaba `.` desde BE13-11A, así que ningún `eventId` con `.` pudo llegar al inbox, a los claims ni a las mediciones; tampoco existen fixtures válidos con `.` (el único uso es negativo) |
| datos persistidos | sin migración ni reescritura; los validadores Mongo de colecciones ya migradas siguen siendo más permisivos (inofensivo: la entrada está acotada por el parser); las colecciones nuevas nacen con el patrón estricto |
| idempotencia | sin cambios: el id del claim se deriva del `eventId` exacto (valor dorado verificado), mismo id + mismo payload = retry, mismo id + otro payload = conflict |
| impacto externo | una consulta de reconciliación con `.` ahora recibe `400 invalid-event-id` en lugar de `200 not-found`; nadie legítimo podía haber ingerido ese id |

## 6. Comportamiento ante ids inválidos
- **Payload** (parser): `payload-malformed`; no se persiste en el inbox, no se cuarentena (anti-flood), no genera medición ni identidad reconciliable. Verificado contra el boundary real.
- **API**: `400 {"error":"invalid-event-id"}` estable, sin eco del input y **sin consultar Mongo** (0 lookups); segmento vacío = ruta inexistente (404); percent-encoding inválido = `400 invalid-request`; nunca 500.
- **Logs**: `structuredLogLine` descarta el `eventId` no canónico (sin caracteres de control).

## 7. Tests
`test/be14-02-eventid-contract.test.js` (9, **una tabla de 11 válidos + 37 inválidos** aplicada a: validador, zod, parser, patrón de la API, validadores BSON del inbox y de la cuarentena, zod de cuarentena, clasificador de migración, publisher, HTTP real con conteo de lookups, boundary real —id exacto persistido, retry sin duplicar, rechazo sin rastro—, valor dorado de idempotencia, golden vectors de BE14-01, logs y escaneo que prohíbe regex propias) y `test/be14-02-mutants.test.js` (control + 5): **5/5 muertos** (M1 la API acepta `.`; M2 el parser con regex distinta; M3 normalización silenciosa; M4 el lookup ignora la validación; M5 el publisher genera un id no canónico). Sin Docker.

## 8. Findings
| Sev. | Hallazgo | Estado |
|---|---|---|
| LOW | `eventId` con definiciones divergentes (API/inbox/cuarentena más permisivos que el parser) | **resuelto** (definición única) |
| INFO | las capas de almacenamiento posteriores (`idempotency`, `measurements`, `audit`, `quarantine.eventId`) siguen aceptando strings ≤ 256 porque solo reciben ids ya validados por el parser; no se tocaron para no arriesgar la lectura de datos existentes | documentado |
| INFO | el `SAFE_WORD` del helper de logs admite `.` para nombres de evento (`publisher.transition`); no es un `eventId` | sin cambio |

## 9. Decisiones humanas
Ninguna nueva ni resuelta: auth, retry, rate limit y almacenamiento real del outbox siguen pendientes.
