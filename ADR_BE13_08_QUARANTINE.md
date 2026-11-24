# ADR BE13-08 — Cuarentena persistente y replay

Estado: **ACEPTADA para el entorno local** (no habilita runtime ni procesamiento en background). Fecha: 24/11/2026.

## Decisión

1. **Cuarentena persistente y sanitizada** (`<prefix>_quarantine`) con `$jsonSchema` estricto y `additionalProperties: false`. Guarda solo identidad técnica (`realm`, `stage`, `sourceId`, `operation`, `eventId`, `field`, `TechnicalDeviceKey`), código de motivo, causa cerrada, clase, fingerprint técnico o digest de documento, estado, contadores, fechas técnicas del servidor y una auditoría acotada (100 entradas). **Nunca** guarda payload, stack, mensajes, secretos, `x-emqx-key`, URIs ni tokens: el schema los rechaza.
2. **Dedupe**: `quarantineId = 'q_' + SHA-256(['be13-08/q1', realm, stage, sourceId, operation, eventId, field, reasonCode, documentDigest-si-no-hay-eventId])`. El mismo fallo repetido incrementa `attemptCount` y agrega una entrada de auditoría. Si no hay `eventId` (documento rechazado por el mapper), se usa el digest SHA-256 de una canonicalización del documento; el documento no se almacena.
3. **Estados y transiciones** (máquina de estados; actualizaciones condicionadas al estado actual):
   - `OPEN` → `RETRYABLE` | `BLOCKED` | `DISCARDED`
   - `RETRYABLE` → `RETRYABLE` | `RESOLVED` | `BLOCKED` | `DISCARDED`
   - `BLOCKED` → `RETRYABLE` (solo con evidencia explícita y solo para `policy-blocked`/`unknown`) | `DISCARDED`
   - `RESOLVED`, `DISCARDED`: terminales.

   Estado inicial: `transient`/`ambiguous-commit` → `RETRYABLE`; `unknown` → `OPEN`; resto → `BLOCKED`. Los fallos `security`, `validation`, `conflict` y `consistency` nunca pueden volver a `RETRYABLE`. Las decisiones humanas pendientes (clock, `declaredAt`, `missingReason`, `persistedAt`, catálogo, `DEVICE_STATUS_HISTORY_REQUIRED`) quedan como `policy-blocked` = **BLOCKED_BY_POLICY**.
4. **Replay explícito, nunca automático** (`replay({ quarantineId, protectedDocument, provenanceEvidence, field })`). Exige:
   - entrada en el realm del root y en estado `RETRYABLE`;
   - **volver a presentar el documento original y su evidencia de procedencia**: la cuarentena no guarda el payload, así que no hay forma de "editarlo para que pase";
   - misma identidad técnica (`sourceId`, `operation`, `eventId`, `field`, clave de dispositivo) y **mismo fingerprint técnico**. Un contenido distinto se rechaza (`replay-fingerprint-mismatch`) y no muta la evidencia.

   El replay ejecuta el mismo pipeline resiliente (recovery incluido). Resultado exitoso → `RESOLVED`; nuevo fallo no reintentable → `BLOCKED`; transitorio → sigue `RETRYABLE`. Cada intento queda en la auditoría.
5. **Realm** en cada filtro y en la identidad de la cuarentena; un store de otro realm no ve ni modifica entradas ajenas.
6. **Índices**: `_id` (dedupe), `quarantine_realm_status` (realm, status, updatedAt) y `quarantine_realm_event` (realm, eventId). Planes verificados con `explain` en Mongo real.

## Qué no se garantiza

- La cuarentena no es una DLQ con reprocesamiento automático: no hay worker, cron ni scheduler real.
- La autorización de quién puede ejecutar `transition`/`replay` corresponde al futuro runtime (no hay endpoint).
- Si el propio store de cuarentena no está disponible, el resultado es `uncertain` (`quarantine-unavailable`) y el llamador debe reintentar con la misma entrada.
