# Propuesta de esquema MongoDB para be-agro

**Actualización:** 16/11/2026 · BE-02, preservando acuerdos de BE-01.
**Estado:** parcial; propuesta lógica preparada, sin comprobación física en Atlas ni aprobación de tipos/colecciones nuevos.
**Decisión confirmada:** colecciones convencionales, **no Time Series**. No se ejecutan migraciones.

El desarrollo detallado por entidad, obligatoriedad, tipos BSON recomendados, cardinalidades, matriz de IDs, índices y ejemplos está en [INFORME_BE02_MODELO_DATOS.md](INFORME_BE02_MODELO_DATOS.md). Este resumen no convierte esas recomendaciones en schema aprobado. BE-03/04 no se iniciaron.

## 1. Qué se conoce y qué falta verificar

El inventario histórico compartido enumera clientes, usuarios, lotes y dispositivos con _id string; mediciones con _id ObjectId, device_id string, timestamp string, location, soil y nutrients. No es una inspección actual de Atlas.

El código de iot-ingest (`e6ffda0f0a4b9a18298c239ac34cc61de6b1c3fa`) usa por defecto base iot_sensores y colecciones mediciones/dispositivos, configurables. Inserta JSON libre con _receivedAt Date y _id generado; actualiza dispositivos por clientid string con _createdAt/_lastSeen Date. No garantiza tenant, campo, área, formato de magnitudes ni fecha de adquisición. El clientid MQTT identifica dispositivo; **no significa cliente del sistema**.

No se verificaron opciones de colecciones, índices efectivos, documentos reales ni versiones de Atlas. El índice único clientid está solicitado por el repository de ingesta; su existencia física no fue comprobada. La falta de un model de clientes/áreas en ingesta tampoco demuestra que esas colecciones no existan.

Revisión BE-02 del mismo commit de ingesta: `createIndex` captura su fallo y permite continuar; por ello ni siquiera una respuesta exitosa del servicio prueba unicidad efectiva. El resolver de estado acepta aliases y toma el primero; `/ingest` no aplica ese resolver. El merge libre puede sobrescribir campos como `entityId` o `areaId` enviados por un emisor: no usarlos como fuente confiable de autorización.

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
| Dispositivo lógico / catálogo por acordar | deviceId público, entityId, campoId, areaId, nombre, alias MQTT provisionado y ubicación opcional; separar de campos libres de ingesta |
| dispositivos de ingesta | Preservar _id BSON, clientid, _createdAt/_lastSeen y estado recibido; no suponer contexto de autorización protegido |
| mediciones | Preservar _id BSON, _receivedAt y body original menos _id; proyectar referencias verificables, adquisición/recepción y procedencia en lectura, sin migrar el bruto |
| alertas | Solo si se aprueba persistencia: cliente/relaciones, tipo, severidad, descripción, estado, apertura/resolución |

No se propone sobrescribir _lastSeen como instante de adquisición. Un evento de broker puede actualizarlo sin una medición nueva. Unificar clientid/device_id/_id requiere tabla de correlación confiable; preferir mapear sobre el modelo real antes que renombrar datos.

El informe BE-02 recomienda strings estables para IDs de catálogos nuevos y referencias de dominio, conservando el BSON físico existente en ingesta. Es una propuesta condicionada al relevamiento, no una conversión de documentos ni una equivalencia demostrada. Campo/Área/Usuario/Cliente usan IDs públicos string en el frontend; `campo_norte` es un **area_id** del mock, no un campo por su prefijo.

Se propone catálogo de dispositivos protegido, separado del estado libre mientras la ingesta no proteja sus campos. El nombre `catalogo_dispositivos` es solo candidato; no existe evidencia de esa colección ni se crea aquí. Unificarlo con `dispositivos` exige acordar escritores/propiedad de campos. Sin permisos de DB separados, nombres distintos no bastan para garantizar protección.

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

