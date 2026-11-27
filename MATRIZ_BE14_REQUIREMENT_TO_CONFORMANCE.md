# MATRIZ — Requisito → contrato → referencia → test de conformidad → componente de firmware (BE14-05)

Lectura: cada `REQ-*` de `ESPECIFICACION_BE14_FUTURE_PUBLISHER_REQUIREMENTS.md` aparece **una vez** aquí. Componentes futuros (`FW-*`) están definidos en `PLAN_BE14_FIRMWARE_IMPLEMENTATION.md`. Referencia = `scripts/be14-01/` (`reference-publisher.ts` = RP, `mqtt-port.ts` = MP). Tests del kit = `scripts/be14-03/catalog.ts` (L0–L5). Un test de `test/*.test.js` de la referencia se marca `REF`.

| REQ | Clase | Sección de contrato | Referencia | Test de conformidad | Componente futuro |
|---|---|---|---|---|---|
| REQ-ID-01 | MUST | BE13 §2; OUTBOX regla 11 | MP `createSingleConnectionGuard` | L1-04 | FW-04 |
| REQ-ID-02 | MUST | BE13 §2; parser sobre cerrado | RP `encodeEvent` | L0-03, L5-03 | FW-02 |
| REQ-ID-03 | PENDING_PRODUCT_DECISION | BE13 §8 (fila 73) | — | — | FW-01 |
| REQ-EID-01 | MUST | BE14-02 §3 | RP `EVENT_ID_RE` → `src/iot/event-id.ts` | L0-02, L0-09 | FW-02 |
| REQ-EID-02 | MUST | BE13 §3; OUTBOX regla 4 | RP `submitReading`/`tick` | L2-01 | FW-03, FW-06 |
| REQ-EID-03 | MUST | BE13 §7 | RP generador `nextSeq` | L0-02, L3-04, L4-05 | FW-02 |
| REQ-EID-04 | MUST | BE14-02 §3 | RP (secuencia, no reloj) | L3-05 | FW-02 |
| REQ-EID-05 | MUST | BE13 §7; OUTBOX regla 1 | RP `REJECTED_EVENT_ID_REUSED_WITH_OTHER_BYTES` | **L0-09 (ampliado en BE14-05)**; REF be14-01 | FW-03 |
| REQ-EID-06 | MUST | OUTBOX registro (`nextSeq` atómico) | RP stores | L3-04, L3-02 | FW-02, FW-03 |
| REQ-EID-07 | SHOULD | OUTBOX §registro | RP `<key>:<seq>` | — (estrategia de referencia) | FW-02 |
| REQ-TS-01 | MUST | BE14-03 §4 | RP `encodeEvent` (`INVALID_DEVICE_TIMESTAMP`) | L0-06, L0-03 | FW-02 |
| REQ-TS-02 | SHOULD | BE14-03 §4 (epoch ms por convención) | vectores | L0-01 | FW-02 |
| REQ-TS-03 | MUST | BE13 §2 (bytes exactos) | RP | L2-01, L0-03 | FW-02, FW-03 |
| REQ-TS-04 | PENDING_PRODUCT_DECISION | `MATRIZ_BE13R_COMPATIBILIDAD_DEV.md` (autoridad temporal no aprobada) | — | — | FW-01 |
| REQ-PL-01 | MUST | parser `envelopeSchema` | RP `encodeEvent` | L0-03 | FW-02 |
| REQ-PL-02 | MUST | parser `fieldKey` | RP `encodeEvent` | L0-03, L0-09 | FW-02 |
| REQ-PL-03 | MUST | parser `dataOrigin` | RP | L0-03 | FW-02 |
| REQ-PL-04 | MUST | BE13 §2 | RP `sha` sobre bytes del outbox | L0-04, L2-01 | FW-02, FW-03 |
| REQ-PL-05 | MUST | BE13 §3 | RP (bytes guardados = bytes enviados) | L0-04, L2-01 | FW-02, FW-03 |
| REQ-PL-06 | MUST | BE13 §7 (`conflict`) | RP | L2-01 | FW-02, FW-06 |
| REQ-PL-07 | SHOULD | BE14-03 §3 L0 | RP | L0-05 (opcional) | FW-02 |
| REQ-PL-08 | PENDING_PRODUCT_DECISION | boundary (límites configurables) | — | — | FW-02 |
| REQ-MQ-01 | MUST | BE13 §2 | MP | L1-04 | FW-04 |
| REQ-MQ-02 | MUST | BE13 §2 | MP `createSingleConnectionGuard` | L1-04, L1-05 (+ observer BE14-04) | FW-04 |
| REQ-MQ-03 | MUST | BE13 §3 (QoS 1) | MP `{ qos: 1 }` | **L1-01 (ampliado en BE14-05)** | FW-04 |
| REQ-MQ-04 | MUST | BE13 §1, §3 | RP (PUBACK → `BROKER_ACCEPTED`) | L1-02 | FW-04, FW-06 |
| REQ-MQ-05 | MUST | OUTBOX regla 11 | MP (reapertura perezosa) | L1-05 | FW-04 |
| REQ-MQ-06 | MUST | BE14-03 §4 (topic) | RP | L0-07 | FW-04 |
| REQ-MQ-07 | PENDING_PRODUCT_DECISION | BE14-03 §4 (topics opacos) | — | — | FW-04 |
| REQ-MQ-08 | PENDING_PRODUCT_DECISION | BE13 §8 | — | — | FW-04 |
| REQ-MQ-09 | PLATFORM_SPECIFIC | — | MP (mqtt.js, MQTT 5) | PLATFORM_TEST | FW-01, FW-04 |
| REQ-OB-01 | MUST | OUTBOX regla 1 | RP `persist` antes de publicar | L3-01, L3-02 | FW-03 |
| REQ-OB-02 | MUST | OUTBOX reglas 8–10 | RP | L3-01, L2-04, L2-05, L4-01, L4-02 | FW-03 |
| REQ-OB-03 | MUST | OUTBOX §registro | RP `OutboxRecord` | L3-06 (vista) + REVIEW | FW-03 |
| REQ-OB-04 | MUST | BE13 §6 | RP `createFileStore` (rename atómico) | L3-02 | FW-03 |
| REQ-OB-05 | MUST | BE13 §6 | RP (`OUTBOX_CORRUPT`) | L3-03 | FW-03 |
| REQ-OB-06 | MUST | BE13 §6 | RP | L3-06, L4-03 | FW-03 |
| REQ-OB-07 | MUST | BE13 §6 (`REJECTED_OUTBOX_FULL`) | RP | L4-03 (requiere `capacity-config`) | FW-03 |
| REQ-OB-08 | PENDING_PRODUCT_DECISION | BE13 §8 | — | — | FW-03 |
| REQ-OB-09 | PENDING_PRODUCT_DECISION | BE13 §8 (retención) | — | — | FW-03 |
| REQ-OB-10 | PLATFORM_SPECIFIC | OUTBOX §puertos | RP stores (`TEST_ONLY`) | PLATFORM_TEST | FW-01, FW-03 |
| REQ-RT-01 | MUST | BE13 §6 | RP | L2-01, L4-04 | FW-06 |
| REQ-RT-02 | MUST | BE13 §6 | RP | L2-09, L4-04 | FW-06 |
| REQ-RT-03 | MUST | BE13 §6 | RP `UNCONFIRMED_EXPLICIT` | L4-04 (requiere `policy-config`) | FW-06 |
| REQ-RT-04 | SHOULD | BE13 §6 | RP | L4-04 | FW-06 |
| REQ-RT-05 | SHOULD | BE13 §6 (±25 % propuesto) | RP `jitterRatio` | REF be14-01 | FW-06 |
| REQ-RT-06 | PENDING_PRODUCT_DECISION | BE13 §6 (PROPOSED) | RP defaults `BLOCKED` | — | FW-06 |
| REQ-RC-01 | MUST | BE13 §5 | RP | L1-03, L5-01 | FW-05 |
| REQ-RC-02 | MUST | BE13 §5 | RP | L1-03, L5-02, L2-03 | FW-05 |
| REQ-RC-03 | MUST | BE13 §4 | RP `createHttpReconciliationClient` | L0-08 | FW-05 |
| REQ-RC-04 | MUST | BE13 §4 | RP (429/`throttled`) | L2-08 | FW-05, FW-06 |
| REQ-RC-05 | MUST | BE13 §4 | RP | L2-09 | FW-05 |
| REQ-RC-06 | MUST | BE13 §5 | RP | L2-10, L4-02 | FW-05 |
| REQ-RC-07 | MUST | BE13 §5 | RP `CONFLICT_REQUIRES_REVIEW` | L2-06 | FW-05, FW-07 |
| REQ-RC-08 | MUST | BE13 §5 | RP `QUARANTINED` | L2-07 | FW-05, FW-07 |
| REQ-RC-09 | MUST | BE13 §4 (ámbito) | RP | L5-03 | FW-05 |
| REQ-RC-10 | PENDING_PRODUCT_DECISION | BE13 §8 (`RECOMMENDATION_READY`) | — | — | FW-05 |
| REQ-RC-11 | PLATFORM_SPECIFIC | — | RP (fetch) | PLATFORM_TEST | FW-01, FW-05 |
| REQ-SEC-01 | MUST | BE13 §8; OUTBOX §observabilidad | RP allowlist de logs | REVIEW (REF be14-01 prueba la allowlist) | FW-07 |
| REQ-SEC-02 | PENDING_PRODUCT_DECISION | BE13 (auth `BLOCKED_BY_POLICY`) | RP `ReconciliationAuthProvider` (`BLOCKED`) | — | FW-04, FW-05 |
| REQ-SEC-03 | PENDING_PRODUCT_DECISION | BE13 §8 | — | — | FW-01 |
| REQ-SEC-04 | PLATFORM_SPECIFIC | — | — | PLATFORM_TEST | FW-01 |
| REQ-SEC-05 | PENDING_PRODUCT_DECISION | BE13 §4 (rate-limit `BLOCKED`) | — | — | FW-05 |
| REQ-RS-01 | MUST | BE13 §6; OUTBOX regla 10 | RP | L3-01 | FW-03 |
| REQ-RS-02 | MUST | OUTBOX regla 10 | RP `hooks.crashAt` | L3-02 (requiere `crash-injection`) | FW-03 |
| REQ-RS-03 | SHOULD | — | — | PLATFORM_TEST | FW-01 |
| REQ-OF-01 | MUST | OUTBOX regla 8 | RP | L4-01 | FW-03, FW-04 |
| REQ-OF-02 | MUST | OUTBOX regla 8 | RP | L4-01 | FW-04 |
| REQ-OF-03 | MUST | BE13 §6 | RP | L4-02 | FW-05 |
| REQ-OF-04 | MUST | BE13 §1 | RP | L1-02, L2-10 | FW-05, FW-06 |
| REQ-OBS-01 | MUST | OUTBOX §observabilidad (`outbox_depth`) | RP `stats()` | L3-06 (vista `inspectPending`) | FW-07 |
| REQ-OBS-02 | MUST | OUTBOX §observabilidad | RP `structuredLogLine` | REVIEW | FW-07 |
| REQ-OBS-03 | SHOULD | OUTBOX §observabilidad (`outbox_oldest_age`) | RP `stats()` | REF be14-01 | FW-07 |
| REQ-OBS-04 | SHOULD | BE13 §8 | RP `COUNTERS` | — | FW-07 |
| REQ-OTA-01 | PENDING_PRODUCT_DECISION | — | — | — | FW-01 |
| REQ-OWN-01 | PENDING_PRODUCT_DECISION | BE13 §6, §8 | — | — | FW-07 |
| REQ-HW-01 | PLATFORM_SPECIFIC | — | — | — | FW-01 |

