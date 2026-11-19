# BE-10 — Contrato HTTP local para revisión FE/BE

**Implementado en factory aislada, no desplegado ni aprobado como contrato final.**
Base propuesta /api/v1. Once operaciones; cliente confiable de sesión, jamás body/query/headers de tenant.
No se expone registro de clientes, roles o administración global.

| Entidad FE / BE | Endpoint | Método | Request | Response | Estado/autorización |
|---|---|---|---|---|---|
| Cliente / catálogo identidad | /clientes/actual | GET | Sin body/params/query | ClienteResponse | Aislado; sesión y cliente activo |
| Campo / BusinessRecord | /campos | GET | limit?, after? | {campos,next} | Aislado; scope del cliente |
| Campo | /campos | POST | {nombre,descripcion?} | CampoResponse, 201 | Aislado; propietario del contexto |
| Campo | /campos/:campoId | GET | ID opaco | CampoResponse | Aislado; recurso propio |
| Campo | /campos/:campoId | PATCH | {nombre?,descripcion?,version} | CampoResponse | Aislado; propio y CAS |
| Campo | /campos/:campoId | DELETE | query version | 204 sin body | Aislado; sin dependencias verificadas |
| Área / AreaRecord | /areas | GET | campo_id, limit?, after? | {areas,next} | Aislado; campo propio |
| Área | /campos/:campoId/areas | POST | {nombre,descripcion?} | AreaResponse, 201 | Aislado; padre activo propio |
| Área | /areas/:areaId | GET | query campo_id | AreaResponse | Aislado; área→campo→cliente |
| Área | /areas/:areaId | PATCH | query campo_id + {nombre?,descripcion?,version} | AreaResponse | Aislado; propio y CAS |
| Área | /areas/:areaId | DELETE | query campo_id, version | 204 sin body | Aislado; dependencias verificadas y CAS |

## Formas y semántica

ClienteResponse: {cliente_id,nombre,activo,campos_url}. El enlace /api/v1/campos permite consultar
relaciones paginadas, sin expandir un catálogo potencialmente ilimitado en la identidad.
CampoResponse: {campo_id,cliente_id,nombre,descripcion,activo,created_at,updated_at,version}.
AreaResponse: {area_id,campo_id,nombre,descripcion,activo,created_at,updated_at,version}.
DTOs/mappers: src/dto/business.dto.ts. Sin _id, realm, documentos Mongoose o versiones de seguridad.
Fechas ISO UTC, descripción nullable. GET cliente actual no tiene entrada; DELETE no tiene DTO body de respuesta.

POST /campos:
```json
{"nombre":"Campo Norte","descripcion":null}
```
PATCH /campos/:campoId:
```json
{"descripcion":"Descripción revisada","version":0}
```
El PATCH exige al menos nombre o descripción; null borra la descripción, omitir conserva.
Nombre tras trim: 1–120, sin controles Unicode; descripción hasta 2000. IDs reutilizan logicalKey
(1–256, exactos, sin control/espacios periféricos), no casting a ObjectId. IDs de recursos nuevos
generados en servidor; no se acepta nombre como identidad. Propietario, estado, timestamps, IDs,
realm y referencias no se pueden actualizar. No hay polígonos/coordenadas obligatorias.
Las versiones son enteros seguros no negativos; agotamiento impide una nueva mutación.

GET/DELETE no aceptan body. Parámetros desconocidos, repetidos como arrays, tipos inválidos,
objetos vacíos en POST/PATCH y campos internos → 400. Query limit 1–100, default50; after es último
id de la página anterior y next=null indica fin. Orden id ascendente con collation simple.
Las listas filtran activos. DELETE es baja lógica, no borrado físico ni cascada; GET posterior → 404.
Un campo con cualquier área incluso inactiva → 409. Un área/campo con dependencias bloqueantes →409;
si el reader de sensores/asociaciones no está integrado →503, no se presume vacío.

## Estados y errores

200 lecturas/PATCH, 201 creación, 204 baja sin contenido; 400 validación, 401 sin identidad/sesión,
403 usuario sin cliente o cliente inactivo, 404 recurso ajeno/inexistente, 409 versión/dependencias,
413 tamaño, 415 tipo de contenido, 500 interno y 503 dependencia/índice/evidencia no disponible.
No se introdujo 422 porque el handler vigente clasifica entrada inválida como 400.
El adapter de la composición aislada emite {"error":{"code":"...","message":"..."}} mediante
el único handler BE-08. La aplicación pública conserva su formato legacy; no se cambia en BE-10.
No hay mensajes originales de Mongo, query, stack ni eco de body. Un 503/timeout no promete que
una escritura ya confirmada se haya revertido; releer estado/version antes de repetir. No se implementó
idempotency-key para POST: ante ACK perdido no repetir ciegamente creando otro recurso.

## Correspondencia y discrepancias reales FE

Fuentes consultadas en GitHub (solo lectura):
- [dominio.ts](https://github.com/Proyecto-Agro-Org/fe-agro/blob/main/src/types/dominio.ts): Cliente/Campo/Area y referencias por ID.
- [api/areas.ts](https://github.com/Proyecto-Agro-Org/fe-agro/blob/main/src/api/areas.ts): GET /areas?campo_id.
- [types/areas.ts](https://github.com/Proyecto-Agro-Org/fe-agro/blob/main/src/types/areas.ts): AreaResumen con contadores.
- [api/client.ts](https://github.com/Proyecto-Agro-Org/fe-agro/blob/main/src/api/client.ts): transporte HTTP y lectura de errores/respuestas.

Se conservan nombres cliente_id/campo_id/area_id/nombre y el parámetro campo_id. Campo/Area
tienen metadata adicional. **GET /areas BE10 devuelve Área base, no AreaResumen**: faltan sensores,
conectados, desconectados, alertas_activas y ultima_actualizacion, que dependen de BE-11/14/16.
No se reemplaza esa ausencia por ceros ni se declara compatibilidad lista para desactivar mocks.
El equipo debe acordar si mantiene un endpoint de resumen separado o incorpora los agregados reales.
El detalle conserva campo_id obligatorio. Las rutas nuevas de cliente/campos/CRUD y versionado
requieren integración FE; no se exportaron endpoints demo como login real ni se modificaron mocks.

[OpenAPI implementado local](docs/openapi-be10.json); el OpenAPI BE-03 sigue identificado como propuesta
histórica con referencias a este contrato. JSON Schema describe forma, no toda la normalización/refinamiento
Zod; la fuente ejecutable sigue siendo schemas.ts. Validación especializada OpenAPI pendiente.

## Activación pendiente

Adaptaciones de transporte comprobadas, todavía no implementadas en frontend:
- Opciones.method solo admite GET/POST; incorporar PATCH/DELETE para consumir el CRUD.
- apiFetch siempre ejecuta respuesta.json(); debe admitir 204 sin intentar parsear JSON vacío.
- leerMensajeError asume error:string; acordar y soportar error.code/error.message del adapter BE10.
- Integrar next/after y version, además de resolver el desacople AreaResumen. No convertir estas
  diferencias en cambios backend para simular compatibilidad con mocks existentes.

Integrar el router solo tras aprobar contratos, mapeo físico, guard de sesiones, dependencias coordinadas,
CORS y límites operativos. No hay env que monte rutas ni fake seleccionable. No usar clientid MQTT para
crear clientes/campos ni autorizar áreas. No se habilitó login productivo ni se modificó FE/ingesta.
