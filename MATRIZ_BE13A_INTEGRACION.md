# BE-13A — Matriz de integración extremo a extremo

| Etapa | Origen → destino | Evento/contrato actual | Identidad | Autoridad y validación | Persistencia | Estado | Riesgo | Evidencia |
|---|---|---|---|---|---|---|---|---|
| 1 | Hardware → EMQX | MQTT no inspeccionado | `clientid`/serial desconocido | NO VERIFICABLE; topic/payload no prueban identidad | broker no inspeccionado | REQUIERE VALIDACIÓN EXTERNA | suplantación, IDs repetidos | `iot-ingest/CONTRATO_AGRO_IOT_EMQX_DISPOSITIVO.md:38-49` |
| 2 | EMQX → iot-ingest legacy | HTTP body flexible | aliases `clientid/deviceId/id` | sin auth; objeto/texto hasta 1 MB | `mediciones`, `dispositivos` | IMPLEMENTADO | crítico: escritura no autenticada y sin schema | `src/middlewares/body-parser.ts:4-12`; `device.dto.ts:33-48` |
| 3 | EMQX → iot-ingest protegido | envelope v1 estricto | `sourceId` configurado + `clientid` declarado | `x-emqx-key` autentica servicio; no hardware | store técnico transaccional | IMPLEMENTADO, DESHABILITADO | clave robada; contexto MQTT no verificado | `protected-app.ts:16-49`; `authentication.ts:6-20` |
| 4 | iot-ingest → Mongo técnico | evento/dispositivo/medición | `(sourceId, operation, eventId)` y `(sourceId, clientid)` | índices fail-closed, digest, transacción | 3 colecciones con prefijo | IMPLEMENTADO, DESHABILITADO | requiere replica set y namespace nuevo | `mongo-store.ts:8-75` |
| 5 | Mongo técnico → BE-11 | no existe adapter | debería ser `sourceId + TechnicalDeviceKey` | BE-11 exige identidad exacta y verificador confiable | catálogo de dispositivos/asociaciones separado | PENDIENTE | atribuir por clientid actual o payload | `association.contracts.ts:25-37` |
| 6 | BE-11 → BE-12 | puertos de dispositivo y ventana | `physicalDeviceId` | exacta, máx. 2; una ventana `[from,to)` | snapshot empresarial | IMPLEMENTADO AISLADO | reloj no aprobado; ventanas solapadas | `measurement-attribution.service.ts:12-36` |
| 7 | BE-12 → repository real | `AttributedMeasurement` | cliente/sensor/dispositivo/asociación | filtros `realm + clientId`; salida revalidada | solo repository provisional y campaña local | PARCIAL | mapping Atlas inexistente | `measurement-history.service.ts:9-30`; `provisional-measurement.repository.ts:9-29` |
| 8 | be-agro → API | controllers aislados | sensor/dispositivo/área/campo | sesión y aislamiento preparados | no aplica | DESHABILITADO | exponer contrato no aprobado | `measurement.controller.ts:12-21`; `src/app.ts:25-33` |
| 9 | API → fe-agro | mocks `/sensores`, históricos y agregados | `device_id`, `campo_id`, `area_id` | Bearer; tenant no debe venir de query | estado React/MSW | SIMULADO/PARCIAL | ID ambiguo y DTO divergente | `fe-agro/src/api/historico.ts:1-12`; `types/dominio.ts:28-31` |
| 10 | fe-agro → visualización | dashboard, áreas, sensor, histórico, mapa, alertas | rutas por `deviceId` | validación runtime limitada a fetch/mocks | navegador | IMPLEMENTADO CON MOCKS | datos demo pueden parecer reales | `src/app/router.tsx:25-32`; `src/main.tsx:9-15` |

## Campos mínimos por frontera propuesta

| Frontera | Campos requeridos | Campos no confiables para autorización |
|---|---|---|
| EMQX → ingesta | version, eventId estable, sentAt de broker/servicio, clientid de contexto MQTT, payload, mqtt.topic/type/origin | clientId, entityId, fieldId, areaId, sensorId dentro de payload/topic |
| Ingesta → adapter BE | sourceId configurado, eventId, technical clientid, receivedAt, declared timestamp, payload y procedencia | `commercialAttribution`, `physicalMeasurementVerified` enviados externamente |
| Adapter → BE-11 | sourceId + `{kind,value}` | cliente actual del dispositivo, email, topic como propietario |
| BE-11 → BE-12 | physicalDeviceId + ventana única con revision y jerarquía | asociación vigente para eventos históricos |
| BE-12 → API | snapshot atribuido, magnitud/unidad/value/null/provenance y tiempos | documentos Mongoose, realm/clientId internos, metadata cruda |
| API → FE | sensor lógico público, área/campo, datos normalizados, ISO UTC, cursor/truncado | selector de cliente público |

## Compatibilidad FE/BE pendiente

| Tema | FE actual | BE disponible | Acción |
|---|---|---|---|
| Sensor | `device_id` identifica pantalla | `sensor_id` y `dispositivo_id` separados | elegir `sensor_id` público; mantener dispositivo separado |
| Histórico | `desde`, `hasta`, `variable`, límite 1000 | `from`, `to`, selector, máximo 200, cursor | cerrar DTO/OpenAPI y paginación |
| Fechas | ISO string | epoch interno, DTO ISO | definir precisión y UTC |
| Última medición | record fijo de variables | filas por magnitud/procedencia | definir snapshot parcial y unidad por magnitud |
| Errores | FE lee `{error: string}` | BE usa `{error:{code,message}}` | adaptar cliente FE y estados 400/401/404/409/503 |
| Sesión | Bearer en sessionStorage; mocks | sesiones opacas preparadas pero rutas productivas deshabilitadas | integración independiente y controlada |
