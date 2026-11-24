# BE13-06 — Contrato de idempotencia persistente

## Clave lógica (aceptada)

`realm + sourceId + operation + eventId + field`

Un evento técnico puede producir varias mediciones lógicas (un campo del payload cada una); por eso `field` es parte de la clave. El realm proviene solo del contexto de composición.

## Fingerprint técnico (aceptado)

SHA-256 hex de JSON canónico (claves ordenadas recursivamente, arrays en orden, sin normalización Unicode) de exactamente: versión, `realm`, `sourceId`, `storeOperation`, `operation`, `eventId`, `TechnicalDeviceKey {kind, value}`, `field`, payload técnico completo, `deviceTimestamp`, `sentAt`.

Excluye: `receivedAt`, `persistedAt`, topic, identidad de broker, flags de procedencia y todo resultado de autoridades. Es una huella de consistencia de contenido; **no** es autenticación, firma ni MAC.

## Semántica

| Situación | Resultado | Escritura |
| --- | --- | --- |
| Clave nueva | `accepted`, `persisted: true`, `measurementId` | 1 claim + 1 medición, misma transacción |
| Retry exacto (mismo fingerprint; otra recepción) | `duplicate` + `measurementId` existente | ninguna |
| Misma clave, fingerprint distinto | `quarantined` / `idempotency-conflict` | ninguna |
| Misma clave en otro realm / otra fuente / otro campo | clave distinta → procesamiento independiente | — |
| Store caído, documento malformado o manipulado | `quarantined` / `persistence-unavailable` | ninguna |

No se distingue "retry de transporte" de "duplicado semántico" por canal: ambos se identifican por clave; el fingerprint decide si es el mismo contenido (`duplicate`) o no (`conflict`). **No hay exactly-once global**: la garantía es local a este store y a su transacción.

## Documento de claim (`<prefix>_idempotency`)

| Campo | Tipo | Nota |
| --- | --- | --- |
| `_id` | string hex 64 | SHA-256 de `JSON.stringify(['be13-06/v1', realm, sourceId, operation, eventId, field])` (codificación sin colisiones por concatenación) |
| `realm`, `sourceId`, `operation`, `eventId`, `field` | string | clave lógica explícita |
| `fingerprint` | hex 64 | fingerprint técnico |
| `state` | `'committed'` | no existe estado pendiente fuera de una transacción |
| `measurementId` | `m_` + hex 64 | referencia determinista a la medición |
| `committedAt` | date | hora técnica del servidor (`$currentDate`) |

Al leer un claim se valida su forma y que sus campos coincidan con la clave consultada; si no (colisión o manipulación) → error → `persistence-unavailable`.
