# BE-10B — Matriz de compatibilidad frontend/backend

Fuentes: BE `09593a415cfec165e41fd269f2270739979aa489`; FE `dev`
`6d6c54526c64c6acd4b347ff723c13488038075e`. La matriz describe evidencia,
no convierte mocks en contrato aprobado. Todas las rutas BE permanecen deshabilitadas.

## Convenciones comunes

| Dimensión | Contrato BE-10 |
|---|---|
| Base y seguridad | `/api/v1`; Bearer confiable; cliente derivado de sesión/catálogo, nunca de input público. |
| Errores | `{error:{code,message}}`; 400 validación, 401 sin sesión/revocada, 403 sin cliente activo, 404 ajeno/inexistente, 409 CAS/dependencia, 503 dependencia desconocida. |
| Fechas | ISO 8601 UTC en respuesta; BSON Date interno. |
| Mutaciones | JSON estricto; campos desconocidos rechazados; CAS obligatorio en PATCH/DELETE. |
| Baja | Lógica, sin cascada; 204 vacío; relación desconocida bloquea. |
| Paginación | `limit` 1–100, default 50; cursor `after`; respuesta `next`; orden por ID. |

## Matriz de las once operaciones

| # | Pantalla/acción FE | Endpoint y método | Params/body | Response/status | Tipo FE / DTO BE | Compatibilidad y diferencia | Cambio requerido / responsable | Estado |
|---|---|---|---|---|---|---|---|---|
| 1 | Inicio/recuperación de identidad | `GET /clientes/actual` | Sin entrada | `ClienteResponse`, 200 | `Cliente` / `GetCurrentClienteResponse` | FE obtiene cliente desde login/mock y no llama este endpoint. BE añade `activo` y `campos_url`. | Acordar recuperación de sesión; FE debe mapear la proyección mínima. FE/BE. | PENDIENTE |
| 2 | Selector/listado de campos | `GET /campos` | `limit?`, `after?` | `{campos,next}`, 200 | `Campo[]` / `ListCamposResponse` | FE llama `/auth/demo/campos`, no soporta cursor; los campos base son compatibles por proyección. | FE usar ruta real, mapear campos, conservar `next`; BE mantiene aislamiento. FE. | PENDIENTE |
| 3 | Crear campo | `POST /campos` | `{nombre,descripcion?}` | `CampoResponse`, 201 | No existe request FE / `CreateCampoRequest` | No hay formulario ni servicio FE. | Diseñar UI y mapear respuesta; no enviar cliente/ID. FE. | PENDIENTE |
| 4 | Detalle de campo | `GET /campos/:campoId` | `campoId` | `CampoResponse`, 200 | `Campo` / `GetCampoResponse` | FE no tiene pantalla/servicio de detalle de campo. | Consumir si la UX lo requiere; no es requisito de las pantallas actuales. FE. | PENDIENTE |
| 5 | Editar campo | `PATCH /campos/:campoId` | `{nombre?,descripcion?,version}` | `CampoResponse`, 200; 409 stale | No existe request FE / `UpdateCampoRequest` | `apiFetch` no admite PATCH y FE no conserva `version`. | Añadir método, formulario parcial y resolución de 409. FE. | PENDIENTE |
| 6 | Desactivar campo | `DELETE /campos/:campoId?version=` | Query `version`; sin body | Vacío, 204; 409/503 dependencia | No existe operación FE / `DeleteCampoRequest` | `apiFetch` no admite DELETE ni 204. | Añadir método, confirmación y manejo de conflicto/dependencia. FE. | PENDIENTE |
| 7 | Tarjetas/filtro de áreas | `GET /areas` | `campo_id`, `limit?`, `after?` | `{areas:AreaResponse[],next}`, 200 | `AreasRespuesta` (`AreaResumen[]`) / `ListAreasResponse` | Incompatible: FE exige cinco agregados de sensores/alertas; BE entrega Área base y cursor. | BE-11 proveer fuentes; FE/BE decidir proyección final y paginación. | BLOQUEADO |
| 8 | Crear área en campo | `POST /campos/:campoId/areas` | `{nombre,descripcion?}` | `AreaResponse`, 201 | No existe request FE / `CreateAreaRequest` | No hay formulario/servicio FE; pertenencia deriva de la ruta. | Crear UI sin `cliente_id` ni reasignación. FE. | PENDIENTE |
| 9 | Encabezado detalle de área | `GET /areas/:areaId` | Query `campo_id` | `AreaResponse`, 200 | `AreaDetalle=AreaApi` / `GetAreaResponse` | Compatible por proyección; FE acepta `campo_id` opcional, BE siempre lo entrega. El listado de sensores es otro endpoint futuro. | Hacer `campo_id` obligatorio al integrar; conservar 404 uniforme. FE. | PENDIENTE |
| 10 | Editar área | `PATCH /areas/:areaId` | Query `campo_id`; body parcial + `version` | `AreaResponse`, 200; 409 stale | No existe request FE / `UpdateAreaRequest` | FE no admite PATCH/version. BE rechaza cambiar campo/cliente. | Añadir formulario y CAS; no crear traslado implícito. FE. | PENDIENTE |
| 11 | Desactivar área | `DELETE /areas/:areaId` | Query `campo_id`,`version`; sin body | Vacío, 204; 409/503 dependencia | No existe operación FE / `DeleteAreaRequest` | FE no admite DELETE/204; BE-11 debe aportar dependencia confiable. | FE adaptar cliente; BE-11 implementar lector coordinado antes de habilitar. FE/BE. | BLOQUEADO |

