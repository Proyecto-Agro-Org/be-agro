# Informe BE-02 sobre modelo de datos e identificadores MongoDB

**Proyecto:** UADE A26T02 · be-agro
**Fecha:** 16/11/2026
**Estado:** PARCIAL. Análisis documental y propuesta de diseño preparados; inventario Atlas, equivalencias físicas y aprobación de tipos pendientes. No significa Done ni modelo implementado.
**Seguimiento BE-02.1 (16/11/2026):** inspección física BLOQUEADA por falta de conexión Atlas autorizada de solo lectura; ver §15. No se intentó conectar ni se obtuvieron datos reales.
**Rama:** feature/be-02-modelo-datos · integración indicada por el usuario: dev.
**Base preservada:** merge corregido `1bb20f76b7a739f42c75b37b9a64315276560ec1`, que contiene `fc3356f77c3d7992b8009a55376cc4da009cb7c2`.

## 1. Resumen ejecutivo

La jerarquía aprobada es Cliente → Campo → Área → Dispositivo → Mediciones, con Usuario → Cliente. Campo y Área son entidades distintas. Las colecciones serán convencionales; no Time Series.

El código de ingesta usa dos colecciones configurables, por defecto dispositivos y mediciones, pero no garantiza catálogo de clientes/usuarios/campos/áreas, tenant, formato de telemetría ni timestamp de adquisición. No se accedió a MongoDB Atlas: ninguna colección, opción, índice ni tipo físico fue comprobado allí.

El resultado de BE-02 es un modelo lógico con tipos BSON recomendados, restricciones, índices candidatos, una estrategia de correlación y ejemplos verificables. Los nombres físicos y tipos nuevos son **propuestas para aprobación**, no decisiones del equipo ni una descripción de producción. No se resuelve lotes por intuición ni se convierten IDs existentes.

Hallazgo de seguridad: dispositivos recibe un merge de campos arbitrarios de telemetría. Un entityId/areaId dentro de ese documento puede venir del emisor; no es por sí solo una fuente confiable de autorización. Se propone separar catálogo confiable y estado recibido. El lugar físico de ese catálogo es una decisión pendiente.

No se implementan modelos Mongoose, DTOs/OpenAPI, endpoints, validadores ni migraciones. BE-03/BE-04 no se iniciaron; sus requisitos de entrada quedan identificados.

## 2. Fuentes efectivamente revisadas

### 2.1 Repositorio y Git

Se revisaron INFORME_BE00_BE01.md, ESPECIFICACION.md, IMPLEMENTATION_PLAN.md, SCHEMA_PROPUESTA.md, AGENTS.md y DEFINITION_OF_DONE.md; también app.js, package.json y ddbb.puml.

Estado inicial: rama solicitada correcta, árbol limpio, origin https://github.com/Proyecto-Agro-Org/be-agro.git, identidad local Camila Gonzalez / camiiigonzalez1503@gmail.com. HEAD, main y dev locales apuntan al merge corregido. Hay ramas locales backup/* y una feature antigua con los hashes previos: no se tocaron. La feature BE-02 desciende del historial corregido, no de esas copias.

Los documentos BE-00/01 son una foto de la auditoría previa: sus referencias a “solo main”, “no integrado” y hashes antiguos no invalidan el estado Git actual ni autorizan reescribirlos en esta tarea. El PR #1 ya integrado conserva evidencia histórica; la consulta de Issues del backend mostró ese PR cerrado y ningún Issue BE-02 independiente. No se marcaron casillas como terminadas.

### 2.2 Documentación local

Se reconsultó el contenido textual pertinente y las tablas de los diez documentos originales, con lectura ZIP/XML de OOXML y pypdf disponible; no se instalaron dependencias. No se editó ninguna fuente ni se interpretaron imágenes incrustadas no inspeccionadas.

| Fuente dentro de documentacion-referencia | Evidencia usada |
|---|---|
| Plan_Trabajo_Backend_A26T02 (1).docx, 05/11/2026 | §§3,5,7–8: acuerdos, jerarquía, colecciones comunes, aislamiento, IDs y separación de BE-02/03/04 |
| Especificacion_Tecnica_UADE_A26T02_NUEVA_COPIA.docx, 30/10/2026 | §§9–13: topics y JSON 2.2 propuestos, acquisition/received, raw/derived, calidad y colecciones sugeridas; no aprobación física |
| Anexo_Formulas_S8_UADE.docx, 30/10/2026 | §§1,3,5–8: procedencia, dependencia de ensayos y calibración; nombres de humedad no idénticos a la especificación |
| Informe_Frontend_A26T02_Etapa_2.pdf, 10 páginas | pp.4–6 y9: contratos /api/v1, IDs y nulos, sesión provisional; texto anterior al código actual |
| INFORME DE NECESIDADES AGRONOMICAS (1).docx | Tablas de variables químicas/físicas, métodos y profundidades; no se adoptan umbrales como reglas |
| Etapa 1 Propuesta de estructura y funcionalidades de la aplicación web (4).pdf, 10 páginas | Datos por pantalla, pertenencia, vacíos e históricos; propuesta anterior |
| Proyecto A26T02 – Red IoT de Sensores de Suelo con Inteligencia Artificial para Evaluación de NPK y Variables Ambientales-4 (1).docx | Payload ilustrativo device_id/location/soil/nutrients y separación de capas; Python/AWS/otras bases son alternativas históricas |
| SOIL-MB-THC-S-DS.pdf, Rev.04, 38 páginas | pp.2,15–17: humedad reportada, temperatura, CE y registros salinidad/TDS; no NPK/pH |
| Matriz_Comparativa_Sensores_UADE_A26T02.xlsx | Hojas Matriz de cobertura, Catalogo sensores, Criterios y fuentes; S8 y límites de equivalencia agronómica |
| Planner_Universitario_Proyecto_IoT_A26T02 (1).xlsx | Cuatro hojas de planificación/investigación; no confirma stack ni modelo físico; cache de fechas con errores ya documentados |

Precedencia: acuerdos del 05/11 → código/contratos efectivamente existentes → especificación reciente → propuestas históricas. Los documentos referenciados pero no presentes en BE-00/01 (plan Web v2, propuesta unificada 03/11 y DoD externo) no se consideran leídos.

### 2.3 Código remoto, fijado por SHA

