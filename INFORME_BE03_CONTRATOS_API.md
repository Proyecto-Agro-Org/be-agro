# Informe BE-03 sobre contratos API DTOs y OpenAPI

**Proyecto:** UADE A26T02 · be-agro
**Fecha:** 16/11/2026
**Estado:** parte documental preparada, contrato en revisión; parcial hasta cerrar decisiones de auth, campos, datos y aprobación FE/BE. No es implementación ni Done.
**Rama independiente:** feature/be-03-contratos-api, creada desde origin/dev en `1bb20f76b7a739f42c75b37b9a64315276560ec1`.
**BE-02:** PR #2 permanece Draft, sin fusionar; se consultó como referencia remota, no se incorporaron sus archivos/diff.
**Límite:** no se inicia BE-04 ni se accede a Atlas.

## 1. Resultado y alcance

Se preparó una OpenAPI 3.1 inicial en JSON, formato equivalente permitido por el pedido y parseable sin instalar YAML. Incluye la única ruta actual /health y nueve operaciones observadas en clientes/tipos/MSW de frontend; las operaciones de negocio están rotuladas como no implementadas en be-agro.

Se describen sus Request/Response DTOs y ejemplos Zod en Markdown, sin crear .ts funcionales ni modificar src/package. Campos y sesión cuentan con formas observadas y decisiones explícitas, sin inventar rutas definitivas. Última medición forma parte de SensorDetalle, no se añade un endpoint separado.

Se preservan nombres públicos, prefijo /api/v1, filtros campo_id, separación Campo/Área, nulls y formas de respuesta actuales. El formato estándar de errores es el objetivo acordado, con una incompatibilidad identificada que FE debe resolver antes de integrar.

No se aprueba un esquema físico, un mecanismo de Google/sesión, la equivalencia lotes ni conversiones de unidades. La propuesta BE-02 sigue siendo evidencia documental incompleta por falta de Atlas.

## 2. Git y separación de entregas

Antes de cambiar de rama se verificaron status limpio, origin del repositorio universitario, nombre Camila Gonzalez y email local camiiigonzalez1503@gmail.com. Se ejecutó git fetch origin con la cuenta universitaria configurada. Se creó feature/be-03-contratos-api desde origin/dev, sin modificar las ramas main/dev.

Base dev: merge corregido 1bb20f7 que incorpora el commit BE-00/01 corregido fc3356f. BE-02 está en feature/be-02-modelo-datos / commit 28556ff485f2a9f2f2239c0a612ac623dc33fdef. No se hizo merge/cherry-pick ni se copiaron INFORME_BE02_MODELO_DATOS.md, SCHEMA_PROPUESTA.md o ddbb.puml de esa entrega. El schema/diagrama locales siguen idénticos a dev.

Los documentos previos contienen estados de su fecha (solo main/antes de PR). No se reescriben sus acuerdos ni se actualizan casillas a Done para resolver esa historia. Ningún commit/push/PR forma parte de este trabajo.

## 3. Fuentes leídas y jerarquía

Se revisaron ESPECIFICACION.md, IMPLEMENTATION_PLAN.md, AGENTS.md, DEFINITION_OF_DONE.md, README, código de app/health y la auditoría previa de BE-00/01 disponible en dev. Los acuerdos del plan del 05/11 prevalecen sobre propuestas anteriores.

Documentación local reconsultada mediante extractos textuales disponibles en documentacion-referencia:
- Plan de Trabajo Backend A26T02 (05/11), apartados de contratos/DTO/Zod/jerarquía y backlog.
- Informe Frontend Etapa 2, especialmente contratos de pantallas, nulos/errores y modo MSW.
- Propuesta de estructura de aplicación web, pantallas y rutas de referencia.
- Especificación Técnica UADE (30/10), JSON propuesto S8 y separación recepción/adquisición.
- Anexo de Fórmulas S8, procedencia, nulls y límites de derivación.
- Informe agronómico, variables/métodos/profundidad; no se adoptan sus umbrales como reglas productivas.

