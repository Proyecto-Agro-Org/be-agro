# INFORME BE13-11C — Reconciliación del Durable Inbox y contrato del adapter EMQX

Fecha: 2026-11-25. Base: `dev` `af7f86e4aacb1d56d70279b1b04e34b1ba236be9`. `main` `1bb20f76b7a739f42c75b37b9a64315276560ec1` (intacto). Todo offline / MongoDB local desechable. Sin EMQX, sin MQTT real, sin worker, sin Atlas, sin credenciales. `productionReady` = `false`.

## Resumen

N4 (escritura ambigua del inbox ⇒ registro durable sin receipt ni decisión) queda **CLOSED** para la topología local probada. Se agregó estado operativo en una colección separada, reconciliación manual con claim CAS y fencing, política BLOCKED por defecto, y el contrato offline del futuro adapter EMQX con semántica de ACK.

## Criterios de cierre de N4

| Criterio | Evidencia | Estado |
|---|---|---|
| Escritura ambigua real reproducida | C01: 7 admisiones con secundarios pausados, sin receipt | ✔ |
| El registro aparece después | C01: los 7 existen en Mongo | ✔ |
| El llamador no recibió receipt | C01 | ✔ |
| Candidato detectado | C02, R01 | ✔ |
| Integridad validada | C07, R08, A05, A06 | ✔ |
| Claim/CAS correcto | C03, R04–R05 | ✔ |
| Aislamiento por realm | C06, R03, A01, A08 | ✔ |
| Fencing | C10, C10b, A03 | ✔ |
| Recuperación = una medición | C04, R10 | ✔ |
| Ya procesado seguro | C12, R09, R23 | ✔ |
| Segundo procesamiento no duplica | C05, R11 | ✔ |
| 2 concurrentes | C08, R06 | ✔ |
| 10 concurrentes | C09, R07 | ✔ |
| Failover | C11 (3/3 + 2 corridas finales) | ✔ |
| Cleanup | `cleanupConfirmed: true` en cada corrida | ✔ |

**N4 = CLOSED** (local). No equivale a garantía en Atlas/Production, ni resuelve quién programa la reconciliación (decisiones 32, 33, 37–39).

## N1 — desfase de reloj: OPEN / BLOCKED_BY_POLICY

Relojes distintos:

| Reloj | Quién lo fija | Uso |
|---|---|---|
| `receivedAt` del adapter | Proceso del adapter (TCB) | Instante técnico de recepción |
| `rawPersistedAt` | Servidor Mongo (`$$NOW`) en la escritura del inbox | Instante de persistencia |
| `deviceTimestamp` | El dispositivo (declarado) | Independiente: no interviene en `invalid-timestamp` |
| Reloj autorizado | Autoridad temporal inyectada | Política temporal |

**Regla exacta** (`src/iot/protected-ingest.mapper.ts`): si `persistedAt < _receivedAt` ⇒ `invalid-timestamp` (fail-closed, cuarentena). Probado (R25, R27–R31):

| Caso | Resultado |
|---|---|
| BD atrasada (persistedAt < receivedAt), también −10 s y −30 días | `quarantined` `invalid-timestamp`, 0 mediciones |
| Igualdad | aceptada |
| BD adelantada (+1 ms, +1 h, +30 días) | aceptada (no hay cota superior en esta regla) |
| `deviceTimestamp` extremo (1, año 2100, cercano) | no cambia el resultado |

No se agregó tolerancia. Decisión 44 (y 36) pendientes. En el lab local los relojes son el mismo host, por lo que no valida producción.

## Qué se implementó

- `src/iot/inbox-reconciliation.contracts.ts`, `src/models/broker-inbox-state.models.ts`, `src/repositories/mongo-broker-inbox-reconciliation.store.ts`, `src/services/broker-inbox-reconciliation.service.ts`.
- `src/iot/broker-adapter.contracts.ts` (solo tipos, constante de campos prohibidos y `decideBrokerAck`).
- Admisión durable: `reconciliationStore` opcional que deja marcadores `receipted`/`completed` (best-effort).
- Placeholders: `reconciliationPolicy` BLOCKED dentro del objeto existente (no se agregaron exports).
- Audit: `inbox-reconciliation-candidate|claimed|completed|stale|integrity-failed`. Métricas: `broker_inbox_reconciliation_total`, `broker_inbox_orphan_candidate_total`. Alertas: `BROKER_INBOX_ORPHAN_DETECTED`, `BROKER_INBOX_RECONCILIATION_FAILED` (sin umbrales).
- Campaña `scripts/audit-be13-11c-multinode-local.ts` y suite `be13-11c` en el launcher.

## Resultados

| Verificación | Resultado |
|---|---|
| Pruebas funcionales BE13-11C | 32 |
| Pruebas adversariales | 17 |
| Suite completa | **983/983** (934 previas + 49) |
| HTTP | 13/13 |
| Campaña Mongo BE13-11C | **23/23 ×2** (final) + 3 corridas de estabilidad de C11, todas 23/23 |
| Regresión BE13-11B (Mongo) | 27/27 |
| Regresión BE13-11A (Mongo) | 13/13 |
| Regresión BE13-10B (Mongo) | 28/28 |
| Mutantes | 7/7 detectados (6 requeridos + 1 adicional) |
| Secret scan | 0 hallazgos |

Regresiones: se ejecutaron las tres campañas completas porque cambió código común (servicio de admisión, vocabularios de audit/métricas/alertas, launcher).

## Hallazgos y correcciones

Ver `INFORME_BE13_11C_AUDITORIA_SEGURIDAD.md` (N4, F1–F4, N1).

## Riesgos residuales

El adapter es TCB; los fingerprints no son MAC; sin revalidación de procedencia; `receipted` huérfano sin dueño; el barrido crece con el inbox; C11 se probó en Docker local; la causa del fallo previo único de C11 no está demostrada (hipótesis: carrera del harness, corregida y medida 3/3).

## Decisiones humanas

Nuevas en `MATRIZ_DECISIONES_HUMANAS_BE13.md`: 37–44 (intervalo, antigüedad, lease, ACK por QoS, QoS mínimo, mensajes veneno, `receipted` sin dueño, tolerancia de reloj). Sin elegir ninguna.
