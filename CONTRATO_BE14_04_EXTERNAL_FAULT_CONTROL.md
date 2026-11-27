# CONTRATO — Observador MQTT y fault-control externos (BE14-04)

Estado: **LOCAL_TEST_ONLY**. No certifica firmware (no existe). Completa la infraestructura para que un publisher real futuro pueda ser **observado y sometido a fallos desde afuera**, sin tocar su código interno.

## 1. Principio
El publisher es una caja negra. Lo que el kit afirma sobre MQTT lo **observa** en el broker (no se lo cree al publisher) y los fallos los **inyecta en la infraestructura** (broker, API de reconciliación), nunca en el publisher.

## 2. `ExternalMqttObserver` (`scripts/be14-04/observer.ts`)
Núcleo puro (testeable offline) + fuentes de observación.

| Observa | Cómo | Límite honesto |
|---|---|---|
| conexiones / desconexiones / reconexiones | poll de la API de gestión de EMQX (`GET /clients/{clientid}`, `connected`/`connected_at`) | resolución = `pollMs` (100 ms); una conexión efímera < `pollMs` puede no verse |
| `clientId` | `clientid` que el **broker** pone en la regla `lab_verify` | exacto |
| publicaciones, topic, QoS | suscriptor sobre la regla `lab_verify` | exacto |
| bytes exactos + SHA-256 | `payload_b64` de la regla → bytes → SHA-256 | exacto |
| `DUP` | **no visible** a través de la regla | se reporta `NOT_OBSERVABLE`, nunca se adivina |
| colisión de clientId | 2º CONNECT sin DISCONNECT (exacto en fuentes in-process; en EMQX es heurística por *takeover*) | documentado |
| PUBACK | solo indirecto (el publisher lo declara por su outbox) | no observable desde el broker |

Cada evento: `runId, observerEventId, timestamp, technicalIdentity, clientId, type, topic, qos, dup, eventId, payloadSha256, payloadLength` (`type ∈ CONNECT_SEEN, DISCONNECT_SEEN, RECONNECT_SEEN, PUBLISH_SEEN, DUP_PUBLISH_SEEN, PAYLOAD_CONTRACT_FAIL, TOPIC_INVALID_SEEN, COLLISION_SUSPECTED`).

Correlación: identidad + `eventId` (parser canónico `parseBrokerPayload`) + hash. Reglas verificadas (`verify()`):
- mismo `eventId` ⇒ mismos bytes en todo reintento (`MQTT_RETRY_BYTES_CHANGED`);
- los bytes observados hashean al `payloadSha256` que el publisher dice poseer (`MQTT_HASH_CHANGED`);
- ningún `eventId` observado que el publisher no posea (`MQTT_EVENT_ID_CHANGED`);
- topic válido: sin wildcard, sin NUL, 1..1024 bytes (`MQTT_TOPIC_INVALID`);
- una sola conexión simultánea por identidad (`MQTT_CLIENT_ID_COLLISION`);
- payload parseable por el parser canónico (`PAYLOAD_CONTRACT_FAIL`).

Higiene: **el payload no se persiste** (solo hash + longitud) salvo `storePayloadBytes: true` explícito (evidencia TEST_ONLY); ningún secreto entra al resumen. Las esperas (`waitFor`) son **siempre acotadas** (`MQTT_TIMEOUT`).

Robustez de la fuente EMQX (hallazgos de la corrida real, ver INFORME): el suscriptor se reconecta tras un reinicio del broker y **re-suscribe**; un SUBACK vacío o denegado durante el arranque del broker **no cuenta como listo** (EMQX cachea el *deny* por conexión: se descarta la conexión y se reintenta con un canal nuevo).

## 3. `ExternalFaultController` (`scripts/be14-04/fault-controller.ts`)
Fallos: `brokerDown`, `brokerUp`, `restartBroker`, `disconnectClient`, `reconciliationDown/Up`, `backendDown/Up`, `injectHttpStatus(429|500|normal)`, `delayHttp`.

