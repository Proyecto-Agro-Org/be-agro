# BE13-11A — Contrato de la frontera MQTT de ingesta

Fuentes: `src/services/mqtt-ingestion-boundary.service.ts`, `src/iot/broker-payload.parser.ts`.

## Factory

```ts
createMqttIngestionBoundary(deps: MqttIngestionBoundaryDependencies): MqttIngestionBoundary
// deps = dependencias del bootstrap de operaciones SIN provenanceVerifier
//      + brokerProvenanceVerifier + brokerIdentityMapping + payloadLimits + boundaryConfig
boundary.deliver(raw) → BoundaryResult           // 'ingested' | 'rejected'
boundary.admitForReplay(raw) → BoundaryAdmission // misma verificación; evidencia para un replay operado
boundary.operations / boundary.readiness / boundary.realm
```

Es solo callable: no hay conexión, suscripción, reconexión, keepalive, URLs, credenciales ni TLS.

## Flujo (en este orden)

1. Configuración: placeholder o inválida → `boundary-not-configured`. La configuración y los límites se copian validados una sola vez, al construir el boundary.
2. Forma de la entrega, cerrada (`{ brokerObserved, payload: Uint8Array }`) → `broker-context-malformed`. Los bytes se copian.
3. Parser:
   - tamaño **antes** de hashear o decodificar → `payload-too-large`;
   - UTF-8 estricto → `payload-invalid-utf8`;
   - JSON → `payload-malformed`;
   - `__proto__`, `constructor`, `prototype` en cualquier nivel → `payload-dangerous-key`;
   - profundidad, cantidad de claves y longitud de strings → `payload-limits-exceeded`;
   - números no finitos o sobre cerrado inválido → `payload-malformed`.
   - Nunca hay coerción: `"0"` sigue siendo string.
4. `retain && retained !== 'accept'` → `retained-message-blocked`.
5. El topic debe empezar con un prefijo de `topicRoutes` y el `messageType` declarado debe coincidir → si no, `topic-not-routed`.
6. Procedencia (`CONTRATO_BE13_11A_BROKER_PROVENANCE.md`).
7. Identidad (`CONTRATO_BE13_11A_BROKER_IDENTITY.md`).
8. Campos: los de `fields` presentes en el payload. Si no hay ninguno → `no-configured-field`.
9. Normalización al documento protegido de BE13-02:
   - `sourceId`, `clientid` y `technicalClientId` vienen de la evidencia;
   - `topic`, `_receivedAt` y `persistedAt` vienen de lo observado;
   - `deviceTimestamp`, `sentAt` y `dataOrigin` son claims declarados;
   - `brokerIdentity` es `broker-assertion-config-verified`.
10. Evidencia emitida, que solo acepta el verifier interno del pipeline. Después, `ingest` por campo a través del bootstrap BE13-09/10B: mapper, gate, builder, BE-12, persistencia, reintentos, cuarentena y operaciones.

## Configuración (sin valores productivos)

| Elemento | Forma | Valor de prueba (`TEST_ONLY`) |
| --- | --- | --- |
| `payloadLimits` | `maxBytes` ≤ 16 MiB, `maxDepth` ≤ 64, `maxKeys` ≤ 100k, `maxStringLength` ≤ 1M | 4096 / 8 / 64 / 256 |
| `boundaryConfig.topicRoutes` | prefijos sin comodines → `telemetry` | `synthetic/agro/` |
| `boundaryConfig.retained` | `block` \| `accept` | `block` |
| `boundaryConfig.fields` | claves de campo | `['temperature']` |
| `boundaryConfig.verifierTimeoutMs` | 1–60 000 | 50 |
| `boundaryConfig.auditVerifiedDeliveries` | booleano (volumen pendiente) | `true` |

## Resultados, audit, métricas y alertas

- **Rechazos:** `{ status: 'rejected', reasonCode, retryClass, retryable, payloadFingerprint }`. La clase sale **solo** de `classifyIngestionFailure`. No crean cuarentenas.
- **Audit** (best-effort; sin payload, credenciales ni tokens; actor `broker-boundary`):
  - `broker-delivery-malformed`;
  - `broker-provenance-rejected` (incluye no verificado, principal desconocido, realm, contexto y respuesta inválida);
  - `broker-verifier-unavailable`;
  - `technical-identity-mismatch`;
  - `broker-provenance-verified`, solo si `auditVerifiedDeliveries`.
- **Métricas:** `broker_delivery_total` (`ingested` / `rejected`), `provenance_result_total` (`verified` / `unverified` / `rejected` / `unavailable`), `mqtt_boundary_rejected_total` (`reasonCode`, `retryClass`). Llevan el stage `boundary` y ningún identificador.
- **Alertas** (son hechos, no hay umbrales): `BROKER_VERIFIER_UNAVAILABLE`, `TECHNICAL_IDENTITY_MISMATCH`. `PROVENANCE_REJECTION_SPIKE` queda reservada porque requiere un umbral.

## Readiness

`describeMqttBoundaryReadiness` reporta `brokerProvenanceVerifier`, `brokerIdentityMapping`, `payloadLimits` y `boundaryConfig` como `MISSING`, `BLOCKED` o `INJECTED_UNVERIFIED`, además de la readiness de operaciones. `productionReady` es el literal `false`. Las limitaciones incluyen `NO_BROKER_CONNECTION` y `PROVENANCE_NOT_REVALIDATED_BEFORE_PERSISTENCE`.

## Placeholders

`createBlockingMqttBoundaryPlaceholders()` provee un verifier que nunca verifica, un mapping sin principales, límites mínimos y una configuración sin rutas ni campos con retained bloqueado. Con ellos el boundary no admite ninguna entrega.
