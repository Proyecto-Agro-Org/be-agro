# AGRO-DB-01 — Modelo integrado, identificadores y consultas

19/11/2026. Diseño de trabajo y contratos internos; **no es inventario Atlas ni DDL aprobado**.
Versiones y evidencia en [informe](INFORME_AGRO_DB01_ARQUITECTURA_INTEGRADA.md).

## Decisiones técnicas adoptadas

Dos dominios de almacenamiento y permisos independientes: empresarial y recepción IoT.
Frontend consume DTOs de be-agro, nunca MongoDB/credenciales ni datos crudos directamente.
Jerarquía empresarial: **Cliente → Campo → Área → Sensor lógico**. Una asociación explícita
conecta el sensor lógico con una identidad técnica de un dispositivo dentro de un source/namespace.
La medición cruda conserva su dispositivo técnico; el acceso comercial deriva de asociaciones
confiables, intervalos y procedencia. Ningún nombre/email/clientid MQTT crea esa relación.

No se duplica BE-09.5. Se reutilizan catálogo auth, usuarios/cliente, sesiones/challenges,
versionado y capacidades privadas de BE-09.1/2. No se modifica su modelo físico ni sus writers.

## Colecciones: evidencia y propiedad

| Dominio / colección | Estado comprobado | Dueño de escritura / permiso recomendado |
| --- | --- | --- |
| Ingesta / dispositivos | Nombre default de config IoT; configurable. Upsert por clientid y cuerpo libre | IoT técnico; sin autoridad sobre cliente/área/sensor empresarial |
| Ingesta / mediciones | Nombre default; insertOne por mensaje y _receivedAt Date agregado | IoT insert; sin escritura de usuarios/pertenencias/asociaciones |
| Empresarial / `<prefix>_users`, `_clients` | Modelos auth implementados BE-09.5; sin observación de base real | Writer administrativo BE controlado; runtime consulta catálogo |
| Empresarial / `<prefix>_sessions`, `_challenges` | Modelos técnicos implementados; sin prueba MongoDB real | Infraestructura de sesión BE; no acceso desde IoT/FE |
| Empresarial / campos, áreas, sensores lógicos | Entidades lógicas confirmadas por FE; nombres/BSON físicos pendientes | Backend; administración confiable, no payload IoT |
| Empresarial / asociaciones temporales y control por dispositivo | Contratos DB01 implementados; colección/modelo físico todavía propuesto | Backend administrativo + coordinación de handoff; no autoasignación por telemetría |
| Lectura / atribución verificada o sidecar de recepción | Alternativa propuesta para datos históricos de procedencia demostrable | Proceso confiable controlado; no copia ciega del payload |

Ni clientes agronómicos definitivos ni colecciones observadas se deducen de esos nombres.
`lotes` sigue sin equivalencia verificada con campo/área. Las colecciones físicas de Atlas no
fueron listadas ni muestreadas. Nombres ilustrativos `agro_business_<entorno>` e
`iot_sensores_<entorno>` requieren aprobación; **iot_sensores** es solo el default del código IoT.

Permisos propuestos: FE ninguno; IoT insert mediciones/update dispositivos; BE lectura IoT
con proyección y consultas acotadas, lectura catálogo/relaciones y escritura de sesiones;
administración catálogo/asociaciones con rol separado; operador DDL fuera del runtime.
Separar namespaces aunque compartan clúster; preferir bases por entorno/servicio según permisos.
No copiar una URI de ingesta al backend suponiendo que selecciona la misma base: IoT llama
client.db(MONGODB_DB), mientras BE exige base explícita en su configuración MongoDB.

## Matriz de identificadores