No se interpretaron imágenes/diagramas incrustados como evidencia física. No se tocaron archivos fuente locales ni se versiona documentacion-referencia.

Referencias de código consultadas por GitHub, fijadas por SHA:
- [fe-agro](https://github.com/Proyecto-Agro-Org/fe-agro/tree/f30c76dbd7f2f87aa5ef02e0be176f2e112fbb96): src/api/client, login, campos, areas, areaDetalle, dashboard, sensor, historico, mapa, alertas; todos los tipos correspondientes y handlers MSW; mocks/data/alcance y generadores.
- [iot-ingest](https://github.com/Proyecto-Agro-Org/iot-ingest/tree/e6ffda0f0a4b9a18298c239ac34cc61de6b1c3fa): configuración, DTOs/controladores/repositories de dispositivos/mediciones. No se ejecutaron: incluyen escrituras/creación de índices.
- [PR #2 Draft](https://github.com/Proyecto-Agro-Org/be-agro/pull/2), head 28556ff: se leyó su informe remoto para dependencias de datos y bloqueo Atlas. No se presupone aprobado.
- [OpenAPI 3.1.0](https://spec.openapis.org/oas/v3.1.0): formato JSON, schemas y referencias. Nulabilidad se expresa con null/anyOf, sin nullable propio de OpenAPI 3.0.
- [Zod API](https://zod.dev/api): ejemplos documentales de strings/objetos/fechas/coerción; versión definitiva pendiente, sin instalación.

Los HEAD de FE/ingesta siguen coincidiendo con los examinados previamente. El contenido real del código es fuente para el estado observado; no se deducen garantías de runtime a partir de interfaces.

## 4. Entregables

| Archivo | Función |
|---|---|
| [docs/openapi.json](docs/openapi.json) | OpenAPI 3.1 inicial: diez operaciones, schemas, parámetros, seguridad observada y errores objetivo |
| [docs/CONTRATOS_DTO_ZOD.md](docs/CONTRATOS_DTO_ZOD.md) | Tipos TS, Request/Response por operación y schemas Zod como diseño, no código de aplicación |
| [docs/MATRIZ_COMPATIBILIDAD_BE03.md](docs/MATRIZ_COMPATIBILIDAD_BE03.md) | Inventario por pantalla/método/ruta, headers/auth, parámetros, estados, vacíos y diferencias |
| [docs/EJEMPLOS_BE03.json](docs/EJEMPLOS_BE03.json) | Datos sintéticos positivos/negativos, éxito/vacío/null y casos semánticos |
| [docs/DECISIONES_BE03.md](docs/DECISIONES_BE03.md) | Decisiones D03-01…14, clasificación, evidencia y condiciones para aprobar |
| INFORME_BE03_CONTRATOS_API.md | Este informe de alcance, fuentes, resultados y límites |

No se modifican documentos existentes: los acuerdos se preservan y las decisiones de esta entrega quedan acotadas a borrador.

## 5. Rutas documentadas y alcance de aprobación

Las rutas de negocio siguientes son **referencias actuales de FE/MSW**, no endpoints desplegados del backend. Se mantienen para discutir el contrato; login real y alertas tienen bloqueos expresos. Sus formas de éxito se conservan; validación/error estándar son objetivo que requiere revisión.

| Método y ruta | Operación / DTORequest | DTOResponse | Alcance |
|---|---|---|---|
| GET /health | GetHealth; DTORequest no aplica | GetHealthResponse | Implementado, público, proceso sin DB, fuera de /api/v1 |
| POST /api/v1/auth/login | PostLoginRequest {body:{email,password}} | PostLoginResponse (LoginResponse en OpenAPI) | Forma FE existente, no aprobación de login productivo por contraseña |
| GET /api/v1/dashboard/resumen | GetDashboardRequest {query:{campo_id}} | GetDashboardResponse | Referencia FE; agregación autorizada pendiente |
| GET /api/v1/areas | GetAreasRequest {query:{campo_id}} | GetAreasResponse | Lista/ref. de áreas, no confundir campos |
| GET /api/v1/areas/{areaId} | GetAreaRequest {params,query} | GetAreaResponse | Recurso ajeno/inexistente 404 |
| GET /api/v1/areas/{areaId}/sensores | GetAreaSensoresRequest {params,query} | GetAreaSensoresResponse | El área viene de la ruta; lista vacía válida |
| GET /api/v1/sensores/{deviceId} | GetSensorRequest {params,query} | GetSensorResponse | Incluye ultima_medicion nullable, sin ruta nueva |
| GET /api/v1/sensores/{deviceId}/historico | GetHistoricoRequest {params,query} | GetHistoricoResponse | variable/desde/hasta/limit y campo_id |
| GET /api/v1/mapa/sensores | GetMapaRequest {query:{campo_id}} | GetMapaResponse | Mantener sensores sin coordenadas |
| GET /api/v1/alertas | GetAlertasRequest {query} | GetAlertasResponse | Forma FE, fuente/persistencia sin aprobar |

**Campos:** se define GetCamposResponse {campos:Campo[]} y tipo de request sin params/query/body para el mock observado. GET /api/v1/auth/demo/campos existe solo en MSW. GET /api/v1/campos es una sugerencia del plan, no ruta final aprobada; queda fuera de paths y expresada en x-pending-contracts.

**Sesión:** POST /auth/google-demo y POST /auth/demo/sesion son únicamente MSW; sus DTOs de referencia están en Markdown. No se documentan como operaciones productivas ni se inventan /auth/me, /auth/logout, refresh, callback Google o body id_token. La recuperación/logout reales están pendientes de decisión. El código actual del frontend limpia sesión localmente y recupera identidad únicamente en modo mock.

**Última medición:** es UltimaMedicion dentro de GetSensorResponse. Se define el componente completo sin añadir /ultima-medicion ni renombrar /sensores a /dispositivos.

El prefijo /api/v1 aparece directamente en paths, con servidor relativo /. No se añade otro /api/v1 al server para evitar duplicación. Ninguna URL de producción se declara validada.

## 6. DTOs y validación propuesta

Cada GET de negocio representa params/query en su DTORequest; no body. Origin/Accept/Authorization son transporte, no contexto de tenant decidido por un request DTO. Sin entrada, se documenta expresamente que no aplica.

Los DTOs de éxito son estructuralmente compatibles con los tipos FE en nombres, envoltorios y campos opcionales/nullable:
- Login mantiene token requerido, usuario/cliente opcionales; IDs de UsuarioLogin opcionales.
- AreaApi.campo_id sigue opcional por transición del cliente, sin volver opcional la pertenencia del área en el dominio.
- SensorDeArea omite area_id; SensorDetalle/Mapa/Histórico lo requieren.
- Medida exige valor nullable y unidad:string; en snapshot las seis variables están presentes aunque valor sea null.
- Ultima_medicion=null representa dispositivo sin lectura; ubicación y fechas operativas nullable. Cero real sigue siendo número válido.
- Histórico tiene puntos timestamp/valor nullable, unidad y truncado. No contiene documentos BSON.
- Dashboard/Mapa/Alertas conservan sus formas y conteos.

Validación runtime propuesta en ejemplos Zod:
- IDs string opacos, no vacíos/solo espacios, sin conversiones BSON ni parsing de prefijos.
- Query escalar, chequeo de multiplicidad previo a Zod; rechazo de campos desconocidos como propuesta.
- limit decimal positivo normalizado a number. Default500/max1000 de histórico y default50/max200 alertas provienen de mocks; cliente histórico envía 1000. No son capacidad de Atlas demostrada.
- UTC de salida, zona e histórico desde<hasta acordados; perfil RFC3339 restringido (segundos obligatorios, T/Z mayúsculas y sin segundos intercalares) y rango de alertas propuestos. Inputs locales implícitos no se admiten en diseño.
- Respuestas cerradas a extras, número finito, conteos no negativos, enums, nullabilidad y coordenadas válidas.
- Relaciones/tenant/fiabilidad del dato no se resuelven con schemas: necesitan catálogo/servicios/repositories autorizados.

El generador mock histórico permite desde==hasta y usa Date.parse, max1000/default500; alertas parsea fechas pero no verifica rango ni rechaza todos los enums inválidos. Los cambios más estrictos están anotados en la matriz y D03-05/10: no afirmar equivalencia runtime con MSW.

Los bloques Zod son diseño para migración/implementación posteriores. No hay schemas ejecutables, importaciones ni cambio de dependencias en este backend. Se diferencia la entrada HTTP limit:string de la salida DTO limit:number/default.

## 7. Errores y compatibilidad

Formato objetivo acordado:

```json
{"error":{"code":"RESOURCE_NOT_FOUND","message":"Recurso no disponible"}}
```

| Código | HTTP de diseño | Semántica |
|---|---|---|
| VALIDATION_ERROR | 400 | Params/query/body mal formados; no diagnóstico interno |
| UNAUTHENTICATED | 401 | Falta sesión o credencial inválida/expirada |
| ACCESS_DENIED | 403 reservado | Solo denegación explícita aprobada; no roles por endpoint ni revelar recurso ajeno |
| RESOURCE_NOT_FOUND | 404 | Recurso inexistente o fuera del cliente/campo/área autorizado |
| INTERNAL_ERROR | 500 | Falla inesperada, mensaje seguro y registro interno sin secretos |

ACCESS_DENIED está definido como componente, no agrega nuevas reglas de permisos. Los endpoints de negocio usan 404 de ocultación; no prometen un 403 diferenciador de tenant. No se inventan conflictos/429 para rutas sin reglas aprobadas.

El parser actual FE espera {error:string}; un objeto no puede pasarse como string seguro solo por un cast TypeScript. Requiere adaptar leerMensajeError y pruebas de error/expiración antes de integrar. No se devuelve una unión ambigua para ocultar el cambio.

**Health permanece intacto:** éxito {status:ok}; error real CORS 403 {error:string}, handler500 legado. El 404 de rutas desconocidas hoy es HTML Express; la respuesta uniforme para negocio/404 centralizado es futura. Este documento no cambia app ni tests.

## 8. Filtros fechas y casos vacíos

Las ocho consultas de datos de Dashboard, áreas, detalle/lista de sensores, histórico, mapa y alertas envían campo_id. La consulta privada demo de campos es una excepción: GET /auth/demo/campos usa solo el Bearer, sin campo_id ni cliente_id en query. En las ocho consultas de datos, el mock exige una sola ocurrencia no vacía, obtiene cliente desde token demo y verifica campo/área/sensor. La API real deberá usar identidad confiable y datos persistidos.

- Dashboard/áreas/área/sensor/histórico/mapa/alertas: campo_id selecciona dentro del cliente, no autoriza otro.
- Alertas: area_id opcional dentro del campo y filtros combinables tipo/estado/severidad/fechas/limit. Orden semántico severidad y fecha, no alfabético.
- Mapa: los filtros UI por área/estado son locales en la versión actual; no se agregan parámetros HTTP nuevos.
- Histórico: variable, desde, hasta obligatorios; limit opcional. Orden ascendente, truncado según puntos adicionales. Bordes inclusivos propuestos y pendientes; no imponer ventana de 30 días/paso30min del generador.
- Dashboard: cinco alertas por fecha e incluye resueltas en mock; contador de activas separado.
- Lista vacía es 200 con []; dashboard sin datos tiene conteos0, listas[] y fecha null.
- Área válida sin sensores devuelve [] en su lista, no 404; área inexistente/ajena es 404.
- Sensor sin lectura mantiene ficha y ultima_medicion:null, sin cero artificial. Ubicación inválida se mapea a null sin retirar el sensor.
- Histórico sin puntos: puntos[], truncado:false. Sin alertas: total0, lista[] y limit aplicado.

El formato de fecha HTTP no decide si un origen es adquisición/recepción ni si se permite la última válida por variable. Eso sigue pendiente de BE-02/04.

## 9. Seguridad y aislamiento

Sesión verificada → usuario interno → cliente autorizado → campo → área → dispositivo → mediciones. Validar toda la cadena y filtrar en cada consulta/agregación de repository. No leer otros clientes para después eliminarlos de la respuesta.

Ni cliente_id ni entityId del navegador, preferencias del selector, email sin verificación o campos libres de telemetría prueban propiedad. La query estricta propuesta los rechaza si no están declarados, pero incluso si un frontend anterior los envía, nunca amplían autorización.

Bearer es el transporte observado; no se afirma que sea JWT, que Google esté implementado ni que la UI pruebe sesión real. Si el equipo aprueba cookies, cambiar conjuntamente cliente, OpenAPI, CORS/credentials/CSRF y pruebas. No se agregan roles por endpoint.

El origen CORS no sustituye identidad. No registrar tokens/password/body completo ni exponer consultas/stack. El handler de errors y logging se implementarán en etapa autorizada.

## 10. Dependencias de BE-02 y BE-04

| Pendiente | DTOs/endpoints afectados | Consecuencia |
|---|---|---|
| Alias clientid/device_id/_id | GetSensor, GetHistorico, GetAreaSensores, GetMapa, Dashboard/Alertas | Mantener ID público; correlación/tenant desde catálogo confiable; no queries productivas por suposición |
| lotes, campos, áreas y BSON reales | Campos/áreas y todos los filtros campo_id/area_id | No fusionar entidades ni convertir string a ObjectId |
| Autoridad de catálogo/reasignación | Todas las lecturas privadas | La asignación actual no traslada automáticamente historia de otro cliente |
| Timestamp adquisición/recepción y lecturas parciales | UltimaMedicion, histórico, fechas de Dashboard/estado | No usar _receivedAt/_lastSeen como medición por defecto |
| Unidades, procedencia y método | Medida, histórico, mapa y snapshot de sensor | unidad string; datos ausentes null; ningún enum/rango/conversión nuevo |
| Alertas de fuente aprobada | GetAlertas, Dashboard y conteos | No persistencia/worker/episodios de desconexión asumidos |
| Auth/usuario-cliente | Login, campos, protección de todas las rutas | Datos MSW no constituyen sesión confiable |

S8 no mide NPK ni pH; humedad reportada no equivale a VWC sin calibración. Este documento no calcula ni prescribe conversiones/umbrales de BE-04.

## 11. Ejemplos y validaciones

Los ejemplos JSON son sintéticos, sin credenciales reales ni resultados de Atlas. Incluyen éxito/vacío de todas las operaciones, identidad opcional, snapshot S8 con NPK null y cero legítimo, puntos históricos con huecos, errores estándar/legacy y casos negativos. Campos se prueba como componente aislado sin ruta productiva.

Se preparó un comprobador local acotado en la carpeta de referencia excluida. Verifica JSON, refs locales, operaciones/params/seguridad, ejemplos y un subconjunto de restricciones JSON Schema; no es validador completo OpenAPI ni ejecución de Zod. No se distribuye como prueba funcional del backend futuro.

Herramientas disponibles consultadas: no se encontraron openapi_spec_validator, openapi_schema_validator, jsonschema ni PyYAML en Python, ni swagger-parser, openapi-schema-validator, AJV, Zod o TypeScript en los módulos del runtime consultado. No se instaló nada.

Resultados ejecutados:

- npm test: **5/5 aprobadas, 0 fallos**; health/CORS/404 siguen con su comportamiento actual.
- JSON estricto sin claves duplicadas/NaN y chequeos propios acotados: **10 operaciones, 58 schemas**, referencias locales resueltas, IDs de operación únicos, parámetros path completos, campo_id requerido en las ocho lecturas de datos documentadas, seguridad y respuestas coherentes. Las nueve operaciones FE y sus nombres de parámetros coinciden con el inventario observado; no se agregaron rutas productivas demo/campos/sesión.
- **43 casos estructurales** positivos/negativos y ejemplos de respuestas dentro de OpenAPI contrastados contra el subconjunto de schema que utiliza el comprobador; **9 casos semánticos documentados**, con comprobación local de rangos inválidos y cruce de cliente. No se ejecutaron todos los casos semánticos, endpoints de negocio ni un motor completo JSON Schema.
- Comparación textual automatizada de **24 interfaces/DTOs del frontend**: mismos nombres y campos requeridos/opcionales; enum de seis variables idéntico. No es compilación TypeScript ni prueba de equivalencia semántica de todas las restricciones.
- Enlaces locales válidos y bloques Markdown balanceados. Revisión final con git diff --check y chequeo de espacios finales de los nuevos archivos; conjunto esperado de seis documentos nuevos, sin diff funcional ni staged changes.
- No hay cambios de package/lock, app/tests, documentos del modelo BE-02, main/dev ni credenciales globales; ningún acceso a Atlas, commit, push o PR.

Una sintaxis JSON válida y ejemplos consistentes **no certifican conformidad completa OpenAPI** ni integración FE/BE. La validación especializada y la ejecución real de los ejemplos Zod/TS permanecen pendientes, sin instalar herramientas en esta tarea.

### Auditoría final BE-03.1

Se corrigieron inconsistencias demostrables dentro de los seis entregables:

1. La descripción general atribuía campo_id a toda consulta privada: se precisó que GET /auth/demo/campos usa solo Bearer, sin query. No se inventó una ruta productiva de campos.
2. El DTO normalizado mantenía limit opcional pese al default del diseño Zod. Se separaron queries decodificadas de las variantes normalizadas: limit sigue opcional en HTTP y es number requerido tras normalizar. Cinco ejemplos nuevos comprueban esas formas. JSON Schema default sigue siendo una anotación, no un transformador.
3. El texto describía como RFC3339 general un patrón más restringido y mezclaba acuerdos con propuestas. Se documentó el perfil exacto y se separaron UTC/zona/histórico ya acordados de restricciones adicionales pendientes.
4. Se reprodujo localmente que Date.parse devuelve el mismo milisegundo para .0001Z y .0002Z. Se retiró esa comparación inexacta del ejemplo Zod; el helper de comparación precisa está declarado como diseño pendiente, sin implementación ni reducción silenciosa del formato. Se agregó un caso semántico documental y D03-14.
5. Se clasificaron todas las decisiones por evidencia y momento de resolución: código, documentación aprobada, propuesta o bloqueo BE-02/Atlas. Se distinguieron decisiones postergables de las necesarias antes de implementar.

La compatibilidad comprobada cubre nombres, envoltorios, opcionales, null, enums, transporte, respuestas vacías y los nueve métodos/rutas observados. Los números enteros/rangos, validación estricta, parser de errores uniforme y reglas de producción no se presentan como comportamiento ya equivalente de FE/MSW. El backend mantiene solo health implementado.

**Publicación:** apto para revisión documental mediante PR Draft, manteniendo visibles estas limitaciones. No es contrato aprobado ni implementación lista: faltan autenticación real/campos, adaptación FE de errores, evidencia física de BE-02/Atlas, decisiones de datos/alertas/validación/precisión y validación especializada. No se creó PR ni se publicó nada durante esta auditoría.

## 12. Decisiones necesarias y continuación

Ver [DECISIONES_BE03.md](docs/DECISIONES_BE03.md). Prioridad: sesión real y catálogo campos; parser de errores FE; fechas/límites/validación; datos físicos/tenant; fuente de alertas y metadatos de unidades.

La entrega documental puede revisarse sin acceso Atlas, pero no declara contrato definitivo ni habilita implementación. No marcar BE-02 terminada ni suponer aprobado el borrador de PR #2. No hay commits/push/PR de BE-03.

Siguiente paso recomendado: revisión conjunta FE/BE de esta matriz y las decisiones, y obtención de evidencia de datos para las dependencias. El trabajo de BE-04 y la migración/instalación de paquetes se inician solo con su pedido correspondiente.
