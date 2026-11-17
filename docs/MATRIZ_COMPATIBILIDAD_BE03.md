# Matriz de compatibilidad frontend y backend para BE-03

**Estado:** comparación documental, no prueba de integración. Frontend `f30c76dbd7f2f87aa5ef02e0be176f2e112fbb96`; backend base `1bb20f76b7a739f42c75b37b9a64315276560ec1`.
**OpenAPI:** [openapi.json](openapi.json). **DTOs:** [CONTRATOS_DTO_ZOD.md](CONTRATOS_DTO_ZOD.md).

## 1. Transporte compartido observado

src/api/client.ts usa VITE_API_BASE_URL o /api/v1, Accept: application/json, Content-Type: application/json solo si hay body y Authorization: Bearer para pedidos privados con token almacenado. No usa credentials para cookies. Login usa sinSesion: no envía Bearer previo; su 401 no expira otra sesión. Otros 401 avisan expiración. Error de red produce ErrorApi.estado=null, no un HTTP 500.

El backend solo implementa GET /health. Las formas de negocio siguientes existen en clientes/tipos/MSW, no en endpoints de be-agro. Los handlers MSW usan comodines; se documenta el prefijo por defecto del cliente, no una obligación de hosting demostrada.

## 2. Inventario por pantalla y operación

| Pantalla / método y ruta por defecto | Params y query observados / entrada | Salida tipada | Auth, estados observados y vacío | Compatibilidad / decisión |
|---|---|---|---|---|
| Operación GET /health | Sin params/body ni query contractual; Origin de transporte | GetHealthResponse {status:ok} | Público; 200, CORS 403 legacy, handler 500 legacy | Implementado. No prefijar /api/v1, no DB ni cambio de formato |
| Login POST /api/v1/auth/login | JSON email/password | LoginRespuesta: token; usuario y cliente opcionales | Público sin Bearer previo; mock 200/400/401; escenarios error/red | Forma FE conservada; Google real y sesión bloqueados. Backend no implementado |
| Login POST /api/v1/auth/google-demo | Sin params/query/body | LoginRespuesta demo | Público en MSW; helper falla sin mocks | Exclusivo demo, excluido de paths de OpenAPI productivo |
| Recuperación POST /api/v1/auth/demo/sesion | JSON {token} | IdentidadSesion completa usuario/cliente | Público de transporte; valida token demo, 400/401, escenario 500 | Exclusivo MSW. No existe /auth/me real confirmado |
| Selector GET /api/v1/auth/demo/campos | Sin query de cliente; token determina identidad | {campos:Campo[]} | Bearer demo; 200/401; [] válido | Ruta real sin aprobar. Componente GetCamposResponse disponible; no inventar endpoint |
| Dashboard GET /api/v1/dashboard/resumen | campo_id único | GetDashboardResponse | Bearer mock; 200/400/401/404; conteos 0, listas [] y fecha null | Éxito compatible. Cinco alertas por fecha, incluye resueltas; alcance fuente pendiente |
| Áreas GET /api/v1/areas | campo_id único | {areas:AreaResumen[]} | Bearer mock; 200/400/401/404; areas:[] | campo_id opcional en AreaApi de salida; mock actual lo completa. No falta de pertenencia en dominio |
| Detalle área GET /api/v1/areas/:areaId | path areaId codificado + campo_id | AreaApi | Bearer mock; 200/400/401/404 | Área inexistente/ajena=404, no objeto vacío; área sin sensores sigue existiendo |
| Sensores área GET /api/v1/areas/:areaId/sensores | path areaId + campo_id | {sensores:SensorDeArea[]} | Bearer mock; 200/400/401/404; [] válido | SensorDeArea no incluye area_id: pertenece al área de la ruta |
| Sensor GET /api/v1/sensores/:deviceId | path deviceId + campo_id | SensorDetalle | Bearer mock; 200/400/401/404; ultima_medicion:null si no lecturas | Conserva seis variables y nulls. Última medición incluida; no ruta independiente aprobada |
| Histórico GET /api/v1/sensores/:deviceId/historico | path deviceId; campo_id, variable, desde, hasta, limit | HistoricoRespuesta | Bearer mock; 200/400/401/404; puntos:[] | Cliente envía limit1000; mock default500/max1000. Más estricto el diseño de fechas/rango |
| Mapa GET /api/v1/mapa/sensores | campo_id | {sensores:SensorMapa[]} | Bearer mock; 200/400/401/404; sensores:[] | Coordenadas null no eliminan sensor. Filtros UI área/estado locales, no nuevos parámetros HTTP |
| Alertas GET /api/v1/alertas | campo_id y filtros opcionales area_id/tipo/estado/severidad/desde/hasta/limit | {total,limit,alertas} | Bearer mock; 200/400/401/404; total0/lista[] | default50/max200 observados. Fuente y persistencia sin aprobar; no prometer producción |

Los escenarios MSW pueden agregar 500, demora y fallo de red. No confundirlos con validación completa de cada handler ni con estados implementados en backend. El handler de áreas valida campo; los detalles validan relación con área y sensor; ninguna comprobación demo es frontera de seguridad real.

## 3. Formas exactas de respuesta que deben conservarse