| ID | Origen / tipo / unicidad y estabilidad | Almacenamiento / referencias | Transformaciones permitidas y prohibidas / riesgo |
| --- | --- | --- | --- |
| realm | BE configuración; enum de entorno | Todas las claves de catálogo/sesión/asociación | Solo configuración confiable. No header/query público ni mezclar test/preview/production |
| userId | Catálogo BE; string estable, único por realm | Usuarios, sesión y contexto privado | Mapper explícito. No email/Google token como ID interno |
| issuer/sub | Google verificado; strings canónicos, únicos por realm | Catálogo auth | Canonicalización del adaptador existente; no unión por email/dominio |
| clientId empresarial | Catálogo BE; string lógico estable, único por realm | Usuario/pertenencia/sesión y jerarquía | Nunca convertir desde MQTT clientid, nombre o request |
| cliente_id FE | Campo string de DTO usuario/cliente/campo | Respuesta de API, datos demo en MSW | Mapper explícito desde clientId confiable. Valor recibido del FE no autoriza |
| campo_id | ID lógico FE string | Campo→cliente y Área→campo | Conservar ID opaco. El prefijo campo_ no determina clase: mocks antiguos campo_norte son áreas |
| area_id | ID lógico FE string | Área→campo, Sensor→área | No equiparar a lotes ni derivar desde nombre |
| sensorId lógico | Nuevo nombre interno inequívoco para estación/recurso empresarial | Sensor→área y asociaciones históricas | No copiar _id de dispositivo sin tabla aprobada |
| device_id FE | ID de Sensor en src/types/dominio.ts | Rutas /sensores/:deviceId y DTOs de sensor/histórico/mapa | Conservar nombre público; proponer mapper sensorId→device_id, pendiente FE/BE. No renombrar HTTP aquí |
| device_id crudo IoT | Campo opcional del payload; tipo libre | A veces mediciones/dispositivos; no obligatorio | Solo mapping explícito de source/formato. No asumir igualdad con device_id FE |
| clientid MQTT | Broker/dispositivo/payload/query según resolver; IoT acepta número→string y trim | Clave técnica dispositivos; opcional en mediciones | DB01 exige string exacto + kind + sourceId. No aplicar coerciones/aliases IoT a IDs empresariales |
| ID Mongo dispositivo | Generado por driver cuando se ignora _id enviado; ObjectId esperado, BSON por verificar | Documento técnico, distinto de clientid | Representación etiquetada object-id/string. No transformar implícitamente un string24hex a ObjectId |
| ID medición | Generado por insertOne; respuesta IoT id.toString() | Histórico crudo, namespace de colección/source | Mantener tipo + valor + source; el mismo texto string/ObjectId no es la misma identidad |
| associationId/revision | Backend administrativo; ID estable y entero seguro | Intervalo sensor/dispositivo/cliente | Versión CAS, no reutilizar ID ni tomarlo del MQTT |
| sourceId / clockId | Registro de fuentes confiable del backend | Namespace técnico y autoridad temporal de asociación | No datos públicos. Igual texto MQTT en sources distintos no demuestra mismo dispositivo |

DB01 implementa `TechnicalDeviceKey {kind,value}` y claves persistidas `{kind,value}`.
El metadata mapper conserva ObjectId frente a string sin coerción, elimina datos arbitrarios y
no convierte clientid técnico a cliente comercial. No existe identificador físico de hardware
autenticado obligatorio en el contrato actual de ingesta; documentarlo no lo crea.

## Política temporal y diez escenarios

Intervalos **[validFrom, validTo)**, con validTo=null solo para extremo abierto; el tiempo de
atribución se define con una autoridad de recepción comprobada, no el timestamp del emisor.
La asociación proviene de administración confiable y conserva historia; no reescribirla como
simple device.clientId actual. Reasignación efectiva sin retroactividad, cierre/apertura versionados.

| Escenario | Política |
| --- | --- |
| 1 Dispositivo en Área A | Lectura requiere sensor/área/campo/cliente y asociación verificados, identidad técnica única |
| 2 Traslado a Área B | Cerrar A/abrir B; mantener sensor lógico anterior como recurso distinto si representa estación del área |
| 3 Otro campo | Validar ambas jerarquías; cada intervalo conserva su campo, sin mover documentos históricos |
| 4 Otro cliente | Ningún cliente hereda intervalos del anterior; no consultar por asociación actual solamente |
| 5 Recibida antes | Solo intervalo antiguo si identidad/tiempo/atribución están demostrados |
| 6 Recibida después | Solo nuevo intervalo si handoff/epoch confiable demuestra que pertenece al nuevo ámbito |
| 7 Atrasada | No basta usar recepción para atribuirla al nuevo cliente. Si puede provenir de buffer viejo, cuarentena hasta prueba de epoch o handoff sin pendientes |
| 8 Timestamp manipulado | No gobierna autorización/intervalos; conservar como dato no verificado, sin corregirlo silenciosamente |
| 9 Sin asignación | No entregar lectura comercial; history puede estar vacío y dispositivo desconocido resuelve404 |
| 10 Asociación duplicada/solapada | Rechazar antes de planificar; nunca seleccionar primer resultado |

