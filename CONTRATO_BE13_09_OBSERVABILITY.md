# BE13-09 — Contrato de observabilidad (métricas, alertas, snapshot)

Fuente: `src/iot/ingestion-observability.ts`, `src/services/ingestion-operations.service.ts`. Sin proveedor externo (no Datadog, no Grafana Cloud): solo puertos.

## Métricas (`IngestionMetricsPort.increment(name, labels)`)

| Métrica | Cuándo |
| --- | --- |
| `ingestion_total` | toda ingesta por el bootstrap (`outcome` = estado del resultado) |
| `ingestion_accepted_total` | ingesta aceptada |
| `ingestion_duplicate_total` | duplicado o `recovered-committed` |
| `ingestion_quarantined_total` | alta o recurrencia en cuarentena |
| `retry_attempt_total` | decisión de la política de reintentos (`retry`/`stop`) |
| `recovery_outcome_total` | resultado de recovery |
| `quarantine_transition_total` | transición administrativa (destino o razón del rechazo) |
| `replay_total` | replay (por outcome) |
| `authorization_denied_total` | denegación de operador |

El nombre también se valida contra el conjunto cerrado antes de emitir.

### Etiquetas (baja cardinalidad, vocabulario cerrado)

Solo `stage`, `reasonCode`, `retryClass`, `outcome`. Un valor fuera del vocabulario se convierte en `'other'`; cualquier otra clave se descarta. Nunca: `realm` libre, `quarantineId`, `eventId`, `clientId`, `sourceId`, `operatorId`, mensajes de error (V5, O19; mutante M5).

## Alertas (`IngestionAlertPort.emit(event)`)

Evento saneado: `{ type, severity, reasonCode | null }`, sin identificadores.

| Tipo | Disparador en BE13-09 |
| --- | --- |
| `RETRY_EXHAUSTED` | entrada RETRYABLE tras agotar la política |
| `PERSISTENCE_INCONSISTENT` | cuarentena por inconsistencia claim/medición |
| `REALM_ISOLATION_VIOLATION` | cuarentena por dato de otro realm |
| `RECOVERY_INCONSISTENT` | recovery reporta estado inconsistente |
| `AUDIT_RESULT_MISSING` | audit de resultado falló tras cambiar el estado (transición o replay) |
| `QUARANTINE_BACKLOG_HIGH` | **reservado**: requiere umbral; ningún código lo emite |
| `AUTHORIZATION_DENIED_SPIKE` | **reservado**: requiere ventana y umbral; ningún código lo emite |

Las alertas son hechos, no umbrales. No hay enrutamiento, on-call ni umbrales: decisión humana pendiente. Una falla del audit obligatorio no tiene alerta propia: la operación devuelve `audit-unavailable`.

## Semántica best-effort

`emitMetric`/`emitAlert` se ejecutan con límite de 1 s y tragan excepciones: un adapter que lanza o nunca responde no cambia el resultado de negocio (O20). Contraste: el audit de acciones administrativas es fail-closed.

## Snapshot operativo

`bootstrap.operationalState(credential)` exige `OPERATIONS_VIEW`; usa `quarantine.summarize()` (agregación por realm) y `audit.ping()`. Devuelve solo conteos por `status/reasonCode/retryClass`, `totals` por estado, `auditHealthy`, `quarantineStoreHealthy` y `productionReady: false`. Sin identificadores ni PII (O22). `describeIngestionOperationalState` es la función pura que da forma al resultado.

## Placeholders

`createUnconfiguredMetrics()` y `createUnconfiguredAlerts()` son no-op registrados como bloqueantes: readiness `BLOCKED` y `operationsTestReady = false`.