## Compatibilidad transversal

| Aspecto | Evidencia | Cambio acordado o pendiente | Responsable | Estado |
|---|---|---|---|---|
| Métodos HTTP | FE tipa solo GET/POST. | Incorporar PATCH/DELETE. | FE | PENDIENTE |
| 204 | FE siempre ejecuta `response.json()`. | Retornar `undefined` sin parsear cuando status sea 204. | FE | PENDIENTE |
| Errores | FE espera `{error:string}`; BE usa objeto estable. | Leer `error.message`, conservar `error.code`, fallback seguro. | FE | PENDIENTE |
| Autorización | Mocks resuelven cliente desde token; BE usa capacidad privada. | Mantener: jamás aceptar `cliente_id` como selector de tenant. | FE/BE | IMPLEMENTADO |
| Recursos ajenos | FE ya trata 404 en vistas de detalle; BE uniforma ajeno/inexistente. | Mantener 404 sin revelar existencia. | FE/BE | PROBADO |
| Campos | FE `Campo` usa ID/nombre/cliente; BE añade metadata. | Mapper FE puede ignorar metadata; conservar `version` en edición. | FE | PENDIENTE |
| Área base | `AreaDetalle` requiere ID/nombre y tolera `campo_id`. | Hacer `campo_id` obligatorio con backend real. | FE | PENDIENTE |
| AreaResumen | Mocks agregan sensores, conectividad, alertas y última recepción. | No inventar valores; resolver después del catálogo/asociaciones BE-11. | FE/BE | BLOQUEADO |
| Paginación | FE espera lista completa; BE usa cursor. | Diseñar carga incremental/continuación y conservar `next`. | FE | PENDIENTE |
| Total | No existe contrato BE ni cálculo correcto desde una página. | Aprobar consulta/metadata antes de añadirlo. | FE/BE | PENDIENTE |
| GIS | FE usa lat/lon solo en sensores. | No añadir geometría a Campo/Área sin contrato GeoJSON/CRS. | Producto/FE/BE/DB | PENDIENTE |
| Bajas | FE no tiene flujo; BE exige CAS y dependencias. | Mostrar 409/503 y no prometer cascada. | FE/BE | PENDIENTE |

## Recomendación de integración

Primero adaptar el cliente HTTP y la recuperación de identidad/campos. El detalle base de
área puede integrarse sin BE-11. No conectar `AreasPage` al listado base hasta decidir la
proyección de resumen: estructuralmente ambas respuestas contienen `areas`, pero sus elementos
no son semánticamente intercambiables.

No se recomienda renombrar endpoints, eliminar CAS ni completar agregados con cero. El backend
debe mantener rutas deshabilitadas hasta disponer de sesión real, mapeo físico y dependencias.
