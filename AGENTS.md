# Instrucciones para agentes — proyecto Agro

Estas instrucciones aplican al contenido de `be-agro/`. Si una regla contradice un contrato aprobado en `ESPECIFICACION.md`, prevalece el contrato vigente y se actualizan ambos documentos mediante PR.

## Backend `be-agro`

### Arquitectura

- Implementar una API con arquitectura MVC organizada en capas: `routes → controllers → services → repositories/models`.
- En una API JSON no se crean vistas HTML. Los DTOResponse y sus mappers/serializadores cumplen el rol de presentación: el modelo de MongoDB nunca se devuelve directamente al cliente.
- Los controllers son delgados: traducen HTTP a una llamada de aplicación y el resultado a status/headers/DTOResponse. No contienen reglas de negocio ni consultas MongoDB.
- Los services concentran reglas de dominio y coordinación de operaciones. No dependen de `Request`/`Response` de Express ni deciden formato HTTP.
- Los repositories encapsulan consultas y escrituras de MongoDB. Los services no construyen queries Mongoose directamente.
- Los models contienen esquemas/tipos de persistencia Mongoose; no exponen detalles de persistencia en los contratos HTTP.
- Las comunicaciones con proveedores o servicios externos se encapsulan en `adapters/` (por ejemplo, clientes HTTP o SDK). Controllers y services no instancian SDKs ni implementan protocolo de proveedor directamente.
- Mantener módulos separados por responsabilidad dentro de las carpetas MVC; evitar archivos monolíticos y dependencias circulares.

### Estructura de referencia

```text
be-agro/
└── src/
    ├── app.ts
    ├── server.ts
    ├── config/
    ├── routes/
    ├── controllers/
    ├── services/
    ├── repositories/
    ├── models/
    ├── dto/
    ├── middlewares/
    ├── adapters/
    ├── errors/
    └── utils/
```

La estructura puede evolucionar mediante decisión documentada, manteniendo las mismas responsabilidades y el flujo de dependencias.

### DTOs y contratos

- Definir un `DTORequest` y un `DTOResponse` tipado para cada operación HTTP, nombrados por recurso/operación (por ejemplo, `GetSensorRequest` y `GetSensorResponse`). Para endpoints sin body, el DTORequest representa params/query; si no hay entrada, documentar explícitamente que no aplica.
- Declarar los DTOs como tipos/interfaces TypeScript y mantenerlos alineados con OpenAPI y los tipos consumidos por frontend.
- Los controllers reciben/mapean datos al DTOResponse. Los services y repositories no retornan documentos Mongoose como respuesta pública.
- No usar `any` para evitar definir un contrato; preferir tipos explícitos y `unknown` con estrechamiento cuando corresponda.
- **Límite aceptado:** los DTOs TypeScript ofrecen comprobación estática; no validan JSON recibido en runtime. No afirmar que un request HTTP queda validado solo por tener una interfaz. Si el equipo requiere validación de runtime, deberá aprobar esquemas (por ejemplo Zod) y actualizar este documento y el DoD.

### Sesión y separación por entidad

- Todas las rutas de negocio requieren usuario autenticado, salvo endpoints declarados públicos como login y health.
- Un usuario pertenece a una sola entidad/cliente para esta etapa. El middleware de autenticación carga la identidad y el `entityId` desde una fuente confiable de sesión/usuario.
- Aplicar la separación de entidad en cada consulta del repository. No confiar en `entityId`, `cliente_id` o equivalente proveniente de body, query o headers públicos para decidir el alcance de datos.
- Mantener consistente `entityId` en las relaciones entidad → campo → dispositivo → medición; validar relaciones usando IDs persistidos.
- No implementar roles ni permisos por endpoint en esta etapa. La protección definida es autenticación y aislamiento de datos por entidad.
- Un recurso fuera del ámbito de la entidad responde con el status acordado en la especificación; por defecto usar `404` para no revelar su existencia.

### Middleware y errores

- Mantener middleware común para autenticación, contexto de entidad, manejo de errores, request ID/logging y rutas inexistentes.
- Los services lanzan errores de aplicación tipados cuando sea necesario. Un único error handler los traduce a status HTTP y respuesta pública.
- Formato uniforme de error: `{ "error": { "code": "...", "message": "..." } }`.
- Usar status HTTP coherentes: `400` entrada mal formada, `401` sin sesión, `404` recurso inexistente o fuera de entidad, `409` conflicto, `429` límite excedido y `500` error inesperado. Agregar otro status solo cuando tenga semántica clara y documentada.
- El código de error es estable y apto para lógica del frontend; el mensaje es seguro y legible. No devolver stack traces, queries, credenciales ni detalles internos. Registrar diagnóstico interno sin secretos.
- Ninguna ruta debe capturar y ocultar errores inesperados con una respuesta `200` o un mensaje genérico emitido desde cada controller.

### Persistencia e integraciones

- Respetar los nombres, tipos BSON y relaciones reales descritos/acordados en la especificación. No inventar campos ni asumir equivalencias entre `lotes` y `areas`.
- Convertir documentos Mongo a DTOResponse mediante mappers explícitos cuando las formas difieran.
- Los endpoints que consultan Mongo usan repositories y aplican el filtro por entidad en la consulta, no después de recuperar datos de otras entidades.
- `be-agro` no consume MQTT ni reemplaza el proceso de ingesta salvo que el alcance se modifique expresamente.

### Cambios y verificación

- Antes de implementar, revisar `IMPLEMENTATION_PLAN.md`, `ESPECIFICACION.md`, `DEFINITION_OF_DONE.md` y los Issues vinculados.
- Al modificar un endpoint, actualizar DTOs, OpenAPI y documentación frontend/backend afectada en el mismo cambio.
- Cubrir reglas de services, mapeo de DTOs, middleware de sesión/entidad y comportamiento del error handler con pruebas apropiadas.
- No marcar tareas del implementation plan como completas hasta integrar el PR y satisfacer sus criterios de aceptación.