| Forma | Campos requeridos / opcionales / null |
|---|---|
| Medida | valor:number|null y unidad:string, ambos presentes; no enum de unidad aprobado |
| AreaApi | area_id,nombre requeridos; campo_id opcional, no nullable |
| AreaResumen | AreaApi + sensores,conectados,desconectados,alertas_activas,ultima_actualizacion requerida nullable |
| SensorDeArea | device_id,nombre,estado,ultima_comunicacion nullable,ubicacion nullable,alertas_activas; no area_id |
| SensorDetalle | device_id,nombre,area_id,area_nombre,estado,ultima_comunicacion nullable,ubicacion nullable,ultima_medicion nullable |
| UltimaMedicion | timestamp y humedad/temperatura/conductividad/nitrogeno/fosforo/potasio con Medida; un campo ausente no se omite: valor null |
| Histórico | Identidad de sensor + area_nombre,variable,unidad,puntos[{timestamp,valor nullable}],truncado |
| Dashboard | resumen{areas,sensores,conectados,desconectados,alertas_activas},areas[],ultimas_alertas[],ultima_actualizacion nullable |
| Mapa | Identidad de sensor + area_nombre,estado,ubicacion nullable,ultima_comunicacion nullable,ultima_medicion nullable reducida a timestamp/humedad/temperatura |
| Alerta | alerta_id,device_id,sensor_nombre,area_id,area_nombre,tipo,severidad,descripcion,timestamp,estado |
| Campo | campo_id,nombre,cliente_id strings; cliente_id de salida no autoriza requests |
| LoginRespuesta | token requerido; usuario opcional con nombre/email requeridos e IDs opcionales; cliente opcional |

S8 sin NPK: valores null, no generar nutrientes sintéticos para satisfacer forma. No decidir unidades reales o mezclas de mediciones/laboratorio en este trabajo.

## 4. Diferencias explícitas entre comportamiento observado y diseño objetivo

| Tema | Cliente/MSW actual | Diseño documentado | Cambio requerido antes de integrar |
|---|---|---|---|
| Error | {error:string}; leerMensajeError retorna esa propiedad sin estrechar tipo | {error:{code,message}} para negocio | Adaptar parser FE y tests. Hoy un objeto puede convertirse en mensaje inútil; no es compatible por tener interfaz TS |
| Identidad real | Google simulado, token sessionStorage; catálogo de campos solo demo | Fuente confiable backend y cliente asociado | Aprobar flujo, transporte, expiración, recuperación y logout; ningún endpoint nuevo aprobado aquí |
| Bearer/cookie | Bearer sin credentials | Bearer describe transporte observado; cookie pendiente | No agregar ambos como alternativas seguras ya aprobadas |
| Fechas | Date.parse; histórico admite desde==hasta; alertas no comprueba inversión de rango | UTC/zona e histórico desde<hasta acordados; perfil RFC3339 restringido y rango de alertas propuestos | Probar los acuerdos y aprobar restricciones adicionales antes de integrar |
| Precisión temporal | Date.parse trunca fracciones inferiores al milisegundo | Formato propuesto admite más de tres decimales | D03-14: comparación exacta pendiente; no rechazar instantes distintos como iguales ni restringir precisión sin acuerdo |
| Query duplicada | campo_id rechaza multiplicidad; otros get toman primero | Rechazar repetidos de cualquier parámetro | Comprobación previa a construir objeto/Zod |
| Query desconocida | Con frecuencia ignorada en mocks | Rechazo de claves no declaradas propuesto | Validar con FE; nunca usar cliente_id/entityId para autorizar aunque se toleren |
| Enums alertas | Tipo TS enum, handler puede filtrar cadena inválida a [] | Enum runtime y 400 | Nuevo rechazo propuesto, sin afirmar que MSW ya lo hace |
| limit | Number sobre texto; acepta algunas notaciones como 1e2 | Decimal positivo canónico propuesto | Acordar gramática; límites 500/1000/50/200 observados, no aprobados por carga |
| Default y DTO normalizado | limit HTTP opcional; JSON Schema no aplica defaults automáticamente | Parámetros/queries decodificadas opcionales; DTO normalizado exige limit:number | Aplicar default en Zod/adaptador y entregar al service una forma requerida, sin cambiar la opcionalidad HTTP |
| Respuestas | TS estructural permite extras; handlers entregan campos según sus datos | additionalProperties:false en schemas de diseño | Revisar extensibilidad con FE; no afirmar equivalencia runtime estricta |
| Ubicación | Tipo lat/lon numéricos; mapa valida rango en UI | Mapper devuelve null si inválida, respuesta con rango validado | No descartar sensor ni inventar coordenadas |
| Recepción/adquisición | Ingesta garantiza recepción, no fecha origen | Semánticas distintas | Resolver BE-02/04 sin usar metadatos operativos como medición |
| Cliente del recurso | Mock usa tablas demo | Repository limita toda consulta al cliente autenticado | Atlas/catálogo/IDs pendientes; nunca filtrar otros tenants después de recuperar |

## 5. Mapeo de persistencia y servicios de ingesta

El servicio iot-ingest expone /ingest y /iot-device-status (aliases /api), no /api/v1 de consulta. Controllers usan DTOs genéricos y repositories insertOne/upsert; esos endpoints no se añaden a esta OpenAPI de be-agro.

mediciones no asegura device_id, unidad, timestamp adquisición ni entityId; el documento incluye _receivedAt Date. dispositivos usa clientid y actualiza _lastSeen, con campos libres. No mapear directamente a DTOResponse ni asociar clientid con cliente_id.

Tipos BSON, equivalencia lotes, relaciones físicas y catálogo de formatos permanecen pendientes en PR #2 Draft. BE-03 conserva IDs públicos sin convertirlos ni imponer schema Mongo. BE-02 se consultó remotamente, no se integró en esta rama.
