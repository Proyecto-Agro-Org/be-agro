# Definition of Done — `be-agro`

Una tarea del backend puede pasar a **Done** cuando cumple este checklist y los criterios generales de [Definition of Done del proyecto](../docs/DEFINITION_OF_DONE.md).

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
- [ ] El alcance vigente usa tipos estáticos: los DTOs no validan por sí solos payloads HTTP en runtime. Si un Issue requiere validación runtime, debe incluirla explícitamente y aprobar la herramienta/esquemas antes de marcarlo Done.

## Autenticación y aislamiento

- [ ] Middleware de autenticación protege todas las rutas de negocio; solo login y endpoints expresamente públicos quedan fuera.
- [ ] El contexto de entidad se obtiene de la sesión/usuario autenticado, no de valores enviados por el cliente.
- [ ] Todas las consultas y agregaciones filtran por la entidad del usuario dentro del repository.
- [ ] Las referencias entre entidad, campo, dispositivo y medición conservan el mismo `entityId`.
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