**Recepción confiable ≠ atribución confiable.** _receivedAt demuestra que el servidor recibió
un cuerpo; con webhook público no demuestra quién lo emitió. Relojes diferentes, reenvíos y
colas pueden cruzar la frontera. Una garantía fuerte requiere identidad autenticada y epoch
de asignación validado por servicio confiable o handoff verificable sin datos pendientes,
con autoridad temporal común. Un booleano en el payload no constituye esa prueba.

El código requiere política de source controlada por servidor con authenticatedIdentity y
verifiedTemporalAttribution, clockId coincidente y asociación verified. Current IoT debe quedar
**unverified/quarantined**. Los casos positivos de tests son fuentes sintéticas, no aprobación real.
No inferir esos flags de campos libres `_verified`, epoch o clientId enviados a /ingest.

Índice único por dispositivo+validFrom no evita solapamientos de intervalos. La inicialización
futura necesita protocolo de writer con CAS/guardia por dispositivo y transacción o mecanismo
demostrado para cierre/apertura. Un índice parcial para una sola asociación abierta tampoco
resuelve todo el histórico. Esos writers/modelos no se implementan por suposición en DB01.

## Contratos internos, filtros e índices candidatos

Contrato lógico en [association.contracts.ts](src/telemetry/association.contracts.ts).
Los filtros empresariales siguientes son **semánticos** hasta confirmar BSON/nombres BE-02:

| Operación interna | Predicado mínimo y relaciones | Índice candidato |
| --- | --- | --- |
| Listar campos | realm=scope, clientId=context; orden estable por id | realm,clientId,id |
| Listar áreas | Lo anterior + fieldId; comprobar campo del cliente en storage | realm,clientId,fieldId,id |
| Listar sensores | Lo anterior + areaId; comprobar área→campo | realm,clientId,fieldId,areaId,id |
| Dispositivo asociado | Scope + sensorId + intervalo; luego source/kind/key técnico exacto | Asociación por realm,clientId,sensorId,validFrom; dispositivo por clave técnica confirmada |
| Última medición | Solo intervalos propios comprobados y clave técnica; ordenar recepción/id desc, candidato limitado por intervalo | Campo técnico confirmado, _receivedAt desc, _id desc |
| Histórico | Intersección request∩asociación∩tiempo no futuro; filtrar en MongoDB, no en memoria después de leer otros clientes | Mismo índice técnico+recepción; paginación estable por tiempo/id |
| Estado técnico | Solo dispositivo actualmente autorizado y metadata cuya procedencia/fecha sea válida | Clave técnica única; no usar _lastSeen global de nueva asignación para cliente anterior |
| Dashboard | Agregar referencias/mediciones ya acotadas a cliente/campo e intervalos propios | Índices de jerarquía más índices técnicos; no conteos globales de debug |

El planner implementado solo prepara **history**, con revalidación de SessionService.current(),
lookup de asociaciones dentro del storage y comprobación global acotada de solapamientos por
dispositivo. Los demás contratos quedan tipados/documentados; no son consultas/endpoints implementados.
El source confirma deviceField exclusivamente clientid o device_id; _receivedAt es Date del servidor.
No se elige automáticamente entre aliases/nested JSON; hay que confirmar formato antes del adapter real.

Predicado generado: igualdad exacta del identificador técnico + _receivedAt >=from y <to,
guardias $expr del tipo escalar string/date y $literal en el valor de identidad. Nunca usa cliente_id
de un payload. El mapper de metadata **no devuelve lecturas ni cuerpos raw**; no es normalizador BE-04.
Un ejecutor futuro debe aplicar presupuesto global de filas/página, índices y límite, revalidar antes
y después de ejecutar, y fusionar candidatos solo entre ventanas propias. Limit de cada plan no es
una promesa de paginación HTTP global; se limita a1000 por segmento y64 asociaciones, sin ejecutarlas aquí.

## Puntos no comprobados y cambios por repositorio

Atlas: BSON, índices, relaciones, opciones reales, identidad del hardware y formatos históricos no observados.
IoT: autenticar source/dispositivo, definir epoch/handoff, deduplicación y esquema técnico; no cambiarlo aquí.
FE: acordar alias device_id lógico, fechas/unidades/nulls, auth/errores y endpoint real de campos; no modificarlo.
BE: conservar catálogo auth existente y añadir solo contratos/plans/mappers; futuros adapters concretos
requieren el inventario y permisos de lectura. Sin modelos agronómicos definitivos ni BE-10.
