# BE-13A — Auditoría de integración IoT, Backend y Frontend

## Resumen ejecutivo

La cadena `Hardware → EMQX → iot-ingest → MongoDB → be-agro → fe-agro` no está integrada extremo a extremo. Hay tres piezas valiosas pero desacopladas:

- `iot-ingest` productivo conserva una PoC legacy que acepta cuerpos flexibles y persiste sin autenticación del servicio ni atribución empresarial.
- La rama local AGRO-IOT-01 contiene un modo protegido, probado pero deliberadamente no montado, con autenticación del servicio EMQX, replay/idempotencia, procedencia explícita y almacenamiento técnico.
- BE-11 y BE-12 están integrados en `dev` mediante los PR #20 y #21; modelan identidad física, asociaciones temporales, atribución histórica y aislamiento empresarial, pero no consumen documentos de `iot-ingest` ni están montados públicamente.
- `fe-agro` funciona principalmente con MSW y espera DTOs centrados en `device_id`, `campo_id` y respuestas agregadas que todavía no coinciden con los DTOs aislados BE-11/BE-12.

La primera implementación recomendada es un contrato y mapper puro, offline, que transforme un documento técnico protegido de ingesta en un candidato validado para `TrustedMeasurementEvent`, sin conceder identidad física, cliente ni autoridad temporal. No debe activarse ningún endpoint ni conexión real durante esa tarea.

## Repositorios inspeccionados

| Repositorio | Ruta | Rama / SHA | Estado observado |
|---|---|---|---|
| be-agro, consolidación BE-13R | `be-agro/.local-consolidacion/be13-consolidacion` | `feature/be13-01-consolidacion` / base `6a30be4374e68f655ef31fbb69286f4b5ab48178` | recupera BE-13A y BE13-01 sobre `dev` con BE-12 integrado |
| be-agro, worktrees documentales originales | `be-agro/.local-consolidacion/be13a` y `be13-01` | `881375631be499817686add6cea8b8e4bcc80401` y `43e7a73c6a43da8d471fb51aeb6d3cdbcdfdb123` | preservados sin cambios |
| be-agro principal | `be-agro` | `feature/be-09-autenticacion-analisis` / `63c7eb20882e1e63e9ed03e2b6afa0a91e124afc` | contiene trabajo local sin seguimiento; preservado |
| iot-ingest | `C:/Users/CamilaGonzález/iot-ingest` | `feature/agro-iot-01-seguridad-ingesta` / `b99e30ba3c9b66bb61147347a3805e6f8db7db46` | limpio; sin modificaciones |
| fe-agro | `C:/Users/CamilaGonzález/fe-agro` | `dev` / `daa72a828eb79aad0f09dcb7786a2c5a4adfd3bc` | limpio; sin modificaciones |

## Arquitectura observada

### iot-ingest

Node.js, TypeScript y Express 5 con driver MongoDB. `api/index.ts:1-3` exporta la aplicación serverless y `src/server.ts:1-4` es el listener local. El flujo legacy es `routes → controller → service → repository`; `src/routes.ts:6-9` monta sistema, mediciones y dispositivos.

Operaciones legacy:

- `POST /ingest`: `src/modules/measurements/measurement.controller.ts:8-15`.
- `POST /iot-device-status`: `src/modules/devices/device.controller.ts:8-15`.
- `GET /`, `/health`, `/debug`: `src/modules/system/system.controller.ts:5-18`.

El modo productivo actual está fijado a `legacy`; cualquier otro valor aborta el arranque (`src/app.ts:7-13`). La factory protegida existe, pero `src/security/protected-app.ts:16-20` declara que la aplicación y Vercel no la importan.

### be-agro

Express 5, TypeScript estricto, Zod y Mongoose en capas. BE-11 separa sensores lógicos, dispositivos físicos y dos historiales temporales. `src/models/sensor.models.ts:13-15` define namespaces separados; `:25-39` define campos e índices. `src/telemetry/association.contracts.ts:1-9` prohíbe convertir una clave técnica en cliente empresarial.

BE-12 agrega contratos de evento confiable, atribución y lectura histórica (`src/measurements/contracts.ts:6-107`), pero la aplicación pública solo monta health (`src/app.ts:25-33`). El repository incluido es provisional/local, no Atlas.

### fe-agro

React 19, Vite, TypeScript, MSW y servicios API por pantalla. `src/main.tsx:9-15` activa MSW únicamente con `VITE_USE_MOCKS=true`. El cliente usa `VITE_API_BASE_URL`, Bearer desde `sessionStorage` y elimina la sesión ante 401 (`src/api/client.ts:4-52`). Las pantallas cubren dashboard, áreas, sensor, históricos, mapa y alertas (`src/app/router.tsx:25-32`).

## Hallazgos

