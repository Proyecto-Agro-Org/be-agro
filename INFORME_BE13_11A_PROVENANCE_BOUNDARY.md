# BE13-11A — Procedencia de broker y frontera MQTT de ingesta (offline)

## Resumen

Se define y prueba la frontera de confianza que un futuro adapter de broker (EMQX u otro) deberá atravesar para que una entrega llegue al pipeline BE13-02…10B. No se conectó ningún broker y no se agregaron dependencias MQTT ni de EMQX. No hay consumer, endpoints, workers ni cambios en `app.ts`. Ningún dato controlado por el dispositivo puede afirmar identidad, realm, ownership, autenticidad ni autorización.

Rama temporal `feature/be13-11a-provenance-consumer-boundary` desde `dev` `16decb500e69c91fd37856b756a8565580e0a482`. `main` `1bb20f76b7a739f42c75b37b9a64315276560ec1` sin cambios.

Decisión: `ADR_BE13_11A_PROVENANCE_TRUST_BOUNDARY.md`. Contratos: `CONTRATO_BE13_11A_BROKER_PROVENANCE.md`, `CONTRATO_BE13_11A_BROKER_IDENTITY.md`, `CONTRATO_BE13_11A_MQTT_BOUNDARY.md`.

## Archivos

| Archivo | Rol |
| --- | --- |
| `src/iot/mqtt-ingestion-boundary.contracts.ts` | Contexto observado, sobre declarado, verifier, mapping, evidencia, configuración, resultados y readiness |
| `src/iot/broker-payload.parser.ts` | Parser estructural con límites inyectables |
| `src/services/mqtt-ingestion-boundary.service.ts` | `createMqttIngestionBoundary`, `describeMqttBoundaryReadiness`, `brokerContextFingerprint` |
| `src/adapters/ingestion-production-placeholders.ts` | `createBlockingMqttBoundaryPlaceholders()` |
| `src/iot/ingestion-failure-classification.ts` | 17 códigos del boundary con clase cerrada |
| `src/iot/ingestion-observability.ts`, `src/iot/ingestion-operations.contracts.ts` | 3 métricas, stage `boundary`, 5 outcomes, 3 alertas y 5 acciones de audit |
| `src/models/ingestion-audit.models.ts`, `src/repositories/mongo-ingestion-audit.store.ts` | Acciones de audit del broker; `upgradeAuditValidatorBe1311a` (aditiva, local) |
| `scripts/audit-be13-11a-multinode-local.ts`, `scripts/be13-07-multinode-local.ps1` | E2E con Mongo real (`-Suite be13-11a`) |
| `test-support/be13-11a-broker.fixtures.js` | Fixtures sintéticos (`SINTETICO` / `TEST_ONLY`) |

## Hallazgos y correcciones

| ID | Severidad | Hallazgo | Corrección |
| --- | --- | --- | --- |
| H1 | MEDIO (arquitectura) | BE13-04 exige un instante persistido (`persistedAt`) y bloquea sin él. Un consumer MQTT directo no tiene "documento crudo persistido": sin ese dato, toda medición quedaría `BLOCKED` con `unresolved-persisted-at` | `rawPersistedAt` observado (BE13-11A). **CERRADO en BE13-11B:** el instante solo existe en el Durable Broker Inbox (`INFORME_BE13_11B_DURABLE_INBOX.md`) |
| H2 | BAJO (preexistente, BE13-06) | El doble de persistencia en memoria derivaba el `measurementId` truncando la clave: dos eventos distintos colisionaban y uno sobrescribía al otro en silencio (lo reveló P17) | `sha256` de la clave completa |
| H3 | INFORMATIVO (diseño) | Poner en cuarentena las entregas rechazadas permitiría a un publicador no autenticado inundar la cuarentena | Los rechazos del boundary no crean cuarentenas (resultado + audit + métricas) |
| H4 | INFORMATIVO | Las claves del payload en camelCase (`clientId`, `retryClass`) hacen malformado el sobre (forma de campo snake_case) | Comportamiento fail-closed documentado; el contrato del dispositivo debe usar snake_case |

## Riesgos residuales

- **TOCTOU de procedencia:** no se revalida entre la verificación y el commit.
- **Adapter comprometido:** el boundary no puede detectar hechos observados falsos. La calidad depende del verifier y del adapter (decisión pendiente).
- **Bypass en proceso:** código que construya su propio bootstrap con un verifier permisivo no pasa por el boundary. La frontera de confianza sigue siendo quien compone el runtime.
- **Volumen del audit:** el stream `realm` concentra contención con mucho tráfico (`auditVerifiedDeliveries` pendiente de decisión).
- **La evidencia emitida es reutilizable** dentro del proceso mientras viva el objeto. Está atada a la identidad exacta y no autentica nada fuera del proceso.
- **Docker local no equivale a Atlas;** no hay broker real.

## Estado

| Categoría | Elementos |
| --- | --- |
| IMPLEMENTADO | Contratos, parser, boundary, normalización, clasificación, audit, métricas, alertas, readiness, placeholders |
| PROBADO | 897/897 offline (38 nuevas); Mongo E2E 13/13 × 2; regresión BE13-10B 28/28; 6/6 mutantes; HTTP 13/13 |
| PENDIENTE (decisión humana) | Mecanismo de autenticación, tipo de credencial, mTLS, ACL de topics, política de retained, límites productivos, timeout del verifier, fuente de identidad, gestión de secretos, inbox durable, volumen del audit |
| BLOCKED | EMQX real, Atlas, hardware |
