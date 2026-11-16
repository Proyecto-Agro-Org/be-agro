# Propuesta de esquema MongoDB para be-agro

**Actualización:** 16/11/2026 · BE-01.
**Estado:** modelo conceptual propuesto; pendiente de relevamiento y aprobación BE-02.
**Decisión confirmada:** colecciones convencionales, **no Time Series**. No se ejecutan migraciones.

## 1. Qué se conoce y qué falta verificar

El inventario histórico compartido enumera clientes, usuarios, lotes y dispositivos con _id string; mediciones con _id ObjectId, device_id string, timestamp string, location, soil y nutrients. No es una inspección actual de Atlas.

El código de iot-ingest (`e6ffda0f0a4b9a18298c239ac34cc61de6b1c3fa`) usa por defecto base iot_sensores y colecciones mediciones/dispositivos, configurables. Inserta JSON libre con _receivedAt Date y _id generado; actualiza dispositivos por clientid string con _createdAt/_lastSeen Date. No garantiza tenant, campo, área, formato de magnitudes ni fecha de adquisición. El clientid MQTT identifica dispositivo; **no significa cliente del sistema**.

No se verificaron opciones de colecciones, índices efectivos, documentos reales ni versiones de Atlas. El índice único clientid está solicitado por el repository de ingesta; su existencia física no fue comprobada. La falta de un model de clientes/áreas en ingesta tampoco demuestra que esas colecciones no existan.

## 2. Modelo lógico confirmado

```text
Cliente ── Usuario (un cliente por usuario)
   └── Campo
         └── Área
               └── Dispositivo
                     └── Mediciones
```

Campo y Área no se fusionan. El significado de lotes y la colección física de cada nivel se definen con evidencia en BE-02. `entityId` es la convención interna propuesta de tenant; `cliente_id`, `campo_id`, `area_id`, `device_id` son nombres públicos observados en frontend, no equivalencias BSON automáticas.

## 3. Colecciones y campos candidatos

**Todo este apartado es propuesta**, no schema implementado ni contrato BSON aprobado. `IdCliente`, `IdCampo`, `IdArea`, `IdDispositivo` representan tipos por acordar; no convertir strings a ObjectId por su apariencia.

| Colección lógica | Campos mínimos candidatos y relaciones |
|---|---|
| clientes | _id: IdCliente, nombre |
| usuarios | _id: IdUsuario, entityId: IdCliente, googleSub si se aprueba Google, email, nombre, activo |
| campos | _id: IdCampo, entityId: IdCliente, nombre |
| areas | _id: IdArea, entityId: IdCliente, campoId: IdCampo, nombre |
| dispositivos | _id físico preservado, entityId, campoId, areaId, deviceId público, clientid MQTT, nombre, ubicación vigente opcional |
| mediciones | _id físico preservado, referencia de dispositivo/cliente/campo/área verificable, instante adquisición, recepción, payload bruto y fuente/versión de formato |
| alertas | Solo si se aprueba persistencia: cliente/relaciones, tipo, severidad, descripción, estado, apertura/resolución |

No se propone sobrescribir _lastSeen como instante de adquisición. Un evento de broker puede actualizarlo sin una medición nueva. Unificar clientid/device_id/_id requiere tabla de correlación confiable; preferir mapear sobre el modelo real antes que renombrar datos.

### Mediciones convencionales y preservación

El documento original puede ser `soil/nutrients`, `readings`, `measurements` o sobre con payload string. No seleccionar uno como canónico sin muestras. Proponer un discriminador de formato/versión y mappers en be-agro; asignación de tenant/relaciones desde catálogo confiable, no desde un valor libre enviado por hardware.

La fecha de adquisición y _receivedAt son conceptos distintos. BSON Date para adquisición es un candidato para consultas consistentes; si hoy hay strings, relevar tipos, zona, validez y orden antes de acordar transformación. No reemplazar silenciosamente timestamp ausente por recepción.

Mantener brutos e históricos, incluyendo datos parciales. No introducir TTL ni política de retención que elimine registros sin acuerdo. No ejecutar db.createCollection, backfill, creación de índices o cambios de ingesta durante BE-00/BE-01.

## 4. Acceso seguro con datos existentes

1. La sesión verificada resuelve usuario y cliente autorizado.
2. El repository valida campo y área dentro de ese cliente, luego dispositivo y correlación de ID.
3. Consultas de mediciones deben incluir un alcance verificable de cliente en Mongo, directamente si existe tenant confiable, o mediante relación/catálogo y conjunto de dispositivos autorizado cuyo identificador sea inequívoco.
4. Documentos sin correlación verificable no se exponen por suposición. Identificadores reutilizados entre clientes impiden usar device_id aislado como autorización.
5. Listas y agregaciones mantienen el mismo alcance, nunca filtran otros clientes después de recuperarlos.
6. Recurso ajeno/inexistente: 404. No permitir que campo_id/cliente_id del navegador amplíen acceso.

