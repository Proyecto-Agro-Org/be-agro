# Definition of Done — `be-agro`

Una tarea del backend puede pasar a **Done** cuando cumple este checklist, sus criterios de aceptación y tiene PR revisado, integrado y probado en la rama de integración acordada. El documento general antes referenciado en `../docs/DEFINITION_OF_DONE.md` no está disponible en este checkout; no se presume verificado. Actualización BE-01: 16/11/2026, según plan del 05/11/2026.

Para BE-00/BE-01, el entregable es documental: auditoría con evidencias, decisiones confirmadas separadas de propuestas y verificaciones locales. No exige implementar las funcionalidades de etapas posteriores ni autoriza marcar sus casillas como completadas. La entrega local queda pendiente de revisión/integración.

## Arquitectura y responsabilidades

- [ ] Respeta el flujo `Route → Controller → Service → Repository/Model` definido en [AGENTS.md](AGENTS.md).
- [ ] El controller maneja HTTP y mapea DTOs; no contiene reglas de negocio ni accede directamente a MongoDB.
- [ ] El service contiene la lógica de dominio y no depende de objetos Express (`Request`/`Response`).
- [ ] El repository encapsula las consultas de MongoDB y todos los filtros necesarios por entidad.
- [ ] Las integraciones externas se implementan mediante adapters; controllers/services no acoplan lógica al SDK/proveedor.
- [ ] Los documentos Mongoose no se devuelven directamente como respuesta HTTP; se mapean a DTOResponse.

## DTOs y contrato API

- [ ] Cada operación HTTP tiene DTORequest y DTOResponse TypeScript, o deja documentado por qué uno de ellos no aplica.
- [ ] DTOs, endpoint, status y ejemplos coinciden con OpenAPI y con el contrato acordado con frontend.
- [ ] No se usa `any` para eludir la definición de contrato.
- [ ] Los DTOs no validan JSON por sí solos. Los esquemas Zod aprobados validan params/query/body y entorno en las operaciones implementadas; pruebas comprueban entradas inválidas, no solo compilación.

## Autenticación y aislamiento

- [ ] Middleware de autenticación protege todas las rutas de negocio; solo login y endpoints expresamente públicos quedan fuera.
- [ ] El contexto de entidad se obtiene de la sesión/usuario autenticado, no de valores enviados por el cliente.
- [ ] Todas las consultas y agregaciones filtran por la entidad del usuario dentro del repository.
- [ ] Las referencias Cliente → Campo → Área → Dispositivo → Mediciones conservan el mismo cliente; IDs/tipos y equivalencia de `lotes` están acordados, sin asumir campos físicos inexistentes.
- [ ] Se verificó que un usuario no puede leer recursos de otra entidad; recursos ajenos se manejan como `404` según la política acordada.
- [ ] No se agregan roles ni permisos por endpoint mientras el alcance siga siendo separación por entidad.

## Errores y observabilidad

- [ ] Los errores pasan por un error handler centralizado.
- [ ] Cada error usa status HTTP coherente y cuerpo uniforme `{ "error": { "code": "...", "message": "..." } }`.
- [ ] Códigos estables y mensajes seguros; no se incluyen detalles, stack traces, credenciales, tokens ni queries en la respuesta.
- [ ] Los errores inesperados se registran para diagnóstico interno sin exponer secretos.
- [ ] Rutas inexistentes y errores asíncronos terminan en la respuesta estándar; ningún error inesperado se transforma en `200`.

## Pruebas backend

- [ ] Pruebas cubren reglas de service, mapeo DTO, repositories relevantes, middleware de autenticación/entidad y error handler según el alcance del Issue.
- [ ] Casos con colecciones vacías, valores ausentes/null, recurso inexistente, entidad incorrecta y error de base están cubiertos cuando apliquen.
- [ ] Las pruebas no requieren credenciales de producción ni dependen de una base compartida mutable.

## Persistencia, magnitudes e integración

- [ ] Las mediciones usan colecciones convencionales; no se crean Time Series ni se eliminan históricos/activan TTL sin aprobación.
- [ ] Índices por cliente/dispositivo/tiempo y demás filtros están documentados y verificados en una base aislada cuando corresponda.
- [ ] Se distinguen timestamp de adquisición y recepción, formatos reales y salida UTC. No se ordenan fechas heterogéneas como strings sin política explícita.
- [ ] Los mappers normalizan unidades y conservan ausencias como `null`, con trazabilidad de fuente/método/calibración cuando corresponda. S8 no se presenta como fuente directa de NPK/pH ni de humedad volumétrica sin calibración.
- [ ] Se conserva compatibilidad con `campo_id`, `area_id`, `device_id` y rutas `/sensores` del frontend, o se acuerda y documenta el cambio junto con frontend.
- [ ] Alertas visuales de ausencia permanecen a cargo del frontend; no se exige worker/WebSocket ni historial de desconexión en el MVP.
- [ ] Se distingue la evidencia del código de ingesta de las colecciones/documentos observados en Atlas; ningún schema propuesto se presenta como físico existente.
