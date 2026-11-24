# BE13-07 — Contrato del composition root

## Factory

```ts
createMeasurementIngestionRoot({
  realmAuthority,          // { authorizedRealm(): realm } — leída UNA vez al construir
  provenanceVerifier,      // ExternalProvenanceVerifier (BE13-02)
  hardware, temporal, catalogue,                     // autoridades BE13-03
  policies: { declaredAt, clock, missingReason, persistenceTime },   // BE13-04
  identityStore,           // IngestionIdentityStore (Mongo BE13-06 en runtime)
  persistence,             // MeasurementPersistencePort (Mongo BE13-06 en runtime)
  be12: { temporal, catalogue },   // autoridades del servicio BE-12
  deviceStatusHistory: { mode: 'current-state-only', limitation: 'DEVICE_STATUS_HISTORY_REQUIRED' },
  authorityTimeoutMs?,     // provisional
}).ingest(protectedDocument, provenanceEvidence, { field })
```

Única factory de alto nivel destinada a ensamblar BE13-02 → BE13-06. **No está montada en `app.ts`**; no hay endpoint, consumer MQTT, worker, cron ni Vercel function.

## Dependencias obligatorias

Cada dependencia debe existir con su método; si no, `TypeError` al construir. No hay defaults permisivos ni modo por variables de entorno (el módulo no lee `process.env`). El reconocimiento `deviceStatusHistory` es obligatorio y exacto: la limitación `DEVICE_STATUS_HISTORY_REQUIRED` no puede perderse en silencio.

El root construye internamente: authority de procedencia + mapper (BE13-02), servicio BE-12 con puertos de identidad sobre el mismo store y el realm autorizado, y la composición persistente (BE13-03..06).

## Realm

Proviene solo de `realmAuthority.authorizedRealm()`, leída una vez y validada contra el enum de realms. Nunca del payload MQTT, el topic, `sourceId`, `clientid` ni el id del dispositivo. Un realm inválido o una authority que lanza → `TypeError`.

## Placeholders productivos (`ingestion-production-placeholders.ts`)

`createProductionPlaceholders()` devuelve verifier de procedencia, hardware, temporal, catálogo, las cuatro políticas y las autoridades BE-12, **todos bloqueantes**. Un root construido con ellos (más stores reales) se construye, pero **no puede aceptar ninguna medición**: cada documento termina en cuarentena (R02–R09). El módulo no exporta nada que apruebe; los dobles de prueba viven solo en `test-support/`, que ningún módulo de `src/` importa (verificado).

## Resultados

Los de la composición persistente (`accepted` con `persisted:true`, `duplicate`, `quarantined`) más `{ status: 'quarantined', reason: 'mapper-rejected', cause: <código BE13-02>, eventId: null }` cuando el documento o su procedencia no pasan el mapper.

## Readiness (`describeIngestionRootReadiness`)

Diagnóstico estático y local (sin IO, sin secretos; **no es un health endpoint**). Por dependencia: `MISSING`, `BLOCKED` (placeholder registrado) o `INJECTED_UNVERIFIED` (implementación inyectada, **no verificada**). `overall`: `READY_FOR_TEST` solo si no hay ningún `MISSING` ni `BLOCKED`; nunca significa aprobación productiva. `limitations` siempre incluye `DEVICE_STATUS_HISTORY_REQUIRED`.

## Separación de confianza

- WeakSet/WeakMap (candidate, ready, placeholders): solo procedencia dentro del proceso.
- El composition root define qué implementaciones se tratan como autoridades; no autentica hardware, EMQX ni usuarios.
- La autenticación externa (verifier EMQX, atestación de hardware) sigue pendiente.
- Código hostil dentro del proceso puede construir la composición de nivel inferior o inyectar dobles permisivos; esto no es defendible desde el root (ver auditoría BE13-07A).