## Cobertura (verificada por `test/be14-05-readiness.test.js`)
- Todo `REQ-*` de la especificación está en esta matriz, y todo `L*-**` citado existe en el catálogo.
- **MUST con test del kit**: 48 de 50; el resto de los MUST se verifican por `REVIEW` (REQ-SEC-01, REQ-OBS-02, y la parte de campos de REQ-OB-03) — no automatizables como caja negra.
- Ningún MUST queda sin contrato, sin referencia **ni** sin verificación.

## Brechas encontradas y su tratamiento
| # | Brecha | Tipo | Tratamiento |
|---|---|---|---|
| G1 | **QoS 1 (REQ-MQ-03) era MUST sin prueba**: ningún test verificaba el QoS publicado | MUST sin test | **Corregida en 14-05**: el mundo y el observador registran el `qos`; L1-01 falla con `QOS_NOT_1` |
| G2 | **Reutilización de `eventId` con otros bytes (REQ-EID-05) sin test del kit** (solo en la referencia) | MUST sin test | **Corregida en 14-05**: L0-09 ampliado (mismo contenido idempotente, otro contenido rechazado, entrada intacta) |
| G3 | `requiredTestIds` excluía L4-03 y L4-04 (los que `SKIP` con `DECISION_PENDING`): un firmware sin hooks de capacidad/política podía obtener `CONFORMANCE PASS EXTERNAL` con "sin descarte silencioso" y "agotamiento explícito" **sin verificar** | contradicción del veredicto | **Corregida en 14-05**: todo test no opcional es requerido para `PASS EXTERNAL` (los hooks de prueba `capacity-config`/`policy-config` pasan a ser necesarios; no se exige ningún valor) |
| G4 | **L2-04 (`drop-before-puback`) no es inyectable contra un broker real** con el observador/controlador actuales ⇒ queda `SKIP` explícito ⇒ un publisher real obtendría `CONFORMANCE INCOMPLETE` aunque cumpla | limitación de infraestructura | **No se corrige en 14-05** (sería otra capa de infraestructura): decisión D17 con opciones — (a) proxy TCP de fallos (nuevo tooling cuando exista firmware), (b) hook de fallo en el puente del propio firmware, (c) renuncia humana documentada. Hasta entonces el test se prueba en Mode A y el veredicto externo real es honestamente `INCOMPLETE` |
| G5 | REQ-SEC-01 y REQ-OBS-02 (no secretos/payload en logs) no son automatizables como caja negra | verificación manual | Checklist `REVIEW` en el plan (FW-07) |
| G6 | Valores y decisiones `PENDING_PRODUCT_DECISION` no tienen test ni deben tenerlo hasta que se decidan | esperado | — |
