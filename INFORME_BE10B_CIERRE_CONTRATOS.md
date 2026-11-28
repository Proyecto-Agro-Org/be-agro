# BE-10B — Cierre de contratos FE/BE y preparación de BE-11

Fecha de revisión: 23/11/2026. Rama: `feature/be10b-cierre-contratos`.
Base verificada: `09593a415cfec165e41fd269f2270739979aa489` (`origin/dev`, merge del PR #18).
Frontend de referencia: `Proyecto-Agro-Org/fe-agro`, `origin/dev` observado en
`6d6c54526c64c6acd4b347ff723c13488038075e`. El checkout local del frontend estaba
en `daa72a828eb79aad0f09dcb7786a2c5a4adfd3bc`; por eso los archivos contractuales
se contrastaron también contra el contenido remoto de `dev`, siempre en modo lectura.

## 1. Resultado ejecutivo

BE-10 conserva once operaciones implementadas y probadas en una composición aislada.
Las rutas no están montadas en `src/app.ts`; la aplicación pública continúa exponiendo
solamente el comportamiento anterior. La autenticación productiva no fue habilitada.

La revisión de controllers, services, repositories, modelos, Zod, DTOs, OpenAPI y pruebas
no encontró un defecto funcional demostrable dentro de BE-10. No se cambió código para
forzar compatibilidad con mocks. Las diferencias restantes se explican por tres límites
reales: el frontend todavía usa campos demo, su cliente HTTP no implementa todo el CRUD,
y sus vistas de áreas requieren agregados de sensores que corresponden a BE-11.

| Tema | Estado | Conclusión |
|---|---|---|
| Once operaciones BE-10 | PROBADO | Implementación, DTOs, Zod y OpenAPI coinciden; permanecen deshabilitadas. |
| Autorización multicliente | PROBADO | El cliente surge de capacidad privada; recursos ajenos e inexistentes responden 404. |
| CRUD en el frontend real | PENDIENTE | FE solo consulta campos demo y áreas; no tiene formularios ni cliente PATCH/DELETE. |
| `GET /areas` para tarjetas FE | BLOQUEADO | FE espera `AreaResumen`; BE-10 solo puede devolver entidad base sin inventar telemetría. |
| Contador total de áreas por campo | PENDIENTE | No se expone un total global: el tamaño de una página no es un contador contractual. |
| Contadores de sensores/estado/alertas | BLOQUEADO | Requieren sensores lógicos, asociaciones y lecturas confiables de BE-11. |
| GIS de campo/área | PENDIENTE | FE actual solo usa ubicación puntual del sensor; no existe contrato aprobado de geometría agronómica. |
| Mapeo físico Atlas | BLOQUEADO | No hay inventario físico autorizado que confirme colecciones, BSON o equivalencias. |
| Inicio de BE-11 | PENDIENTE | Puede comenzar como implementación aislada cuando se aprueben los identificadores y reglas de dependencia indicados aquí. |

## 2. Inventario contractual cerrado

El contrato implementado mantiene `/api/v1`, Bearer emitido por la infraestructura de
sesión, JSON estricto y errores `{ "error": { "code": "...", "message": "..." } }`.
Los DTO públicos nunca exponen documentos MongoDB.

- `GET /clientes/actual`: sin entrada; responde `{cliente_id,nombre,activo,campos_url}`.
  Sin sesión o con sesión revocada: 401. Identidad autenticada sin cliente activo: 403.
  No acepta un `clientId` público ni crea un rol administrativo.
- Campos: listar, crear, consultar, PATCH parcial y baja lógica. `version` es obligatoria
  en PATCH/DELETE; un valor obsoleto responde 409. Omitir una propiedad conserva el valor,
  `descripcion:null` lo borra. El propietario, IDs y fechas no son editables.
- Áreas: listar por `campo_id`, crear dentro de un campo, consultar, PATCH y baja lógica.
  `campo_id` se valida contra el área y el cliente; no existe una operación de traslado.
- Listas: cursor `after`, `limit` 1–100, valor por defecto 50, orden estable por ID y
  `next` nullable. No existe `total` porque no fue aprobado ni puede derivarse de una página.
- DELETE: 204 sin cuerpo. No hay borrado físico, cascada ni reactivación implícita.
- Autorización: 404 uniforme ante recurso inexistente, de otro cliente o bajo otro padre.

La matriz completa está en [MATRIZ_BE10B_FE_BE.md](MATRIZ_BE10B_FE_BE.md). El OpenAPI
vigente `docs/openapi-be10.json` enumera las once operaciones y continúa alineado con
routes, Zod y DTOs; no fue necesario cambiarlo.

## 3. Evidencia del frontend y adaptaciones pendientes

El `dev` remoto de FE usa `apiFetch` con métodos TypeScript limitados a GET/POST, siempre
intenta `response.json()` cuando la respuesta es exitosa y solo extrae `{error:string}`.
`CampoProvider` se activa únicamente con `VITE_USE_MOCKS=true` y consulta
`/auth/demo/campos`; por lo tanto, no consume aún `GET /campos` ni
`GET /clientes/actual`. Tampoco existen pantallas de creación, edición o baja.

Adaptaciones FE necesarias, sin modificar `fe-agro` en esta tarea:

1. aceptar PATCH/DELETE y resolver 204 sin parsear JSON;
2. leer `error.message` y conservar `error.code` para lógica estable;
3. recuperar identidad/cliente desde la sesión real o `GET /clientes/actual` según el
   flujo aprobado, y reemplazar `/auth/demo/campos` por la lista paginada real;
4. conservar `version` en los DTO de edición/baja y manejar 409;
5. implementar `after/next`, límites y estados de carga sin suponer `total`;
6. mantener `campo_id` obligatorio para áreas reales;
7. acordar una respuesta de resumen para la pantalla de áreas después de BE-11.

`AreaDetalle` es compatible con la proyección mínima `{area_id,nombre,campo_id}` porque
tolera campos adicionales. `AreasPage`, en cambio, requiere `sensores`, `conectados`,
`desconectados`, `alertas_activas` y `ultima_actualizacion`; no puede consumir el listado
base BE-10 como `AreaResumen`.

## 4. Contadores y datos derivados

No se agregó ningún contador al contrato BE-10. Un contador global de áreas no puede
calcularse correctamente a partir de una página sin una consulta adicional o un contrato
de `total`. La cantidad visible de filas es solo el tamaño de esa página.

Los cinco agregados solicitados por FE dependen de módulos no disponibles:

- `sensores`: catálogo de sensor lógico y pertenencia vigente;
- `conectados`/`desconectados`: política temporal de estado y última recepción;
- `alertas_activas`: origen y ciclo de vida de alertas aprobado;
- `ultima_actualizacion`: máximo de recepciones atribuibles al área, no timestamp arbitrario del dispositivo.

Devolver cero o `null` sin esas fuentes sería ficticio. BE-11 debe proporcionar puertos
acotados y filtrados por cliente; luego podrá acordarse si el resumen vive en `GET /areas`,
en otra proyección o en un endpoint específico. Esa decisión sigue PENDIENTE FE/BE.

## 5. Persistencia e integridad

El candidato local usa colecciones convencionales con prefijo explícito
`agro_business_<sufijo>_{fields,areas,controls}`. No declara colecciones físicas Atlas.
Los IDs son strings, las fechas se guardan como BSON Date y se serializan ISO UTC.

- índices únicos: `(realm,id)` en campos y áreas, `(realm,clientId)` en control;
- índices de página: `(realm,clientId,active,id)` y
  `(realm,clientId,fieldId,active,id)`;
- filtros de cliente y relación padre se ejecutan dentro de MongoDB;
- CAS y serialización por cliente se realizan en transacciones de replica set;
- las fechas de actualización no pueden retroceder;
- un campo con cualquier área, incluso inactiva, no puede desactivarse;
- ausencia desconocida de sensores/asociaciones devuelve 503; dependencia comprobada devuelve 409.

No se accedió a Atlas, no se ejecutaron migraciones y no se modificaron datos. Antes de
integración real hay que confirmar en lectura: nombres de base/colecciones, tipos de `_id`
y referencias, índices/collation, validadores, documentos históricos, nombres de campo/área,
y compatibilidad con catálogos existentes. Fixtures y Docker local no prueban ese inventario.

## 6. GIS

El frontend actual representa `ubicacion:{lat,lon}|null` en sensores. No usa coordenadas
ni polígonos de Campo o Área en las operaciones BE-10. Tampoco existe decisión aprobada
sobre GeoJSON, CRS, orientación de anillos, precisión, unidades o validez geométrica.

Por ello GIS permanece PENDIENTE y no bloquea el CRUD base deshabilitado. Sí bloqueará
cualquier endpoint que prometa geometrías. La decisión deberá fijar como mínimo: entidad
propietaria de la geometría, opcionalidad, GeoJSON permitido, WGS84/otro CRS, reglas de
validación y estrategia para datos existentes.

## 7. Seguridad

- Las once rutas siguen fuera de la aplicación pública; `src/app.ts` no importa el router.
- No existe selector de cliente mediante body, query, headers o variables de entorno.
- La identidad sintética permanece únicamente en pruebas/composición local.
- Los services no aceptan objetos Express; repositories filtran por `realm` y `clientId`.
- El PATCH no permite cambiar cliente, campo padre, ID, estado, fechas o versión arbitraria.
- No se montó login, Google Identity, MongoDB o autenticación productiva.
- No se modificaron Vercel, Atlas, frontend ni `iot-ingest`.

## 8. Defectos y correcciones

No se reprodujo un defecto funcional nuevo. Cambiar respuestas para que coincidan con
mocks habría debilitado los contratos: eliminaría CAS, inventaría agregados o mezclaría
sensor lógico con dispositivo físico. Por esa razón, el cambio BE-10B es documental.

Se cerraron documentalmente las ambigüedades de: operación de cliente actual, PATCH/DELETE,
204, cursor, errores, diferencia Área base/AreaResumen, imposibilidad de contadores ficticios,
GIS y dependencias de baja. La especificación de BE-11 está en
[CONTRATO_BE10B_DEPENDENCIAS_BE11.md](CONTRATO_BE10B_DEPENDENCIAS_BE11.md).

## 9. Validaciones ejecutadas

- `npm ci`: aprobado; 120 paquetes instalados desde lock, 0 vulnerabilidades reportadas.
- `npm run typecheck`: aprobado.
- `npm run build`: aprobado.
- `npm test`: **374/374**, sin fallos ni omisiones.
- `node scripts/verify-be10-http.mjs`: **13/13** equivalentes a
  `d504c8e6c4df9417e35028726fce32f63150f01a`.
- `git diff --check`: aprobado antes de documentar; se repite en el cierre.
- MongoDB real: **no reejecutado**. Se revisó la evidencia BE-10 de 13/13 con MongoDB
  8.0.38, replica set local de un nodo y dos conexiones. No hubo cambios de persistencia.

## 10. Entrada a BE-11

BE-11 no se inició. Queda habilitado para trabajar en una composición aislada después de
aprobar: identidad `sensorId`, clave del dispositivo físico, fuente/`clockId`, esquema de
asociaciones temporales, estados del sensor, lector de dependencias y coordinación de
writers. La exposición HTTP y `AreaResumen` siguen bloqueadas hasta contar con esas fuentes.

Próximo desarrollo recomendado: implementar primero el catálogo de sensores lógicos y el
puerto transaccional de dependencias, deshabilitados públicamente, con tests de aislamiento,
CAS y ventanas temporales. Después integrar asociaciones y consultas de mediciones; solo al
final acordar el resumen consumido por FE.