La opción de desnormalizar entityId/campoId/areaId en mediciones puede facilitar índices, pero exige consistencia, responsable y tratamiento de historial de reasignaciones; no está resuelta en esta propuesta.

## 5. Mapeos hacia frontend

| Origen a verificar | Salida pública | Condición |
|---|---|---|
| Campo del catálogo | campo_id | Mantener nivel independiente |
| Área del catálogo | area_id | No mapear campos._id a area_id |
| Identidad pública del dispositivo | device_id | Correlacionar con clientid/_id |
| Fecha de adquisición válida | timestamp UTC ISO 8601 | Recepción no es sustituto implícito |
| soil.humidity o measurements.soil_moisture_reported_pct | humedad {valor,unidad} | Mapeos candidatos; calibración VWC no implícita |
| soil.temperature o measurements.soil_temperature_c | temperatura | Verificar escala/unidad |
| soil.conductivity o measurements.conductivity_us_cm | conductividad | µS/cm→dS/m solo con unidad confirmada |
| nutrients.nitrogen/phosphorus/potassium | nitrogeno/fosforo/potasio | Ausentes en S8; confirmar método y fuente |
| location o geolocation o catálogo | ubicacion {lat,lon} o null | Definir fuente vigente y precedencia |

`readings` no tiene un vocabulario garantizado: requiere muestras y mapper propio. Los distintos JSON de documentos de referencia son ejemplos simulados, no datos del sensor capturados. La especificación usa soil_moisture_reported_pct y el anexo soil_moisture_sensor_pct: elegir nombre/versionado en BE-04.

Procedencia propuesta para magnitudes: medida, estimada por dispositivo, derivada, laboratorio/campo o ausente; método, unidad original, calibración, profundidad, vigencia, referencias de entradas y versión de fórmula cuando corresponda. El formato HTTP de estos metadatos aún no está aprobado. Las seis variables UI se conservan con null para ausencia; no inventar NPK ni pH en S8.

## 6. Índices candidatos para BE-02

Los nombres siguientes se refieren al **modelo propuesto**. Adaptarlos a los campos físicos aprobados y al patrón real de consultas; no ejecutarlos como receta.

| Consulta | Índice convencional candidato |
|---|---|
| Última/histórico por dispositivo y cliente | { entityId: 1, deviceId: 1, timestamp: -1 } |
| Resumen por campo/tiempo | { entityId: 1, campoId: 1, timestamp: -1 } |
| Resumen por área/tiempo | { entityId: 1, areaId: 1, timestamp: -1 } |
| Áreas del campo | { entityId: 1, campoId: 1 } en areas |
| Dispositivos del área | { entityId: 1, areaId: 1 } en dispositivos |
| Identidad Google | googleSub único si proveedor/alta aprobados |
| Alertas persistidas | { entityId: 1, estado: 1, timestamp: -1 }, sujeto a filtros |
| Estado MQTT actual | clientid único solicitado por ingesta; evaluar unicidad real global |

No duplicar índices por defecto: medir cardinalidad, costo de escritura y explain en base aislada. Deduplicación de telemetría por msg_id/seq es propuesta histórica aún no implementada; evaluar claves y duplicados antes de cualquier índice único.

## 7. Relevamiento y eventual compatibilidad

BE-02 debe aportar muestras sanitizadas, nombres físicos, tipos y referencias para toda la cadena, opciones e índices existentes y resolución de lotes. BE-04 acuerda fechas/unidades/procedencia y conversión de documentos antiguos.

Solo después de aprobación: diseñar respaldo, conteos previos, compatibilidad de productores/consumidores, transformación reversible, validación cruzada de clientes y rollback; conservar brutos y fechas inválidas para revisión. Ningún paso de migración se ejecutó aquí.

## 8. Historia preservada

La propuesta anterior (Git base 9cab86f) usaba timestamp Date con timeField/metaField, contexto y equivalencia campos→area_id. Esa arquitectura queda retirada por plan del 05/11 y jerarquía completa. `ddbb.puml` se actualiza como diagrama conceptual, sin afirmar existencia física de colecciones. La alternativa de persistir alertas continúa pendiente; ausencia visual de mediciones sigue a cargo del frontend.

Referencias: [ESPECIFICACION.md](ESPECIFICACION.md), [INFORME_BE00_BE01.md](INFORME_BE00_BE01.md).
