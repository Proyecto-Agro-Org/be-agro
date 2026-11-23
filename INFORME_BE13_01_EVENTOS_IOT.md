# BE13-01 — Eventos IoT y base de fixtures

## Resumen

Se preparó una colección offline de 14 fixtures trazables a código y pruebas existentes. Ninguno es una captura real de EMQX: doce son sintéticos y dos representan formas aceptadas por el código legacy. Los fixtures permiten comenzar BE13-02 con casos negativos y una frontera documental, pero no autorizan un mapper positivo a `TrustedMeasurementEvent`.

## Estado de la evidencia

- **REAL SANITIZADO:** no disponible.
- **OBSERVADO EN CÓDIGO:** cuerpos legacy flexibles para medición y estado.
- **SINTÉTICO:** envelopes protegidos, retries, duplicados, parciales, deep sleep y rechazos.
- **HIPOTÉTICO:** campos exactos producidos por EMQX real, autenticador/ACL, IDs del hardware, eventos fuera de orden reales y política de backlog.

## Inventario de eventos

| Evento | Endpoint/handler | Formato demostrado | Persistencia | Estado |
|---|---|---|---|---|
| Telemetría legacy | `POST /ingest` | cualquier objeto no vacío; texto se envuelve en `payload` | cuerpo sin `_id` + `_receivedAt` en colección configurable | IMPLEMENTADO, inseguro (`measurement.dto.ts:4-23`, `measurement.service.ts:7-11`) |
| Estado legacy | `POST /iot-device-status` | aliases raíz/payload/query; número a string | upsert por `clientid`, mezcla payload y timestamps servidor | IMPLEMENTADO, identidad declarada (`device.dto.ts:27-48`, `device.repository.ts:35-42`) |
| Telemetría protegida | `POST /ingest` de factory separada | envelope v1, MQTT `messageType=telemetry`, topic requerido | evento + medición en transacción | IMPLEMENTADO, DESHABILITADO (`protected-app.ts:16-49`) |
| Estado protegido | `POST /iot-device-status` | envelope v1, `messageType=device-status` | evento + upsert dispositivo | IMPLEMENTADO, DESHABILITADO |
| Conexión | misma operación de estado | `messageType=connected`, topic nullable | upsert técnico, no medición | SOLO FACTORY/PRUEBA (`mqtt-compatibility.test.ts:33-38`) |
| Desconexión | misma operación de estado | `messageType=disconnected`, topic nullable | upsert técnico, no medición | SOLO FACTORY/PRUEBA |
| Retry exacto | misma ruta y mismos bytes | mismo `sourceId+operation+eventId` y digest | ACK duplicado 200, sin segunda escritura | IMPLEMENTADO protegido (`mongo-store.ts:44-53`) |
| Replay alterado | mismo ID, bytes diferentes | envelope válido con digest diferente | 409, no nueva escritura | IMPLEMENTADO protegido |
| Parcial/null/cero | payload objeto | null y cero preservados | payload sin normalización | IMPLEMENTADO protegido; semántica BE-12 pendiente |
| Fuera de orden | no es un tipo propio | solo timestamps declarados | recepción técnica | PENDIENTE de política temporal |

La aplicación desplegable continúa rechazando cualquier `INGEST_SECURITY_MODE` distinto de `legacy` (`iot-ingest/src/app.ts:7-13`). Los eventos protegidos no son eventos productivos.

## Campos observados del envelope protegido

| Campo | Tipo/obligación observada | Validación | Uso permitido |
|---|---|---|---|
| `version` | literal `1`, obligatorio | strict envelope | versión técnica |
| `eventId` | technical ID, obligatorio | ASCII técnico hasta 128 | idempotencia técnica |
| `sentAt` | epoch ms safe integer, obligatorio | ventana de admisión en factory | frescura de entrega; no atribución aprobada |
| `clientid` | technical ID, obligatorio | aliases del payload deben coincidir | identificación técnica declarada |
| `payload` | objeto, obligatorio | profundidad/claves/tamaño controlados | datos no confiables |
| `deviceTimestamp` | string/number/null opcional | forma y longitud | declarado; no autoridad |
| `mqtt` | objeto opcional por compatibilidad | topic/type/origin cerrados | contexto declarado del servicio |