| ID | Estado | Severidad | Hallazgo y evidencia | Impacto / recomendación |
|---|---|---|---|---|
| H01 | IMPLEMENTADO legacy | CRÍTICA | `/ingest` acepta cualquier objeto no vacío y lo persiste casi sin esquema (`measurement.dto.ts:4-23`, `measurement.service.ts:7-11`). | No usar esos documentos como mediciones atribuidas. Mantenerlos fuera del adapter empresarial hasta validar un contrato protegido. |
| H02 | PENDIENTE | CRÍTICA | La app desplegable rechaza el modo protegido (`iot-ingest/src/app.ts:7-13`); la factory protegida no está compuesta (`protected-app.ts:16-20`). | Activación requiere PR propio, Preview aislado, configuración EMQX y rollback. |
| H03 | PARCIAL | ALTA | `x-emqx-key` autentica al servicio y admite rotación (`authentication.ts:6-20`), pero no prueba hardware ni propiedad. Procedencia fija `physicalMeasurementVerified=false` y `commercialAttribution=false` (`provenance.ts:4-20`). | Conservar estas negaciones; agregar autoridad de dispositivo por puerto confiable BE-11, no por payload. |
| H04 | IMPLEMENTADO protegido | ALTA | Replay usa `(sourceId, operation, eventId)` y digest de bytes; transacción y ACK idempotente (`mongo-store.ts:44-74`). | Reutilizable, condicionado a ID estable real de EMQX y replica set. |
| H05 | PENDIENTE | CRÍTICA | No existe mapper entre `_payload/_provenance` de IoT (`mongo-store.ts:61-66`) y `TrustedMeasurementEvent` BE-12 (`contracts.ts:6-19`). | Implementar primero un mapper puro fail-closed con pruebas de contrato. |
| H06 | RESUELTA en diseño | ALTA | BE-11 distingue `mqtt-clientid`/`device-id`, `sourceId`, dispositivo físico y cliente (`association.contracts.ts:3-37`). | Usar `sourceId + kind + value`; nunca `clientid` como `clientId`. |
| H07 | IMPLEMENTADO aislado | ALTA | BE-12 filtra históricos por `realm` y `clientId` de sesión y revalida la sesión antes/después (`measurement-history.service.ts:9-30`). | Mantener filtro dentro del repository Atlas definitivo y respuestas 404/fail-closed. |
| H08 | BLOQUEANTE | CRÍTICA | Política temporal productiva no aprobada; adapter actual siempre rechaza (`measurement-temporal-policy.ts:3-10`). | Aprobar reloj, tolerancia, backlog y reglas de eventos tardíos antes de atribuir. |
| H09 | BLOQUEANTE | ALTA | Magnitud/unidad en IoT permanecen dentro de payload libre; BE-12 exige catálogo (`contracts.ts:47-51`). | Definir tabla explícita de extracción y normalización; no completar ausencias ni homologar S8 con NPK/pH. |
| H10 | PENDIENTE | ALTA | Nombres físicos Atlas de IoT y BE-11/12 son diferentes y configurables; BE-12 solo tiene repository provisional. | Inventariar Atlas en lectura y decidir si se consume, copia o transforma; no migrar por inferencia. |
| H11 | PARCIAL | MEDIA | Frontend espera `device_id` como identificador de sensor (`dominio.ts:28-31`) y lo usa en rutas. BE-11 separa `sensor_id` y `dispositivo_id` (`sensor.dto.ts:4-7`). | Aprobar un ID público estable; recomendado: ruta de sensor lógico por `sensor_id`, dispositivo físico como metadata separada. |
| H12 | PENDIENTE | ALTA | Frontend pide históricos con `desde/hasta/variable`, `campo_id` y límite 1000 (`api/historico.ts:1-12`); BE-12 usa epoch, selector y máximo 200 (`schemas.ts:31-40`). | Cerrar contrato/OpenAPI y cursor; no ampliar a 1000 sin medir índices/costos. |
| H13 | PARCIAL | MEDIA | Frontend conserva token Bearer en `sessionStorage` (`api/sesion.ts:1-30`) y usa mocks para identidad/campos. | Integrar contrato real de sesión antes de retirar MSW; cliente nunca selecciona tenant. |
| H14 | NO VERIFICABLE | ALTA | No se inspeccionó tenant EMQX, Atlas, hardware ni variables Preview/Production. | Requiere responsables externos y fixtures sanitizados; no activar por documentación. |
| H15 | PENDIENTE | ALTA | `iot-ingest` legacy no deduplica mediciones; protegido deduplica solo si `eventId` es estable. | Confirmar IDs y reintentos reales de EMQX; MQTT DUP/packetId no bastan como identidad global. |

## Contrato real observado de mensajes

### Legacy activo