Guardas duras:
1. **Solo loopback** (`FAULT_TARGET_NOT_LOCAL`).
2. **Solo contenedores con la etiqueta de ESTE run** (`agro.emqx.lab=<runId>`, verificada con `docker inspect` antes de cada acción; `FAULT_TARGET_NOT_OWNED`). Nunca nada ajeno ni histórico.
3. **Nunca borra volúmenes** ni red (solo `stop/start/restart`).
4. Cada acción deja un registro de procedencia (`runId`, `stage: "04"`, objetivo, inicio, recuperación, `recoveryMs`).
5. `recoverAll()` restaura lo que el controlador dejó roto (cleanup siempre).

Códigos: `BROKER_STOP_FAILED, BROKER_START_FAILED, BROKER_NOT_READY, API_FAULT_INJECTION_FAILED, CLIENT_DISCONNECT_FAILED, RECOVERY_TIMEOUT, FAULT_TARGET_NOT_LOCAL, FAULT_TARGET_NOT_OWNED, FAULT_CAPABILITY_ABSENT`. Fallos de infraestructura ⇒ `INFRA_ERROR` / salida 3, **nunca un SKIP silencioso**.

## 4. Negociación de capacidades
- Un fallo no inyectable en un broker real (`drop-before-puback`: el instante exacto entre aceptación y PUBACK no es controlable desde afuera) ⇒ `FAULT_CAPABILITY_ABSENT`: el test queda **`SKIP` con razón explícita**, o **`FAIL` (`FAULT_CAPABILITY_REQUIRED`) si figura en `faultControl.requiredFaults`**.
- El observador que no arranca ⇒ `MQTT_OBSERVER_START_FAILED` ⇒ salida 3.

## 5. Orquestador de escenarios (`scenario.ts`, `scenarios.ts`)
`setup → observer → boot → fault → espera por condición (con timeout) → recover → assert → shutdown`. El cleanup **siempre** corre; la evidencia se conserva aun en FAIL. Estados: `PASS | FAIL | SKIP | INFRA_ERROR`.
S1 normal · S2 broker caído · S3 desconexión forzada · S4 reconciliación caída · S5 HTTP 429 · S6 **negativo** (mismo `eventId`, bytes distintos: el kit **debe** detectarlo; el escenario pasa solo si lo detecta).

## 6. Veredictos (`verdict.ts`)
| Situación | Veredicto |
|---|---|
| publisher **real** declarado (`publisher.kind: real-external`), sin marca de test-double, todos los tests requeridos PASS, sin FAIL | `CONFORMANCE PASS EXTERNAL` |
| puente de prueba / test-double (declarado en config **o** auto-declarado por el puente vía `identity`) | **nunca** `PASS EXTERNAL`; etiqueta `HARNESS_SELF_TEST` |
| hay `NOT_RUN`, o un test requerido no quedó en PASS (p. ej. SKIP por fallo no inyectable) | `CONFORMANCE INCOMPLETE` (salida 4) |
| algún FAIL | `CONFORMANCE FAIL` (salida 1) |
| sin observador configurado (comportamiento BE14-03) | los tests `world: mqtt` siguen `NOT_RUN` ⇒ `INCOMPLETE` |

Hoy **no existe publisher real** ⇒ el modo externo real sigue `INCOMPLETE`. Eso **no** es un fallo.

## 7. Configuración externa (extensión de BE14-03, todo opcional)
`publisher{kind,name}`, `observer{enabled,topicFilter,apiUrl(loopback),apiKeyEnv,apiSecretEnv,pollMs,observerUsernameEnv,observerPasswordEnv}`, `faultControl{mode:none|lab-emqx,brokerContainer,runId,readyTimeoutMs,requiredFaults}`, `timeouts{perTestMs,bridgeMs}`. **Sin secretos en línea** (solo nombres de variables de entorno); `apiUrl`/MQTT solo loopback. Una config BE14-03 sigue siendo válida.

## 8. Qué NO es
No es certificación de producción ni de hardware. No toca firmware ni decide autenticación o retry. No sustituye la decisión humana pendiente sobre el E2E. `productionReady = false`.
