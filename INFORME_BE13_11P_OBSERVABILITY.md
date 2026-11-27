# INFORME BE13-11P — Observabilidad mínima del pipeline

Estado: `LOCAL`, solo helpers y contratos de observabilidad; **no se configuró ningún entorno, backend de métricas ni alerta**. `productionReady=false`.

## Catálogo mínimo (nombre real de la métrica)
| Pedido | Métrica | Origen |
|---|---|---|
| published | `publisher_event_published_total` | publisher (11P, `outboxTransitionMetrics`) |
| brokerAccepted | `publisher_broker_accepted_total` | publisher |
| delivered | `broker_adapter_delivery_total{outcome=received}` | adapter (existente 11D) |
| durableReceived | `broker_inbox_persist_total{outcome=persisted}` | boundary (existente 11B) |
| processed | `broker_inbox_recovery_total{outcome=processed}` / `ingestion_accepted_total` | boundary/composición (existentes) |
| duplicateConfirmed | `ingest_confirmation_total{outcome=duplicate-confirmed}` | **nuevo**, servicio de confirmación |
| quarantined | `ingest_confirmation_total{outcome=quarantined}` / `ingestion_quarantined_total` | nuevo / existente |
| conflict | `ingest_confirmation_total{outcome=conflict}` | nuevo |
| retry | `publisher_retry_total{lane}` | publisher |
| unconfirmed | `publisher_unconfirmed_total` (carril rápido agotado) | publisher |
| retry exhausted | `publisher_retry_exhausted_total` (`UNCONFIRMED_EXPLICIT`) | publisher |
| outbox depth / oldest age | `publisher_outbox_depth`, `publisher_outbox_oldest_pending_age_ms` | publisher (`sampleOutbox`) |
| reconciliation latency | `publisher_reconciliation_latency_ms` (createdAt → CONFIRMED) | publisher |
| rate-limit denied | `ingest_confirmation_request_total{outcome=rate-limited}` | nuevo, observador del router |
| cross-tenant denied | **no observable por diseño** (ajeno ≡ inexistente) | — |
Extra: `ingest_confirmation_evidence_unavailable_total{outcome=evidence-claim|inbox|quarantine}` (visibilidad previa a una tormenta de `pending`) y `ingest_confirmation_request_total{outcome=ok|unauthenticated|forbidden|invalid-input|uri-too-long|error}`.

## Reglas
- **Vocabularios cerrados:** las métricas del backend pasan por `sanitizeMetricLabels` (valor desconocido ⇒ `other`); jamás un `eventId`, `sourceId`, hash o principal como label (cardinalidad no acotada y fuga entre tenants). Las métricas del publisher tampoco llevan identificadores (solo `lane`/`status` cerrados).
- **Logs:** `structuredLogLine` construye la línea desde una allowlist (`ts, component, event, eventId, sourceId, from, to, lane, attempt, status, outcome`); todo lo demás se descarta (secretos, hashes, payload, principal, cadenas de conexión) y los identificadores mal formados se eliminan. Un fallo del puerto de métricas o del observador nunca cambia una respuesta.
- **Correlación:** la clave es `(sourceId, eventId)`; `correlate()` reconstruye `published → broker-accepted → delivered → inbox-persisted → processed → confirmed` (más `retry/unconfirmed/quarantined/conflict`) sin mezclar tenants. Los registros de auditoría del boundary ya llevan `eventId` (`inbox-persisted`, `inbox-processed`).
- **Alertas:** `CANDIDATE_ALERT_THRESHOLDS` (7 candidatas) con `configured:false, approved:false`: edad del pendiente más viejo > carril rápido, `UNCONFIRMED` > 0, `UNCONFIRMED_EXPLICIT` > 0 (crítica), profundidad > 80 % de capacidad, rate-limited sostenido, conflicts, evidencia no disponible sostenida. Necesitan aprobación junto con la política de retry.

## Tests
`test/be13-11p-observability.test.js` (6): vocabulario cerrado y sin identificadores; observador del router (y resistencia a un puerto caído); métricas/gauges/latencia del publisher; logs con allowlist; correlación sin mezcla de tenants; umbrales marcados como candidatos. Suite verde.

## Límites
No hay exportador (Prometheus/OTel) ni dashboards: solo el contrato de qué se emite y con qué vocabulario. La observabilidad end-to-end del lado dispositivo depende de la integración real del publisher (decisión humana).