- Entrada: objeto JSON no vacío o texto convertido a `{payload: string}` (`body-parser.ts:4-12`).
- Medición: cuerpo original sin `_id` más `_receivedAt: Date` (`measurement.service.ts:7-11`).
- Dispositivo: prioridad de aliases raíz/payload/query y conversión de números a string (`device.dto.ts:27-48`); upsert por `clientid` (`device.repository.ts:35-42`).
- Colecciones: defaults `iot_sensores`, `mediciones`, `dispositivos` (`config/env.ts:3-10`).
- Autenticación: ninguna en las rutas legacy.

### Protegido, no activado

- Envelope: `version`, `eventId`, `sentAt`, `clientid`, `payload`, `deviceTimestamp?`, `mqtt?` (`security/event.ts:13-18,40-58`).
- Credencial: exactamente un `x-emqx-key` con key id y secreto (`authentication.ts:9-19`).
- Persistencia técnica: eventos, dispositivos y mediciones separados; índices por fuente/evento y fuente/clientid (`mongo-store.ts:8-36`).
- Metadata: source, evento, identidad técnica, topic, tipo, origen declarado, timestamps y negaciones explícitas de verificación/atribución (`provenance.ts:6-20`).
- No normaliza magnitudes/unidades ni establece cliente/campo/área/sensor.

## Modelo de mediciones comparado

| Dimensión | iot-ingest protegido | BE-11/BE-12 | Frontend | Brecha |
|---|---|---|---|---|
| Identidad técnica | `sourceId + clientid` | `sourceId + TechnicalDeviceKey → physicalDeviceId` | `device_id` ambiguo | mapper y convención pública |
| Propietario | siempre no atribuido | ventana con `clientId/fieldId/areaId/sensorId` | `campo_id/area_id` públicos | atribución temporal autorizada |
| Tiempo | `sentAt`, `deviceTimestamp`, `_receivedAt` | declared/received/persisted/attributed | ISO `timestamp` | reloj/tolerancia/precisión |
| Valor | payload libre | magnitud, unidad, value/null, missingReason, provenance | variables fijas + valor/null | catálogo y extracción |
| Duplicados | eventId/digest en protegido | eventId único propuesto | no visible | ID real EMQX y semántica |
| Históricos | índice técnico por clientid/recepción | selector tenant + orden/cursor | variable, rango, límite 1000 | contrato HTTP/OpenAPI |

## Pruebas ejecutadas

- `iot-ingest`: 24/24 offline aprobadas; no se repitió MongoDB real. La documentación registra 12/12 locales previas.
- `be-agro` antes de incorporar la suite documental BE13-01: 417/417 offline aprobadas; evidencia previa R01–R10 10/10 y BE-11 M01–M15 15/15. El total reconciliado se registra en `INFORME_BE13R_CONSOLIDACION.md`.
- `fe-agro`: una primera ejecución completa falló de forma intermitente en recuperación de token mock; la prueba focalizada aprobó 19/19 y la repetición completa aprobó 321/321. No se modificó el frontend.
- No se ejecutaron Docker, Atlas, EMQX, Vercel ni hardware.

## Decisiones y bloqueos

| Decisión | Clasificación | Evidencia necesaria |
|---|---|---|
| `mqtt-clientid` no es cliente empresarial | RESUELTA | Contratos BE-11 e IoT protegido |
| Identidad física autoritativa | BLOQUEANTE | autenticador/ACL EMQX, inventario hardware, política de alta y rotación |
| Mapeo `sourceId + clientid → physicalDeviceId` | BLOQUEANTE | catálogo aprobado y unicidad por fuente |
| Ventana dispositivo/sensor/cliente | RESUELTA en diseño, pendiente operación | persistencia BE-11 y proceso administrativo |
| Reloj y tolerancia | BLOQUEANTE | fixtures reales, retrasos, deep sleep, backlog y precisión |
| Catálogo magnitud/unidad | BLOQUEANTE | IoT + Agronomía + BE/FE |
| Modelo Atlas | REQUIERE VALIDACIÓN EXTERNA | acceso autorizado de lectura, índices y BSON |
| Contrato HTTP/OpenAPI | PENDIENTE | acuerdo FE/BE sobre IDs, fechas, cursor y límite |
| Activación protegida EMQX | REQUIERE VALIDACIÓN EXTERNA | sandbox broker, TLS, secretos, rotación y retries |
| Preview/Production | REQUIERE VALIDACIÓN EXTERNA | ramas, variables aisladas y ausencia de promoción automática |

## Recomendación

No conectar todavía los sistemas. Comenzar por BE13-01 del plan: fixtures sanitizados y contrato canónico de ingreso; continuar con un mapper puro que produzca un candidato no atribuido. Solo después deben componerse los puertos BE-11/12 y un repository real en un namespace aislado.