Evidencia: `iot-ingest/src/security/event.ts:13-18,40-63`.

## Tiempos

| Tiempo | Fuente observable | Estado de autoridad |
|---|---|---|
| `deviceTimestamp` | dispositivo/payload de envelope | no confiable para atribución |
| `sentAt` / `brokerDeclaredAt` | envelope, transformado por procedencia | origen real EMQX no verificado |
| `receivedAt` / `_receivedAt` | reloj de iot-ingest al aceptar | recepción confiable del servicio, no adquisición |
| `persistedAt` | requerido por BE-12, no separado actualmente en store IoT | pendiente de adapter/persistencia |
| `attributedAt` | política BE-12 | bloqueado; política conservadora rechaza |

Deep sleep se representa mediante `deviceTimestamp` antiguo y `sentAt` dentro de ventana. Esto prueba tolerancia del parser, no que el evento pueda atribuirse. Reintentos deben conservar `eventId`, `sentAt` y bytes; regenerarlos elude idempotencia y no está permitido por el contrato propuesto.

## Idempotencia

El store protegido usa `sourceId + operation + eventId`; el ID de resultado es SHA-256 de esa tupla (`mongo-store.ts:50-58`). Los índices únicos se definen en `mongo-store.ts:31-36`.

- Falta `eventId`: rechazo 400 antes del store.
- Mismo ID y mismo digest: ACK duplicado, una escritura.
- Mismo ID y digest diferente: 409.
- Nuevo ID para el mismo fenómeno físico: no hay deduplicación semántica.
- Exactly-once no está demostrado; la garantía es idempotencia condicionada a un ID estable.
- BE-12 debe preservar `eventId` y unicidad de persistencia, no duplicar el protocolo HTTP de ACK.

## Compatibilidad BE-11/BE-12

| Estado | Lo que puede afirmarse con los fixtures |
|---|---|
| Evento recibido técnicamente | sí, para envelopes que pasan contrato protegido |
| Servicio EMQX autenticado | solo en la factory con una clave sintética; no prueba configuración real |
| Identidad técnica de hardware autenticada | no |
| Dispositivo físico resuelto | no; requiere BE-11 y catálogo |
| Sensor lógico resuelto | no |
| Timestamp autorizado | no |
| Magnitud/unidad aprobadas | no |
| Atribución empresarial | siempre bloqueada |

El resultado admisible para BE13-02 es `candidate | quarantined`. Ningún fixture justifica producir directamente un `TrustedMeasurementEvent` verificado.

## Seguridad

Los fixtures usan exclusivamente nombres `synthetic-*`. No contienen claves, tokens, URIs, IPs, IDs reales de hardware ni datos empresariales. Los campos de autoridad empresarial aparecen únicamente en F09 como entrada contradictoria destinada a rechazo.

## Validaciones

- Catálogo de 14 fixtures con IDs únicos y clasificación cerrada.
- Envelopes positivos validados contra las reglas observables del schema v1.
- Negativos para eventId faltante, identidad contradictoria y timestamp inválido.
- Retry exacto y replay alterado diferenciados por digest.
- Ausencia de credenciales y autoridad empresarial en fixtures positivos.
- Deep sleep y magnitud desconocida permanecen bloqueados para BE-12.
- Suite documental BE13-01: 7/7 aprobadas.
- Suite completa de `be-agro` sobre la base BE-11 más los fixtures: 398/398 aprobadas; typecheck y build aprobados. Las dependencias se restauraron desde lockfile con `npm ci --offline`.
- `iot-ingest`: 24/24 pruebas offline aprobadas.
- `fe-agro`: 321/321 pruebas offline aprobadas.
- `git diff --check`: aprobado. No se ejecutaron MongoDB real, Docker ni servicios externos.