Mientras no se apruebe contexto temporal, no reasignar un dispositivo con historial ni reutilizar sus aliases entre clientes. La relación actual no debe transferir automáticamente datos antiguos a otro tenant. Si la propiedad histórica no se puede probar, los brutos quedan sin exposición autorizada. El endurecimiento de la ingesta pública sigue siendo una dependencia de integridad, distinta del aislamiento de lectura.

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
| Última/histórico en proyección persistida futura, si se aprueba | { entityId: 1, deviceId: 1, timestampAdquisicion: -1, _id: -1 }, condicionado a fecha válida/contexto confiable |
| Legado con device_id y timestamp realmente confirmados | { device_id: 1, timestamp: -1, _id: -1 }, dispositivo previamente autorizado; no aplicar a strings temporales heterogéneos |
| Legado con clientid y fecha de recepción | { clientid: 1, _receivedAt: -1, _id: -1 }, no equivale a histórico por adquisición |
| Resumen por campo/área en proyección futura | { entityId: 1, campoId: 1, timestampAdquisicion: -1 } o areaId, según consulta aprobada |
| Áreas del campo | { entityId: 1, campoId: 1 } en areas |
| Dispositivos del área | { entityId: 1, areaId: 1 } en catálogo confiable por acordar |
| Identidad federada | proveedor/issuer/subject único parcial si proveedor/alta y campos aprobados; googleSub sigue como nombre histórico candidato |
| Alertas persistidas | { entityId: 1, estado: 1, timestamp: -1 }, sujeto a filtros |
| Estado MQTT actual | clientid único solicitado por ingesta; evaluar unicidad real global |

No duplicar índices por defecto: medir cardinalidad, costo de escritura y explain en base aislada. Deduplicación de telemetría por msg_id/seq es propuesta histórica aún no implementada; evaluar claves y duplicados antes de cualquier índice único.

No crear índices sobre campos propuestos como si la ingesta ya los produjera. Evaluar índices parciales para identidades/aliases opcionales y msgId presente; timestamp/valores iguales no prueban duplicación. El detalle de opciones, límites y fuentes oficiales está en el informe BE-02 §8.

## 7. Relevamiento y eventual compatibilidad

BE-02 debe aportar muestras sanitizadas, nombres físicos, tipos y referencias para toda la cadena, opciones e índices existentes y resolución de lotes. BE-04 acuerda fechas/unidades/procedencia y conversión de documentos antiguos.

Solo después de aprobación: diseñar respaldo, conteos previos, compatibilidad de productores/consumidores, transformación reversible, validación cruzada de clientes y rollback; conservar brutos y fechas inválidas para revisión. Ningún paso de migración se ejecutó aquí.

## 8. Historia preservada

La propuesta anterior (Git base 9cab86f) usaba timestamp Date con timeField/metaField, contexto y equivalencia campos→area_id. Esa arquitectura queda retirada por plan del 05/11 y jerarquía completa. `ddbb.puml` se actualiza como diagrama conceptual, sin afirmar existencia física de colecciones. La alternativa de persistir alertas continúa pendiente; ausencia visual de mediciones sigue a cargo del frontend.

Referencias: [ESPECIFICACION.md](ESPECIFICACION.md), [INFORME_BE00_BE01.md](INFORME_BE00_BE01.md).

## 9. Resultado de BE-02

El diseño lógico y los ejemplos quedan preparados para revisión, con inventario separado por código/documentación/Atlas/propuesta. Ninguna colección se comprobó en Atlas; siguen pendientes lotes, tipos BSON físicos, catálogo confiable, correlación MQTT y reasignaciones. No marcar BE-02 como integrado ni convertir esos pendientes en hechos.

La rama de esta entrega es `feature/be-02-modelo-datos`, basada en el historial corregido de BE-00/01; destino indicado por el usuario: `dev`. No se hicieron cambios de rama, commits, push ni PR. Ver [informe BE-02](INFORME_BE02_MODELO_DATOS.md) para evidencia, decisiones y límites de BE-03/04.
