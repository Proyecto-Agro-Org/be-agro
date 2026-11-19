# BE-10 — Clientes, campos y áreas

19/11/2026. **Implementado y probado localmente; deshabilitado en la aplicación pública.**
Base local/remota comprobada: `d504c8e6c4df9417e35028726fce32f63150f01a` (dev, PR #17).
Rama: `feature/be10-clientes-campos-areas`. Sin push, PR, merge, despliegue ni configuración remota.

## Revisión y decisiones de alcance

Se revisaron AGENTS, IMPLEMENTATION_PLAN, ESPECIFICACION, DoD, modelos/puertos de identidad,
autorización BE-09, validación BE-07.2, infraestructura HTTP BE-08 y contratos AGRO-DB-01/02.
La consigna BE-10 autoriza el CRUD local, ampliando el alcance histórico de consulta;
no implica aprobar un CRUD público ni el mapeo físico de Atlas.
No había modelos, repositorios ni endpoints de campos/áreas. No se duplicaron clientes:
su identidad, nombre y estado se leen mediante IdentityCatalogueStore existente. El catálogo
auth no se presenta como modelo agronómico definitivo ni se agrega registro de clientes/roles.
La jerarquía es Cliente → Campo → Área → Sensor lógico → asociación con dispositivo físico.
No se interpreta clientid MQTT ni lotes como cliente/campo/área.

## IMPLEMENTADO

Flujo: business.routes → business.controller → business.service → business.repository → modelos/driver Mongo.
Controllers delgados, Zod por parte del request, mappers DTO explícitos y ApplicationError existente.
El repository usa conexión Mongoose ya abierta y colecciones tipadas del driver para transacciones;
no abre conexiones, no crea índices en requests ni retorna documentos Mongo como DTO público.

- Cliente actual: identificador empresarial, nombre público, estado y enlace a campos; sin email,
  datos de usuario, securityVersion, realm ni detalles administrativos.
- Campos y áreas: crear/listar/detalle/actualización parcial/baja lógica. UUID generado por servidor,
  identidad estable, descripción nullable, estado y fechas; sin geometrías inventadas.
- Paginación por id, límite 1–100 (default 50), cursor after, orden simple estable; sin skip global.
- CAS obligatorio: version en PATCH y query version para DELETE; versión obsoleta → 409.
- Baja sin cascadas. Campo con cualquier área, incluso inactiva → 409 para preservar historia.
  Dependencias de sensores/asociaciones requieren puerto administrativo confiable; si falta evidencia
  se devuelve 503, nunca se supone que no hay dependencias. Evidencia blocked → 409.
- Campo/área inactivos permanecen persistidos; las lecturas normales los excluyen. No hay reactivación,
  cambio de propietario, administración global ni escritura de sensores/dispositivos/mediciones.

Rutas y payloads: [contrato FE/BE](CONTRATO_BE10_API_FRONTEND.md),
[OpenAPI BE10](docs/openapi-be10.json). docs/openapi.json conserva las propuestas históricas BE-03
y las anota con la referencia BE10; no se sustituyen silenciosamente sus agregados pendientes.

## Autorización y seguridad

createBusinessRouter reutiliza createRequestAuthorization: autentica y exige cliente antes del parser.
El service solo acepta capacidades emitidas por AuthorizationService; una estructura forjada no pasa
su WeakMap privado. Se verifica cliente activo en el catálogo por realm/clientId del contexto.
Query/body/headers públicos no seleccionan el tenant. Los filtros Mongo incluyen realm y clientId;
las áreas también exigen fieldId y lookup de campo propio. Recursos ajenos/inexistentes → 404.
El contexto se comprueba antes/después de llamadas async. No se promete cancelación remota de una
operación ya admitida/confirmada; el cableado final de sesiones/revalidación sigue pendiente.
No hay fake en src ni selector de identidad mediante env/headers. Los únicos emisores sintéticos
están en test y en la campaña local protegida por guardas Docker. src/app.ts/start permanecen intactos:
no importan ni montan las once rutas. Cambiar NODE_ENV no las habilita.

Los errores del módulo usan el adapter explícito businessErrorResponse sobre el handler central BE-08:
`{error:{code,message}}`. El formato legacy de la app pública no cambia. No se retornan queries,
credenciales, URI ni excepciones del proveedor. Sin logging adicional de payloads.

## Persistencia candidata e integridad

Namespace explícito `agro_business_<sufijo>_{fields,areas,controls}`. Es una propuesta local aislada,
no una observación ni migración de Atlas. IDs string; Dates BSON en storage y UTC ISO en DTO.
Área almacena clientId derivado del contexto para filtrar y fieldId para comprobar la relación.
Modelos strict/strictQuery throw, cast deshabilitado, autoCreate/autoIndex false. Aprovisionamiento
explícito solo para namespace nuevo; BSON valida forma/tipos/versiones y rechaza campos extra.

Índices: unique(realm,id) en cada recurso; campos(realm,clientId,active,id);
áreas(realm,clientId,fieldId,active,id); unique(realm,clientId) en controls. Runtime comprueba
unicidad completa/collation simple antes de operar; no hay TTL ni borrado histórico.

Las mutaciones usan transacción snapshot + majority/journal, deadline 10 s y control por cliente.
El control serializa writers de campos/áreas: crear área y desactivar padre no pueden dejar un área
activa bajo un campo desactivado por este módulo. Versionado CAS evita actualizaciones perdidas.
Un futuro writer de sensores debe participar del mismo protocolo/control, no solo consultar si existen.
Hasta integrar ese protocolo y su reader, el puerto de dependencias por defecto es desconocido y bloquea bajas.

## Defectos encontrados y corregidos

- El tipado de Model.collection no preservaba BusinessDocument al usar operaciones nativas: se usan
  colecciones genéricas explícitas, sin any ni coerción ObjectId.
- Un PATCH con propiedad omitida podía sobrescribir el valor anterior con undefined: se eliminan
  únicamente valores undefined antes del merge, conservando null explícito y datos no modificados.
- Se refuerzan acknowledged/matched/modified en escrituras y límites de versión.
- Una baja podía guardar fecha anterior al recurso si retrocedía el reloj: chequeo cronológico antes
  de mutar, rechazo seguro y rollback; M13 comprueba que activo/version quedan intactos.
- GET/DELETE con body ahora se rechazan en la factory: no se ignoran payloads no contratados.
No se modificó ningún test anterior ni contrato HTTP público para ocultar fallos.

## PROBADO

- npm ci, typecheck y build: aprobados, sin dependencias añadidas ni cambios de lock.
- Baseline realmente ejecutada: **360/360**; final: **374/374**, cero fallos/omitidos.
- **13/13 escenarios HTTP equivalentes** al app base d504c8e mediante comparador reproducible.
  El comparador transpila src/app.ts de la base y verifica que sus dependencias compartidas siguen
  sin cambios; compara status/body y headers contractuales, excluyendo request IDs/fechas dinámicos.
- **13/13 casos MongoDB 8.0.38**, replica set de un nodo, dos conexiones independientes,
  incluyendo CAS, cinco carreras padre/hijo, índices, BSON, aislamiento, dependencias y reloj.
- Launcher/guard/connectOwned reutilizan patrones AGRO-DB-02, sin repetir sus 15 casos históricos.
  No se afirma campaña standalone nueva ni prueba multiproceso/failover multinodo.
- Run b69e5ad44ce24a5cb6405fe4; contenedor cdabc5cce909b312989f2eab04f30fef17302f72f0146d124183596c9fe10671;
  puerto 127.0.0.1:27049, red exclusiva agro-db02-b69e5ad44ce24a5cb6405fe4 y dos tmpfs, sin volúmenes ajenos.
  Imagen oficial digest sha256:9d0a9018ce342fec9c879a4d45525f45431c398fbea9d48b4ea0e656fdd274b1.
  Base, contenedor y red propios retirados; manifiesto cleanupConfirmed=true. Imagen conservada.
- Primer intento desde shell restringida no encontró Docker y no creó recursos; ejecución autorizada
  en el contexto de Docker Desktop sí completó la campaña. No se instaló software.
- JSON/referencias OpenAPI, enlaces, diff-check y revisión de secretos/archivos generados: comprobaciones
  locales estructurales. No se ejecutó un validador OpenAPI especializado ni se instalaron dependencias.

Evidencia ignorada: .local-evidence/be10-{baseline,offline,npm-ci,docker}.log,
be10-mongodb.json, be10-http.json. Manifiestos Docker bajo ../integraciones/be10-20261119.
Detalles: [matriz de pruebas](MATRIZ_BE10_PRUEBAS.md).

## PENDIENTE / DESHABILITADO

Todas las rutas siguen deshabilitadas por defecto. Pendientes: aprobación de contratos CRUD y
mapeo físico, integración de sesiones reales, reader/writers coordinados de dependencias,
decisión de exposición y CORS, Preview autorizado, revisión/integración del PR futuro.
FE necesita API de campos/cliente real, versionado y paginación; GET /areas no es intercambiable
con AreaResumen porque no se implementaron contadores de sensores/alertas. No se inventaron ceros.
Se comprobó además api/client.ts real: solo tipa GET/POST, parsea JSON incluso ante 204 y supone
error:string. FE deberá soportar PATCH/DELETE, respuesta vacía y errores estructurados; no se lo modificó.
Sin Atlas, Google real, frontend modificado, ingesta modificada ni autenticación productiva.
BE-10 no se marca Done. Próximo paso: revisión FE/BE y del mapeo, luego integración aislada con
sesiones/dependencias; no habilitar producción por el resultado de estas pruebas.
