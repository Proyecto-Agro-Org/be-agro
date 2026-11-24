# BE13-05 — Composición offline de ingesta

## Resumen

Composición pura y fail-closed BE13-02 → BE13-03 → BE13-04 → BE-12 que resuelve, en el plano offline, las brechas A1 (reconciliación con BE-12), A3 (idempotencia por evento) y el aislamiento por realm en adapters. No está compuesta en runtime ni persiste.

- Rama `feature/be13-05-composition`, worktree `.local-consolidacion/be13-05`.
- Base `origin/dev` `743ae55b078b197c4bf79e45109a1ab1a317c411` (merge de BE13-04, PR #24).

## Archivos

| Archivo | Rol |
| --- | --- |
| `src/services/measurement-ingestion-composition.service.ts` | Composition root y coordinador |
| `src/iot/ingestion-composition.contracts.ts` / `.schemas.ts` | Store, idempotencia, BE-12, resultados |
| `src/iot/ingestion-event-fingerprint.ts` | Fingerprint técnico de idempotencia |
| `src/adapters/ingestion-identity.adapters.ts` | Adapters realm-scoped para BE13 y BE-12 |
| `src/adapters/ingestion-idempotency-blocking.adapter.ts` | Idempotencia por defecto bloqueante |
| `src/services/authority-call.ts` | Se exporta `runBounded` (sin cambio de comportamiento) |
| `test-support/be13-composition.fixtures.js` | Dobles sintéticos (store e idempotencia en memoria) — no productivos |
| `test/be13-05-*.test.js` | 30 funcionales, 10 E2E, 13 adversariales |

## Adapters sobre BE-11 — decisión conservadora

El `SensorRepository` de BE-11 es client-scoped (`BusinessScope = realm + clientId`) y no expone búsqueda por clave técnica dentro de un realm ni asociación en un instante. Además exige Mongo con replica set, no ejecutable offline. En lugar de inventar consultas no probadas sobre colecciones BE-11, se definió `IngestionIdentityStore` (lectura, realm obligatorio, filas con realm) y los adapters se construyen sobre él. Los documentos BE-11 ya contienen `realm`, por lo que una implementación Mongo es directa, pero queda **PENDIENTE** (extensión de contrato BE-11 + pruebas contra Mongo real). El dispositivo BE-11 es client-scoped; su `clientId` actual nunca se usa para atribuir.

## A1 — reconciliación con BE-12

BE-12 se ejecuta sin modificar y su resultado se compara campo por campo con la expectativa de BE13-04 (evento completo, identidad, asociación, revisión, instante, clock, realm). Cualquier diferencia → `attribution-drift` y no se consume la clave de idempotencia.

## A3 — idempotencia

Lookup previo de solo lectura (los retries conocidos no reejecutan autoridades) y `claim` atómico como último paso (un pipeline fallido nunca consume la clave; carreras resueltas por el adapter: probado con 4 ingestas concurrentes → 1 `accepted`, 3 `duplicate`). La clave incluye el campo porque cada campo del payload es una medición lógica distinta.

**Supuesto conservador documentado:** cuando exista persistencia, `claim` y escritura deberán ser atómicos (o el claim liberable), porque un claim sin escritura haría que un retry legítimo se responda como `duplicate` sin medición persistida.

## Realm

Proviene solo de `realmContext`. Probado: filas de otro realm invisibles (store) o detectadas (filtración → `realm-mismatch`), idempotencia de otro realm (`realm-mismatch`), BE-12 de otro realm (`realm-mismatch`), mismo `eventId` en otro realm independiente, realm en payload ignorado.

## Políticas humanas

Sin decisiones de negocio nuevas: clock, declaredAt, missingReason, persistedAt, historial de estado de dispositivo, catálogo productivo y atestación de hardware siguen BLOQUEADOS. Las pruebas positivas usan políticas sintéticas explícitas.

## TOCTOU

Minimizado (gate con doble lectura, builder con revalidación, BE-12 con su propia doble lectura, reconciliación, claim al final), **no eliminado**: no hay transacción única. Un resultado `accepted` es una instantánea.

## Estado

| Categoría | Elementos |
| --- | --- |
| IMPLEMENTADO | Composition root, adapters realm-scoped, idempotencia (puerto + fingerprint + bloqueante), reconciliación A1 |
| PROBADO | 30 + 10 E2E + 13 adversariales; suite 664/664; HTTP 13/13; mutación de 3 controles detectada |
| PENDIENTE | Store Mongo sobre BE-11; idempotencia persistente atómica; persistencia de mediciones; bootstrap |
| BLOQUEADO | Políticas productivas; `DEVICE_STATUS_HISTORY_REQUIRED`; catálogo BE-04; hardware; EMQX/Atlas |
| NO VERIFICABLE | Código hostil en proceso; autoridades que mienten de forma consistente; aislamiento real de realm en almacenamiento |