- [Frontend](https://github.com/Proyecto-Agro-Org/fe-agro/tree/f30c76dbd7f2f87aa5ef02e0be176f2e112fbb96): HEAD `f30c76dbd7f2f87aa5ef02e0be176f2e112fbb96`, sin cambio respecto de BE-00/01. Revisados src/types/dominio, auth, areas, sensor, historico; src/api/campos; CampoProvider; mocks/data/db y alcance; docs/MODELOS-DOMINIO.
- [Ingesta](https://github.com/Proyecto-Agro-Org/iot-ingest/tree/e6ffda0f0a4b9a18298c239ac34cc61de6b1c3fa): HEAD `e6ffda0f0a4b9a18298c239ac34cc61de6b1c3fa`. Revisados README, config/env, database/mongo, DTO/service/repository de devices/measurements, common/utils y body-parser.

Solo lecturas del conector GitHub; no modificaciones, despliegues ni ejecución de esos servicios.

### 2.4 Límite Atlas

No hay sesión/conector de MongoDB autorizado ni muestras sanitizadas físicas aportadas en esta tarea. No se buscaron credenciales en otros proyectos, no se reutilizaron secretos de ingesta y no se llamó a su health/debug para inferir un inventario.

Faltan: base/colecciones efectivas, listCollections/opciones/validadores, listIndexes, tipos BSON por campo, ejemplos de cada variante, datos huérfanos/duplicados, contexto real de broker y asignaciones. Los métodos de inventario se solicitan al responsable con una cuenta de solo lectura; algunos listados pueden necesitar permisos de metadatos adicionales. No incluir secretos ni información personal en las muestras.

## 3. Inventario de colecciones por nivel de evidencia

Leyenda: C = código; D = documento; A = Atlas comprobado; P = propuesta futura. “No observado en código” no significa “no existe en Atlas”.

| Nombre | C | D | A | P y finalidad |
|---|---|---|---|---|
| clientes | No en be-agro/ingesta | Inventario previo: _id string | No | Raíz empresarial y nombre |
| usuarios | No | Inventario previo: _id string; FE Usuario | No | Identidad interna vinculada a un cliente |
| campos | No | Jerarquía aprobada; FE Campo | No | Campo de un cliente |
| areas | No | Jerarquía aprobada; FE Area | No | Área de un campo |
| lotes | No | Inventario previo: _id string; menciones agronómicas | No | Significado y colección física sin resolver |
| dispositivos | Sí en ingesta, nombre configurable | Inventario previo y README ingesta | No | Estado técnico recibido; catálogo lógico separado o protegido |
| mediciones | Sí en ingesta, nombre configurable | soil/nutrients histórico, readings y JSON S8 propuestos | No | Históricos brutos; modelo de lectura validado |
| alertas | No | FE tipos/mocks y consultas | No | Persistencia opcional, condicionada a fuente/ciclo aprobados |

El backend de consulta no accede aún a ninguna colección. Defaults de ingesta: base iot_sensores, MONGODB_COLLECTION=mediciones y MONGODB_DEVICES_COLLECTION=dispositivos; un entorno puede sustituirlos.

Detalle del inventario documental histórico, sin confirmación Atlas: mediciones._id ObjectId, device_id string, timestamp string; location.lat/lon double, soil.humidity/temperature/conductivity double y nutrients.nitrogen/phosphorus/potassium double. No se conocen las restricciones de presencia/null ni unidades de esos doubles. Para clientes/usuarios/lotes/dispositivos ese inventario solo declaraba _id string; no permite inferir sus relaciones ni validar los catálogos propuestos.

### 3.1 Forma que produce el código actual

| Colección del código | Campos/tipos asegurados por ese camino | Clave/relación | Índices y límites |
|---|---|---|---|
| mediciones | _id generado por driver; _receivedAt: Date; resto objeto JSON libre, _id entrante eliminado | No exige device_id/clientid ni referencias de tenant | insertOne; sin índice temporal o deduplicación declarados |
| dispositivos | clientid: string resuelto; _createdAt/_lastSeen: Date; _id generado al upsert nuevo; datos libres mezclados | updateOne por clientid, sin filtro tenant | Solicita unique {clientid:1}; si falla createIndex lo registra y continúa: no es garantía de unicidad efectiva |
| clientes/usuarios/campos/areas/lotes/alertas | No hay esquema verificable por estos repositorios | Pendiente de muestra | No se pueden afirmar claves/índices físicos |

Los caminos actuales generan ObjectId al omitir _id, pero documentos históricos podrían contener otros tipos: solo Atlas puede confirmar la distribución completa. El README muestra ejemplos, no captura de un dispositivo. Una respuesta HTTP con id string es serialización; no demuestra BSON string en _id.

## 4. Modelo lógico y cardinalidades

```text
Cliente 1 ── 0..N Usuario       Usuario pertenece a 1 Cliente
Cliente 1 ── 0..N Campo         Campo pertenece a 1 Cliente
Campo   1 ── 0..N Área          Área pertenece a 1 Campo
Área    1 ── 0..N Dispositivo   Dispositivo habilitado pertenece a 1 Área
Dispositivo 1 ── 0..N Medición  Medición de dominio resuelta pertenece a 1 Dispositivo
```

La jerarquía está aprobada. Las cardinalidades de hijos y la obligatoriedad de padre son la interpretación de diseño consistente con src/types/dominio.ts y el estado vacío requerido por FE. Dispositivo pendiente de alta y telemetría sin identidad resuelta quedan fuera del catálogo habilitado, no asignados a un cliente ficticio.

No se guardan arrays de IDs de hijos en cada padre como segunda fuente de verdad; las referencias apuntan desde el hijo. Los campos redundantes de cliente/campo en documentos descendientes sirven al filtrado, pero su igualdad con toda la cadena se debe validar: MongoDB no implementa una FK por declarar un campo.

**Lotes:** no se sabe si es unidad agronómica, campo, área o agrupación. No se renombra ni se enlaza por semejanza textual. Solicitar al equipo de datos definición, ejemplos y relaciones. Mientras no exista evidencia, no participa de las consultas autorizadas ni se agrega un nivel obligatorio nuevo.

**Reasignaciones:** propuesta conservadora para MVP: no reutilizar deviceId ni aliases MQTT entre clientes, ni mover un dispositivo con historial bajo una relación nueva sin un diseño temporal aprobado. Si se necesitan movimientos, introducir asignaciones versionadas con intervalos no superpuestos y contexto histórico inmutable. No recalcular el propietario de una medición antigua a partir del área actual.

Diagrama conceptual vigente: [ddbb.puml](ddbb.puml). No representa un relevamiento físico.

## 5. Matriz de identificadores y equivalencias

| Nombre | Clase/origen | Correspondencia comprobada | Recomendación y pendiente |
|---|---|---|---|
| clientid | Externo MQTT; string normalizado por resolver de estado | Usado para upsert/índice en dispositivos de ingesta | Nunca cliente empresarial; alias de transporte a vincular mediante catálogo confiable |
| device_id | Público FE y posible campo del payload | FE lo usa como identidad de Sensor y en rutas /sensores | Mantener string opaco; igualdad con clientid/_id no comprobada |
| deviceId | Convención interna propuesta y alias de entrada ingesta | Resolver de estado acepta body.deviceId y nested.deviceId | No prueba igualdad universal: en dominio se propone nombre interno para device_id |
| _id | Clave física propia de cada colección | Generación por driver en inserciones actuales | No identifica automáticamente al dispositivo, salvo relación explícita aprobada |
| entityId | Referencia interna propuesta al cliente | No exigida por ingesta ni implementada en BE | Derivar de usuario/catálogo confiable; proponer string estable, pendiente Atlas |
| cliente_id | Público FE | Usuario/Campo referencian Cliente.cliente_id | Mapper propuesto desde clave de clientes; no usar parámetro del navegador para autorizar |
| campo_id | Público FE | Area.campo_id referencia Campo.campo_id | Mapper propuesto desde campos._id/campoId; validar dentro del cliente |
| area_id | Público FE | Sensor.area_id referencia Area.area_id | Mapper propuesto desde areas._id/areaId; no equivale a campo_id |
| usuario_id | Público FE | Identidad de Usuario | Mapper propuesto desde usuarios._id; identidad externa es distinta |
| googleSub | Externo proveedor, propuesto | No implementado ni persistido comprobado | Identificar cuenta con proveedor/issuer; email/nombre no son clave de pertenencia |

**Caso comprobado del mock:** area_id=campo_norte pertenece a campo_id=campo_el_molino; sensor_011 pertenece a esa área. Son fixtures de frontend, no IDs reales de Atlas. El prefijo “campo_” de un área no debe usarse para deducir su tipo ni renombrarla.

### 5.1 Resolver real de estado frente a identidad de dominio

device.dto.ts elige el primer ID utilizable en este orden:
body.clientid, clientId, client_id, deviceId, device_id, id;
luego payload.clientid, clientId, deviceId, device_id;
por último query.clientid. El payload puede ser objeto o string JSON. Números finitos pasan a string y strings se recortan en ese resolver. **nested.client_id e id no están en la lista real**, aunque el README generaliza los nombres anidados.

Si llegan aliases en conflicto, el código toma el primero; no prueba que identifiquen al mismo nodo. El camino /ingest no aplica ese resolver. La propuesta de lectura debe detectar discrepancias y marcar identidad ambigua, no escoger silenciosamente uno para asignar cliente. No replicar esa normalización indiscriminadamente sobre IDs públicos existentes; documentar valor original y namespace/origen.

### 5.2 Correlación recomendada

Provisionamiento confiable vincula deviceId público ↔ clientid MQTT exacto y, si existe, device_id de firmware. _id del documento de estado es una referencia física opcional, no la clave pública.

Sincronizar por ID persistido, nunca por nombre, email, topic parecido o localización. Se recomienda unicidad global del deviceId público y del alias MQTT dentro de un broker/namespace. La ingesta actual usa clientid global sin broker: si hay múltiples brokers con IDs repetidos, no es compatible hasta resolver esa colisión. Datos desconocidos o ambiguos no se exponen como datos autorizados.

## 6. Tabla de tipos BSON recomendados

**Propuesta, no contrato físico aprobado.** Si Atlas revela otros tipos, preservar esos datos y diseñar mappers/correlación antes de aprobar cambios.

| Campo lógico/uso | Tipo BSON recomendado | Nulabilidad |
|---|---|---|
| clientes/usuarios/campos/areas._id para catálogo nuevo | string opaco estable | Obligatorio, no null |
| entityId, campoId, areaId, deviceId públicos/internos | string | Obligatorio en dominio habilitado |
| _id de documentos existentes de ingesta | Conservar BSON real; ObjectId generado por camino actual | Obligatorio en persistencia |
| _id de catálogo de dispositivo si se separa | string=deviceId para catálogo nuevo | Obligatorio; no reemplaza _id de dispositivos de ingesta |
| Nombre/email/googleSub/proveedor/versión | string | Nombre requerido; opcionales definidos en §7, no string vacío para desconocido |
| Flags activo/simulado/disponible | bool | Requeridos donde se definen |
| timestampAdquisicion | date | date o null con causa explícita |
| _receivedAt / timestampRecepcion | date | Requerido si recepción conocida; null solo en proyección legacy sin evidencia |
| createdAt/updatedAt | date | Requeridos en catálogo nuevo, no inferidos de payload |
| Valor de magnitud normalizada | double o null | null ante ausencia/invalidez, nunca 0 artificial |
| Valor recibido/raw | Tipo original | No convertir ni completar por esquema |
| Ubicación | object {lat:double,lon:double} o null | No coordenadas=0 por defecto |
| Calidad/procedencia/sourceRef | object | Obligatorio en medición de lectura |
| msgId/secuencia | string / tipo entero a acordar por versión | Opcional, ausente si emisor no lo provee |
| Lecturas | array de objetos de magnitud | Puede estar vacía si frame no es lectura válida |

Se propone date, no el tipo BSON timestamp de replicación. No inferir tiempo de adquisición a partir del ObjectId. Un string con 24 hexadecimales tampoco se convierte automáticamente a ObjectId. Ver [tipos BSON de MongoDB](https://www.mongodb.com/docs/manual/reference/bson-types/).

## 7. Esquema objetivo por entidad

O = obligatorio en documento nuevo/habilitado; ? = opcional (se omite si desconocido); N = admite null explícito. Los nombres son candidatos, sin Mongoose ni aprobación de schema físico.

### 7.1 Cliente y Usuario

| Entidad | Campos | Referencias/invariantes |
|---|---|---|
| Cliente → clientes candidato | O _id:string, nombre:string, activo:bool, createdAt:date, updatedAt:date | _id estable, nombre no clave; cliente sin campos/usuarios válido |
| Usuario → usuarios candidato | O _id:string, entityId:string, nombre:string, activo:bool, createdAt:date, updatedAt:date; ? email:string; ? identidad:{proveedor:string,issuer:string,subject:string} | entityId→clientes._id; un cliente por usuario; identidad requerida al habilitar login federado según flujo futuro |

No se guarda password/token de Google. La decisión de sesión/proveedor concreto y datos HTTP corresponde a BE-03/auth posterior. Para Google, identidad.subject representa sub (equivalente conceptual de googleSub previo); el nombre físico definitivo queda pendiente. No asociar un usuario a un cliente automáticamente por email o dominio sin política aprobada.

### 7.2 Campo y Área

| Entidad | Campos | Referencias/invariantes |
|---|---|---|
| Campo → campos candidato | O _id:string, entityId:string, nombre:string, activo:bool, createdAt:date, updatedAt:date; ? descripcion:string | entityId→clientes._id; muchos campos por cliente |
| Área → areas candidato | O _id:string, entityId:string, campoId:string, nombre:string, activo:bool, createdAt:date, updatedAt:date; ? descripcion:string | campoId→campos._id; entityId debe coincidir con campo; muchas áreas por campo |

No modificar lotes hasta conocer su semántica. No imponer nombres únicos: dos clientes/campos pueden usar el mismo nombre. IDs opacos, no derivados del nombre visible.

### 7.3 Dispositivo: separar catálogo de estado

Modelo lógico Dispositivo en catálogo confiable: O _id:string=deviceId público, entityId:string, campoId:string, areaId:string, nombre:string, activo:bool, createdAt:date, updatedAt:date; ? mqtt:{namespace:string,clientid:string}; ? firmwareDeviceId:string; ? estadoIngestaId:BSON real; N ubicacion:{lat,lon}|null; ? modelo:string; ? profundidadInstalacion:number con unidad registrada.

Referencias: areaId→areas._id; campoId/entityId consistentes con área y campo. No exige medición previa. Un dispositivo provisionado puede no tener alias todavía; no se habilita correlación de telemetría hasta tener uno inequívoco.

El camino de ingesta actual conserva dispositivos como estado recibido (_id BSON, clientid, _createdAt, _lastSeen y campos libres). **No añadir allí referencias de autorización como si estuvieran protegidas.**

Alternativas físicas pendientes:
- Preferida mientras exista merge libre: colección separada de catálogo, nombre candidato catalogo_dispositivos, con permisos de escritura exclusivos del provisionamiento confiable.
- Reutilizar dispositivos solo después de acordar propiedad de campos, escritores y protección que impida sobrescribir tenant/asignación desde telemetría.

La separación es una recomendación basada en código; **catalogo_dispositivos no se afirma existente ni se crea**. Mantener el modelo lógico único para frontend, con mapper que combina catálogo y estado. No se añade CRUD administrativo al alcance.

### 7.4 Medición: bruto persistido y proyección de lectura

Persistencia vigente por código: mediciones con _id generado, _receivedAt Date y body original menos _id. No cambiarlo ni encerrar retroactivamente todo en raw. _receivedAt del body se sustituye por fecha del servidor. El body original recibido no es igual a bytes de mensaje MQTT; no afirmar trazabilidad byte a byte que ingesta no conserva.

**Modelo de lectura recomendado**, construido a partir de bruto y catálogo confiable; no implica nueva colección persistente:

| Campo | Tipo/obligatoriedad | Regla |
|---|---|---|
| sourceRef | O object {coleccion:string,id:BSON real} | Documento bruto trazable; no convertir su _id para comparar |
| deviceId, entityId, campoId, areaId | O string | Solo si correlación y cadena válidas; no copiados como autorización desde payload |
| contextoVersion | O string | Identifica asignación/resolución usada; origen confiable |
| timestampAdquisicion | O N date | Parseo válido según formato aprobado o null |
| timestampRecepcion | O N date | _receivedAt confiable o null con motivo para legacy |
| formatoOrigen | O string | Ej. s8-propuesto-v2.2, legacy-soil, readings-desconocido, emqx-envelope; detección explícita |
| dataStatus | O string | simulated/measured/unknown/invalid; declaración del emisor no prueba autenticidad |
| calidad | O object | Identidad/fecha/campos inválidos, advertencias y versión del mapper |
| lecturas | O array | Entradas con nombreOrigen, pathOrigen, valorOriginal, valor utilizable nullable, unidadOriginal nullable, procedencia, estado |
| msgId, secuencia, sensorId | ? | Preservar solo lo efectivamente recibido; no fabricar para deduplicar |
| ubicacion | O N object | Regla de origen/vigencia pendiente; no reconstruir ubicación pasada con catálogo actual sin marcarlo |

Cada lectura tendrá procedencia medida/estimada_dispositivo/derivada/laboratorio/campo/desconocida y estado presente/ausente/invalida. Si hay cálculo o laboratorio: ? metodo, versionFormula, referenciasEntradas, calibrationId, profundidad/unidad, fechaEnsayo y vigencia. Si faltan insumos no se calcula; registrar causa. Los nombres de estas etiquetas son internos propuestos, no DTO aprobado.

Mediciones sin correlación no forman una Medición de dominio autorizada: quedan como brutos no resolubles con diagnóstico interno. Para rendimiento futuro puede evaluarse una colección normalizada con contexto confiable e índices directos; su nombre, productor y consistencia aún no se aprueban. No es requisito instalar un worker ni duplicar datos en BE-02.

### 7.5 Alertas condicionadas

Si se aprueba persistencia: _id:string, entityId/campoId/areaId/deviceId:string, tipo/severidad/estado:string, descripcion:string, timestamp:date, resueltaAt:date|null, origen/reglaVersion:string y referencias de evidencia. Un dispositivo puede tener 0..N alertas; pertenecen al mismo cliente/asignación.

Si se calculan bajo demanda, no fingir colección física ni historial de resolución. La falta visual de mediciones es responsabilidad del frontend; no crear episodios persistentes ni reglas agronómicas desde umbrales de ejemplo.

## 8. Índices candidatos y restricciones

**No ejecutados.** Son patrones para evaluar sobre campos físicos confirmados, distribución de datos y planes de consulta en entorno aislado. Un índice no concede autorización ni mantiene FK.

| Colección/patrón propuesto | Clave y condición | Propósito |
|---|---|---|
| Todos los catálogos nuevos | _id único provisto por Mongo | Identidad; no duplicar un índice idéntico |
| usuarios | {entityId:1,activo:1}; identidad proveedor+issuer+subject único parcial cuando estén completos | Cuenta confiable sin colisión de usuarios sin identidad federada |
| campos | {entityId:1,activo:1,_id:1} | Listado del cliente con orden estable |
| areas | {entityId:1,campoId:1,activo:1,_id:1} | Áreas del campo autorizado |
| catálogo dispositivo | {entityId:1,areaId:1,activo:1,_id:1} | Dispositivos por área |
| catálogo dispositivo | {entityId:1,campoId:1,_id:1} si consulta real lo necesita | Mapa/resumen por campo |
| catálogo dispositivo | {mqtt.namespace:1,mqtt.clientid:1} único parcial para pares válidos presentes | Alias inequívoco por namespace |
| dispositivos de ingesta | {clientid:1} unique solicitado por código | Verificar creación efectiva/duplicados; no asumir éxito |
| mediciones brutas, formato confirmado | {device_id:1,timestamp:-1,_id:-1} O {clientid:1,_receivedAt:-1,_id:-1} según formato | Consulta de dispositivos previamente autorizados y fecha correspondiente |
| Proyección persistida futura, si se aprueba | {entityId:1,deviceId:1,timestampAdquisicion:-1,_id:-1}, parcial para adquisición válida | Última/histórico filtrado por tenant; no índice operativo sobre campos inexistentes |
| Proyección persistida futura | {entityId:1,campoId:1,timestampAdquisicion:-1} o área, solo según consultas | Resúmenes; evaluar costo de escritura/almacenamiento |
| Alertas si se persisten | {entityId:1,estado:1,timestamp:-1}; variantes área según filtros | Listado; orden severidad necesita regla de orden acordada, no orden lexicográfico accidental |
| Deduplicación futura | {namespace,deviceId,msgId} único parcial cuando ID válido y contrato idempotente aprobado | No usar fecha/valor iguales como prueba de duplicado |

En el legado no hay entityId fiable que permita “crear el índice y resolver aislamiento”. Se requiere primero catálogo/correlación y filtro de dispositivos; después índices sobre el path y tipo efectivamente persistidos. No usar string temporal heterogéneo como índice ordenado cronológicamente ni filtrar adquisición usando recepción sin avisar.

Los índices únicos deben revisarse contra duplicados antes de crearlos; los opcionales requieren un filtro parcial adecuado para no tratar ausencias/null como claves repetidas. Las consultas deben incluir las condiciones que permitan usar el índice parcial. Ver [índices únicos](https://www.mongodb.com/docs/manual/core/index-unique/) y [parciales](https://www.mongodb.com/docs/manual/core/index-partial/).

No TTL ni borrado de históricos. No fijar retención/granularidad de Time Series. No asumir índices extra porque Mongo pueda crearlos en otra configuración.

## 9. Trazabilidad, formatos y anomalías

| Situación | Observado | Tratamiento de lectura propuesto |
|---|---|---|
| JSON S8 measurements | Propuesta documental v2.2, no schema impuesto | Mapper versionado; conservar unidad y procedencia de cada path; sin convertir unidades en BE-02 |
| JSON soil/nutrients | Propuesta histórica | Mapper independiente; nutrients presente no implica S8 ni medición directa |
| readings libre | Ejemplo de README | Claves/método/unidad por confirmar; no alias automático “hum”→humedad VWC |
| Sobre EMQX payload string | README y parser tolerante | Parseo controlado de un nivel/versionado, conservar sobre/payload; no confiar en cliente transmitido |
| Fecha origen ausente o inválida | Ingesta no la valida | timestampAdquisicion null con causa, bruto intacto; no sustituir por _receivedAt |
| Recepción | Servidor agrega _receivedAt | Fecha distinta; identificar si salida representa adquisición o recepción |
| Parcial/ausente | JSON libre | Mantener campo ausente en bruto; lectura de respuesta null y motivo según contrato futuro |
| Valor inválido/tipo inesperado | JSON libre | No coaccionar "abc", "" o "NaN" a cero; valor utilizable null y diagnóstico; conservar valorOriginal |
| Duplicado/reentrega | insertOne sin dedup | Conservar documentos; marcar candidato por msgId válido si existe; no eliminar ni sumar doble sin regla aprobada |
| ID desconocido | /ingest lo permite | No asignar por defecto; diagnóstico de correlación, sin exposición a un cliente |
| Aliases contradictorios | Resolver toma primero | Propuesta: no resolver dominio hasta revisar ambigüedad |
| Evento broker /status | Mezcla campos de estado | _lastSeen no demuestra nueva medición; no generar puntos de suelo desde evento |
| Reasignación histórica | Sin soporte demostrado | Bloquear atribución retrospectiva; requerir asignaciones versionadas antes de mover historial |

S8 entrega humedad reportada, temperatura y CE; salinidad/TDS son estimados por dispositivo. No mide NPK ni pH. %RH no implica humedad volumétrica. Valores de laboratorio y derivados tienen métodos/profundidades/vigencias distintos y no se mezclan como lectura IoT contemporánea.

No se aplican conversiones, precisión ni umbrales nuevos. BE-04 decidirá el catálogo de unidades y métodos; los nombres de origen pueden sugerir una unidad documental, pero no certifican la unidad física de un documento arbitrario. La fecha de adquisición puede llegar fuera de orden: no sobrescribir histórico con la última recepción ni afirmar que el último documento es la última lectura válida de cada variable.

## 10. Seguridad y aislamiento multicliente

Flujo propuesto, sin implementar middleware:

1. La identidad se verifica en backend y resuelve usuario interno activo con entityId desde fuente confiable. Un token demo, email del navegador o cliente elegido no sirven de autorización.
2. Campo se consulta por _id + entityId autorizado.
3. Área por _id + campoId + entityId, validando la relación persistida.
4. Dispositivo del catálogo por deviceId + areaId/campoId + entityId coherentes.
5. Resolver solo los aliases provisionados de ese dispositivo y formato permitido.
6. El repository consulta mediciones con ese ID exacto/namespace y rango válidos antes de recuperarlas; si existe proyección confiable, añade entityId directamente.
7. Agregaciones y listados conservan ese mismo filtro; no recuperar primero otros clientes para descartarlos en memoria.
8. Campo/área/dispositivo ajeno o inexistente → 404 según política vigente; sin sesión → 401. Medición bruta sin vínculo verificable no se entrega.

No interpolar objetos Mongo/$operadores enviados por navegador ni elegir paths arbitrarios del payload. Las firmas de repository futuras reciben contexto y filtros tipados; lista blanca de formatos/paths. No se agregan roles por endpoint.

Separar catálogo confiable de telemetría libre es necesario para no aceptar un entityId fabricado por el emisor. En el futuro la identidad DB de ingesta debe tener permisos limitados a sus colecciones. Si se comparte una sola credencial de escritura total, la separación de nombres por sí sola no protege el catálogo.

La ingesta pública sin auth permite falsificar payloads incluso con un ID válido: aislamiento de lectura no equivale a autenticidad del dato. El endurecimiento de ingesta pertenece a sus responsables y es dependencia de producción, sin modificarla en esta tarea.

Para el legado con tenant indirecto, permitir consulta solo si el alias es inequívoco para toda su vida y existe evidencia de propiedad. De lo contrario la pertenencia no puede probarse con el esquema disponible; no “resolver” usando entityId libre ni confianza en nombres.

## 11. Compatibilidad con frontend e ingesta

| Punto | Contrato observado | Compatibilidad de la propuesta |
|---|---|---|
| IDs de catálogo FE | Strings y relaciones por *_id | Mappers mantienen mismos valores; IDs BSON internos no se exponen como documentos Mongo |
| Área | campo_id opcional temporalmente en AreaApi; obligatorio en modelo completo | No confundir tipo tolerante de HTTP con referencia opcional en dominio habilitado |
| Sensores de área | Respuesta omite area_id porque está en la ruta | El mapper incorpora contexto autorizado, sin inventar padre |
| Rutas | /sensores/:deviceId y campo_id | No se renombran a /dispositivos ni se alteran filtros |
| Catálogo campos | Solo /auth/demo/campos en MSW | No afirmar GET /campos real existente; acuerdo en BE-03 |
| Última lectura | MedicionSensor con seis variables {valor,unidad}; ultima_medicion null | S8 entrega null en NPK ausente; metadatos internos no se agregan unilateralmente al DTO |
| Histórico | puntos timestamp/valor nullable, unidad y truncado | Filtrar adquisición válida; política de anomalías/última parcial en BE-03/04 |
| Estado/mapa | fecha nullable y ubicación nullable | Sin mediciones no es error; _lastSeen no se equipara a adquisición |
| Escritura ingesta | JSON libre + metadatos; upsert clientid | No cambiar mensajes, IDs o colección de escritura; lectura mediante correlación/mappers |
| Fuente de tenant | FE simula usuario-cliente; ingesta no lo asegura | Catálogo separado confiable, no tenant del request/payload |

El informe BE-00/01 conserva los demás pendientes de auth/errores. Este documento no los cierra ni crea DTOs/OpenAPI de BE-03.

## 12. Ejemplos JSON sintéticos

**Todos los datos siguientes son ficticios, simulados y no insertables como receta de producción.** Los nombres e IDs sim-* no representan dispositivos reales ni son una convención aprobada de generación. Catálogos muestran el diseño propuesto; raw representa formatos compatibles con las fuentes. $date/$oid son Extended JSON para distinguir BSON de strings HTTP.

### 12.1 Dos clientes, usuarios, campos, áreas y catálogo confiable

```json
{
  "dataStatus": "simulated",
  "clientes": [
    {"_id":"sim-cliente-a","nombre":"Cliente A simulado","activo":true,"createdAt":{"$date":"2026-11-01T00:00:00Z"},"updatedAt":{"$date":"2026-11-01T00:00:00Z"}},
    {"_id":"sim-cliente-b","nombre":"Cliente B simulado","activo":true,"createdAt":{"$date":"2026-11-01T00:00:00Z"},"updatedAt":{"$date":"2026-11-01T00:00:00Z"}}
  ],
  "usuarios": [
    {"_id":"sim-usuario-a","entityId":"sim-cliente-a","nombre":"Persona A simulada","activo":true,"email":"a@example.invalid","createdAt":{"$date":"2026-11-01T00:00:00Z"},"updatedAt":{"$date":"2026-11-01T00:00:00Z"}},
    {"_id":"sim-usuario-b","entityId":"sim-cliente-b","nombre":"Persona B simulada","activo":true,"email":"b@example.invalid","createdAt":{"$date":"2026-11-01T00:00:00Z"},"updatedAt":{"$date":"2026-11-01T00:00:00Z"}}
  ],
  "campos": [
    {"_id":"sim-campo-a","entityId":"sim-cliente-a","nombre":"Campo A simulado","activo":true,"createdAt":{"$date":"2026-11-01T00:00:00Z"},"updatedAt":{"$date":"2026-11-01T00:00:00Z"}},
    {"_id":"sim-campo-b","entityId":"sim-cliente-b","nombre":"Campo B simulado","activo":true,"createdAt":{"$date":"2026-11-01T00:00:00Z"},"updatedAt":{"$date":"2026-11-01T00:00:00Z"}}
  ],
  "areas": [
    {"_id":"sim-area-a","entityId":"sim-cliente-a","campoId":"sim-campo-a","nombre":"Área A simulada","activo":true,"createdAt":{"$date":"2026-11-01T00:00:00Z"},"updatedAt":{"$date":"2026-11-01T00:00:00Z"}},
    {"_id":"sim-area-b","entityId":"sim-cliente-b","campoId":"sim-campo-b","nombre":"Área B simulada","activo":true,"createdAt":{"$date":"2026-11-01T00:00:00Z"},"updatedAt":{"$date":"2026-11-01T00:00:00Z"}}
  ],
  "catalogoDispositivosPropuesto": [
    {"_id":"sim-device-a","entityId":"sim-cliente-a","campoId":"sim-campo-a","areaId":"sim-area-a","nombre":"S8 A simulado","activo":true,"mqtt":{"namespace":"sim-broker","clientid":"sim-mqtt-a"},"firmwareDeviceId":"sim-fw-a","ubicacion":null,"createdAt":{"$date":"2026-11-01T00:00:00Z"},"updatedAt":{"$date":"2026-11-01T00:00:00Z"}},
    {"_id":"sim-device-b","entityId":"sim-cliente-b","campoId":"sim-campo-b","areaId":"sim-area-b","nombre":"S8 B simulado","activo":true,"mqtt":{"namespace":"sim-broker","clientid":"sim-mqtt-b"},"ubicacion":null,"createdAt":{"$date":"2026-11-01T00:00:00Z"},"updatedAt":{"$date":"2026-11-01T00:00:00Z"}},
    {"_id":"sim-device-sin-lecturas","entityId":"sim-cliente-a","campoId":"sim-campo-a","areaId":"sim-area-a","nombre":"Sin lecturas simulado","activo":true,"ubicacion":null,"createdAt":{"$date":"2026-11-01T00:00:00Z"},"updatedAt":{"$date":"2026-11-01T00:00:00Z"}}
  ]
}
```

Los usuarios son registros de catálogo, no sesiones autenticables: no incluyen una credencial/proveedor inventados. La correspondencia sim-fw-a ↔ sim-mqtt-a ↔ sim-device-a es **solo una correlación ficticia provisionada en este ejemplo**.

### 12.2 Brutos completos y parciales del S8 simulado

“Completo” significa los cinco registros S8 documentados, no seis variables FE ni catorce requerimientos agronómicos. Los labels y números no certifican unidades ni calibración productiva.

```json
{
  "dataStatus": "simulated",
  "medicionesRaw": [
    {
      "_id":{"$oid":"700000000000000000000001"},
      "_receivedAt":{"$date":"2026-11-16T12:00:05Z"},
      "schema_version":"2.2","data_status":"simulated","message_type":"telemetry",
      "clientid":"sim-mqtt-a","device_id":"sim-fw-a","msg_id":"sim-msg-1",
      "timestamp":"2026-11-16T12:00:00Z",
      "measurements":{"soil_moisture_reported_pct":25.0,"soil_temperature_c":21.5,"conductivity_us_cm":1000,"salinity_mg_l":550,"tds_mg_l":500}
    },
    {
      "_id":{"$oid":"700000000000000000000002"},
      "_receivedAt":{"$date":"2026-11-16T12:30:03Z"},
      "schema_version":"2.2","data_status":"simulated","message_type":"telemetry",
      "clientid":"sim-mqtt-a","device_id":"sim-fw-a","msg_id":"sim-msg-2",
      "timestamp":"2026-11-16T12:30:00Z",
      "measurements":{"soil_temperature_c":22.0,"soil_moisture_reported_pct":null}
    },
    {
      "_id":{"$oid":"700000000000000000000003"},
      "_receivedAt":{"$date":"2026-11-16T12:10:02Z"},
      "schema_version":"2.2","data_status":"simulated","message_type":"telemetry",
      "clientid":"sim-mqtt-b","timestamp":"2026-11-16T12:10:00Z",
      "measurements":{"soil_temperature_c":20.0}
    }
  ],
  "sinLecturas":{
    "device_id":"sim-device-sin-lecturas",
    "ubicacion":null,
    "ultima_comunicacion":null,
    "ultima_medicion":null
  }
}
```

El bruto parcial conserva campo null y otros ausentes; no agrega NPK. La forma completa de SensorDetalle y unidades HTTP se acuerda en BE-03/04; sinLecturas es un extracto para mostrar semántica, no DTO nuevo aprobado.

### 12.3 Casos negativos y resultado esperado de diseño

```json
{
  "dataStatus":"simulated",
  "casos":[
    {
      "caso":"mqtt_desconocido",
      "raw":{"clientid":"sim-mqtt-no-registrado","timestamp":"2026-11-16T12:00:00Z","measurements":{"soil_temperature_c":20}},
      "esperado":{"correlacion":"sin_resolver","clienteAsignado":null,"exponer":false}
    },
    {
      "caso":"fecha_invalida",
      "raw":{"clientid":"sim-mqtt-a","timestamp":"2026-99-99T12:00:00Z","_receivedAt":{"$date":"2026-11-16T12:00:05Z"}},
      "esperado":{"timestampAdquisicion":null,"motivo":"timestamp_invalido","usarRecepcionComoAdquisicion":false}
    },
    {
      "caso":"cruce_clientes",
      "contextoBackend":{"usuarioId":"sim-usuario-a","entityId":"sim-cliente-a"},
      "request":{"campo_id":"sim-campo-b","device_id":"sim-device-b","cliente_id":"sim-cliente-b"},
      "esperado":{"status":404,"consultarMedicionesDeB":false,"aceptarClienteDelRequest":false}
    },
    {
      "caso":"tenant_en_telemetria",
      "raw":{"clientid":"sim-mqtt-a","entityId":"sim-cliente-b","areaId":"sim-area-b"},
      "esperado":{"autorizarConPayload":false,"diagnostico":"contexto_declarado_inconsistente"}
    },
    {
      "caso":"aliases_en_conflicto",
      "raw":{"clientid":"sim-mqtt-a","device_id":"sim-fw-de-otro-nodo"},
      "esperado":{"correlacion":"ambigua","exponer":false}
    },
    {
      "caso":"valor_invalido",
      "raw":{"clientid":"sim-mqtt-a","measurements":{"soil_temperature_c":"abc"}},
      "esperado":{"valorUtilizable":null,"conservarValorOriginal":"abc","reemplazarPorCero":false}
    },
    {
      "caso":"reentrega",
      "documentos":[
        {"_id":{"$oid":"700000000000000000000004"},"clientid":"sim-mqtt-a","msg_id":"sim-msg-repetido"},
        {"_id":{"$oid":"700000000000000000000005"},"clientid":"sim-mqtt-a","msg_id":"sim-msg-repetido"}
      ],
      "esperado":{"candidatoDuplicado":true,"borrarDocumentos":false,"politicaLectura":"pendiente"}
    }
  ]
}
```

Los estados de diagnóstico anteriores son etiquetas de ejemplo internas, no códigos HTTP nuevos. No se usa una consulta Mongo real ni se insertan datos para validar estos casos.

## 13. Brechas y decisiones pendientes

| ID local de decisión | Pregunta/evidencia requerida | Impacto y responsable a acordar |
|---|---|---|
| D02-01 | Inventario Atlas sanitizado, opciones, BSON y listIndexes | Sin ello el modelo físico no se confirma; equipo de datos/ingesta |
| D02-02 | Qué significa lotes y cómo se relaciona con Campo/Área | No fusionar ni migrar; dominio/datos |
| D02-03 | Autoridad del catálogo y colección protegida o separación | Tenant confiable; backend/ingesta/datos |
| D02-04 | Catálogo de aliases por broker, IDs actuales y colisiones | Correspondencia clientid/device_id/_id; IoT/ingesta |
| D02-05 | Tipos string propuestos y preservación de tipos existentes | Aprobar antes de implementar models; datos/backend |
| D02-06 | Reasignaciones/reutilización de IDs e historia de ubicación | Evitar lectura de historial de otro cliente; dominio |
| D02-07 | Versiones reales de telemetría, paths, timestamps, parciales y duplicados | Mapper y consultas correctas; ingesta/BE-04 |
| D02-08 | Método/unidad/origen/calibración de cada magnitud | No imponer catálogo nuevo; Agronomía/BE-04 |
| D02-09 | Política de identidad de usuario y sesión real | Campo-cliente no se resuelve desde email; auth/BE-03 |
| D02-10 | Persistir alertas o calcularlas; fuente/ciclo | No crear colección ni worker por defecto; dominio |
| D02-11 | Endurecimiento de ingesta y propiedad de credenciales DB | Integridad de fuente/catálogo; responsables ingesta/datos |

No se considera bloqueado todo el análisis: el diseño y los fixtures se entregan. El cierre de BE-02 como modelo físico aprobado sigue **parcial**, pendiente D02-01…06 y revisión del equipo; no se marca Done ni se inventa una equivalencia.

### Relevamiento mínimo para levantar la limitación

Solicitar muestras redactadas de cada colección conocida, tipos/valores de IDs y referencias, nombre de base y colección reales, opciones/índices/validadores, ejemplos de documentos vacíos/parciales/legacy, sobre EMQX real y su relación broker/firmware. Confirmar duplicados/orfandad y origen de cada dato. No pedir contraseñas, tokens, URI con secretos ni copias masivas de producción.

La comprobación debe ser de solo lectura con permisos explícitos: sin createIndex, syncIndexes, seeds ni upserts. No ejecutar endpoints de ingesta como forma de prueba.

## 14. Recomendaciones y validaciones de cierre

### Para el siguiente trabajo, sin ejecutarlo

BE-03: usar el modelo como entrada para acordar DTOs/OpenAPI/Zod; mantener *_id y /sensores; cerrar identidad real, campos, errores, fecha/nulos y metadatos públicos. Los tipos de persistencia no son DTOs.

BE-04: catálogo de paths/nombres/unidades/precisión, conversión autorizada, adquisición/recepción, lectura parcial/última válida, procedencia y calibración; no inferir NPK/pH ni VWC desde S8.

Antes de implementar Mongoose: cerrar Atlas/IDs/lotes/catálogo confiable. Mongoose deberá respetar nombres físicos y tipos aprobados, sin creación automática de colecciones/índices sobre producción.

### Verificaciones de esta entrega

- Se revisaron relaciones/cardinalidades y fixtures de dos clientes, lecturas parciales, ausencia, IDs desconocidos y cruces.
- Validación documental de JSON, referencias de fixtures, BSON representado en Extended JSON, enlaces locales y coherencia de diagrama.
- npm test: **5/5 aprobadas, 0 fallos**, suite existente health/CORS/404, sin modificar tests ni instalar dependencias.
- Validación documental ejecutada: **3 bloques JSON parseables**, dos clientes y sus referencias consistentes, tres dispositivos, cinco lecturas en el frame completo, parcial con null y dispositivo sin lecturas; siete casos negativos, fecha inválida rechazada por el comprobador local y cruce de cliente detectado en fixtures. No es una prueba del backend futuro.
- git diff --check **sin errores**; comprobado el conjunto exacto de INFORME_BE02_MODELO_DATOS.md, SCHEMA_PROPUESTA.md y ddbb.puml. Enlaces Markdown locales válidos, fences balanceados y sin caracteres de reemplazo; jerarquía del PUML comprobada textualmente.
- Sin cambios funcionales, paquetes, endpoints, frontend/ingesta o MongoDB; sin cambios de rama/configuración/credenciales/commits/push/PR.
- No se probaron índices/queries reales, Atlas, auth ni persistencia: no existen aún en este backend y no se escribe en producción.
- El PUML se valida textualmente (sin renderer instalado/invocado); los JSON sintéticos no prueban integración ni reemplazan schemas runtime futuros.

Estado Git comprobado: feature/be-02-modelo-datos con esos tres documentos, sin staged changes; dev/main y HEAD conservan 1bb20f76b7a739f42c75b37b9a64315276560ec1. El siguiente paso es revisar el modelo con responsables de datos/IoT y obtener evidencia sanitizada, no implementar BE-03 automáticamente.

## 15. BE-02.1 — Verificación física detenida por falta de acceso

**Fecha:** 16/11/2026. **Estado:** BLOQUEADA la inspección Atlas; BE-02 continúa PARCIAL. Ningún resultado de este apartado debe interpretarse como colección inexistente, conteo cero o ausencia de relaciones en producción.

### 15.1 Comprobación del acceso y fuentes reconsultadas

- Se revisaron el informe BE-02, SCHEMA_PROPUESTA.md, ddbb.puml y la sección de persistencia de ESPECIFICACION.md; se reconsultó el extracto del plan del 05/11 correspondiente a modelo físico, índices y timestamps. Continúan vigentes las fuentes técnicas/agronómicas y límites de §2.
- Entre las herramientas habilitadas no se identificó una sesión/conector de MongoDB Atlas disponible para este trabajo.
- Se enumeraron **solo nombres** de variables del entorno del proceso que contuvieran Mongo/Atlas: ninguno. No se imprimieron valores ni cadenas de conexión.
- En la raíz de be-agro se encontró únicamente .env.example, que define CORS_ORIGINS; no hay archivo .env local. No se encontró configuración de conexión dentro de .vscode en este checkout. Esto no afirma nada sobre sesiones de otras aplicaciones o máquinas, que no se inspeccionaron.
- Se releyeron las copias de código de ingesta conservadas en el contexto de BE-02: src/config/env.ts, src/database/mongo.ts y repositories de devices/measurements del commit e6ffda0f0a4b9a18298c239ac34cc61de6b1c3fa. No se consultó un nuevo HEAD remoto en BE-02.1 ni se ejecutó ese servicio.
- La ingesta requiere MONGODB_URI y permite configurar base/colecciones; su configuración de producción no está disponible aquí. No se buscaron secretos en otros repositorios, cuentas o gestores de credenciales, ni se reutilizaron credenciales de escritura.

**Conclusión de acceso:** no hay una conexión identificada y autorizada de solo lectura utilizable desde este entorno. Se detuvo la inspección remota de Atlas antes de cualquier conexión, consulta o muestreo. No se llamó a endpoints de ingesta ni se ejecutaron sus repositories: el de dispositivos incluye createIndex y upsert, incompatibles con esta inspección.

### 15.2 Resultado del inventario solicitado

| Evidencia requerida | Resultado BE-02.1 | Estado previo que se conserva |
|---|---|---|
| Colecciones comprobadas en Atlas | No relevadas; ninguna comprobada en esta tarea | dispositivos/mediciones son defaults del código, no inventario físico |
| Tipos BSON observados | Sin observaciones de documentos reales | Los tipos de §3.1 se derivan de código; §6 sigue siendo propuesta |
| Índices existentes | No listados | createIndex(clientid) está en código; no prueba existencia efectiva |
| Ejemplos sanitizados reales | No obtenidos | Los ejemplos de §12 continúan siendo exclusivamente sintéticos |
| Relaciones físicas confirmadas | Ninguna nueva demostrada | La jerarquía de dominio está aprobada, no su implementación BSON |
| Relaciones pendientes | lotes, cliente/campo/área, dispositivo/medición, aliases MQTT y referencias de tenant | Mantener D02-01…06 abiertas |
| Timestamps/formatos/parcialidad | No muestreados en Atlas | Diferencia adquisición/recepción documentada; tipo real de timestamp pendiente |
| Diferencias respecto de la propuesta | No contrastables todavía | No convertir recomendaciones en migraciones ni afirmar coincidencia física |

clientid sigue identificado **por código** como clave de correlación del estado de un dispositivo MQTT; eso no demuestra la correspondencia real con device_id ni con _id. La presencia de entityId/cliente_id/campo_id/area_id en mediciones, las unidades, los campos ausentes y la coexistencia de formatos necesitan evidencia física. No se realizaron cálculos ni conversiones sobre datos reales.

### 15.3 Acceso necesario para continuar

El responsable de Atlas debe habilitar una conexión identificada para el proyecto y autorizada expresamente para **lectura de la base correspondiente**, incluyendo los permisos necesarios para listar colecciones/opciones e índices y leer pequeñas muestras. Deben quedar identificados el clúster, la base y el alcance permitido, con acceso de red habilitado por su administrador sin cambiar producción desde esta tarea.

Las credenciales deben configurarse mediante el mecanismo seguro acordado (sesión/conector o secreto local protegido); **no pegarlas en el chat, incorporarlas al informe ni versionarlas**. La existencia de una URI por sí sola no prueba que la cuenta sea de solo lectura. Verificar esa condición antes de utilizarla. No ampliar permisos, instalar paquetes ni reutilizar una cuenta de ingesta sin autorización adicional.

Como alternativa, el equipo de datos puede aportar un inventario redactado de nombres/opciones de colección, índices y tipos BSON, junto con pequeñas muestras sanitizadas que conserven tipos y relaciones mediante seudónimos consistentes. En ese caso se documentará como evidencia suministrada por el equipo, no como acceso directo a Atlas. No se solicitan volcados completos, datos personales ni secretos.

Con acceso habilitado: retomar listados y muestreo acotado de solo lectura; comprobar variantes, referencias y tipos sin modificar documentos ni ejecutar createIndex/syncIndexes/seeds/migraciones. Recién entonces contrastar las propuestas, resolver lotes y acordar qué necesita ajustar el equipo para completar BE-02.

### 15.4 Validación y conservación del trabajo previo

- npm test ejecutado en BE-02.1: **5/5 aprobadas, 0 fallos** (health, CORS y 404). No verifica Atlas.
- git diff --check ejecutado: sin errores; comprobación final repetida tras actualizar este apartado.
- Al iniciar ya estaban modificados SCHEMA_PROPUESTA.md y ddbb.puml, y existía INFORME_BE02_MODELO_DATOS.md sin seguimiento, como entrega de BE-02. Se preservó ese trabajo. En BE-02.1 se actualizó únicamente este informe; no corresponde cambiar el schema o diagrama sin evidencia física nueva.
- Sin conexión ni escrituras MongoDB, nuevas dependencias, cambios funcionales, cambios de frontend/ingesta, configuración, ramas, commits, push o PR. BE-03 no se inició.

**Próximo paso:** obtener la conexión autorizada de lectura o evidencia sanitizada del responsable de Atlas. Hasta entonces, BE-02.1 queda detenida y BE-02 no puede cerrarse como modelo físico verificado.
