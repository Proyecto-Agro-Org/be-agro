# Implementation plan — `be-agro`

**Proyecto:** A26T02 — Red IoT de Sensores de Suelo  
**Estado:** Plan inicial para seguimiento del equipo  
**Actualizado:** 2 de noviembre de 2026  
**Documento de alcance y contrato:** [Especificación del backend](ESPECIFICACION.md)

## Cómo usar este plan

- Cada etapa contiene tareas identificables y criterios para decidir cuándo se completaron.
- Las casillas son el estado compartido del equipo. Al cerrar una tarea, actualizar la casilla en el PR que entrega ese trabajo.
- Antes de empezar, sincronizar la rama de trabajo con `develop` y revisar este plan y sus dependencias.
- Se puede trabajar en paralelo cuando las tareas no dependen de una decisión o artefacto pendiente. Respetar las dependencias indicadas.
- Si una decisión bloquea el trabajo, registrar la pregunta y el bloqueo en el PR/Issue; no implementar una suposición como si estuviera aprobada.
- Las personas pueden tomar tareas de etapas distintas si las dependencias están cumplidas. Este plan no asigna tareas a integrantes específicos.

### Estados

- `[ ]` Pendiente
- `[/]` En curso
- `[x]` Terminado e integrado en `develop`
- `[!]` Bloqueado por decisión o dependencia externa

Al cambiar a `[x]`, la tarea debe cumplir todos sus criterios de aceptación y estar integrada. Un trabajo local o un PR todavía abierto no cuenta como terminado.

## Vista de etapas

| Etapa | Resultado | Se puede iniciar cuando |
|---|---|---|
| 0. Alineación | Decisiones de producto, datos y tecnología cerradas. | Inmediato. |
| 1. Contratos | OpenAPI y modelo de datos compatibles con frontend e ingesta. | Etapa 0. |
| 2. Base técnica | API ejecutable, configuración, MongoDB y seguridad transversal. | Stack y convenciones aprobados; puede arrancar el scaffold mientras se cierra parte de Etapa 1. |
| 3. Funcionalidades | Endpoints y servicios implementados por dominio. | Contratos y modelo de datos acordados; base técnica disponible. |
| 4. Integración y salida | Frontend conectado, QA conjunto y despliegue de prueba. | Funcionalidades requeridas integradas. |

## Etapa 0 — Alineación y decisiones

**Objetivo:** quitar ambigüedades que causarían retrabajo en el modelo, autenticación o contrato.

- [ ] **E0.1 — Confirmar stack del backend**
  - Confirmar Node.js LTS, Express, TypeScript, MongoDB Atlas, Mongoose, Vitest y Supertest.
  - Acordar versión de Node, gestor de paquetes, lint/formato y comandos estándar.
  - **Aceptación:** decisiones registradas en la especificación y sin alternativas abiertas para crear el proyecto.

- [ ] **E0.2 — Definir relación usuario-entidad y alcance de datos**
  - El modelo acordado usa `entityId` en cada documento de datos; `clientes._id` identifica la entidad raíz. Confirmar tipo BSON y nombre exacto de la colección/campos que representan `campos`.
  - Documentar las relaciones entidad → usuarios/campos; campo → dispositivos; dispositivo → mediciones, y cómo verificar que el `entityId` sea consistente en toda la relación.
  - No se implementan roles ni permisos por endpoint en esta etapa; acordar `404` para recurso ajeno o inexistente.
  - **Aceptación:** modelo documentado y ejemplo muestra que el middleware obtiene `entityId` del usuario y todas las consultas quedan limitadas a esa entidad.

- [ ] **E0.3 — Acordar nomenclatura y relaciones de dominio**
  - Confirmar si `lotes` equivale a `areas` en el frontend o si son conceptos distintos.
  - Confirmar relación `cliente → lote/área → dispositivo → mediciones` y claves exactas.
  - Confirmar si `dispositivos._id` coincide con `mediciones.device_id`.
  - **Aceptación:** diagrama de relaciones y nombres de API acordados por backend, frontend e ingesta.

- [ ] **E0.4 — Definir autenticación y sesión**
  - Google es el proveedor de identidad por requisito del profesor. Confirmar si el frontend obtiene un ID token de Google para que el backend lo verifique o si se implementa el flujo OAuth con callback en backend.
  - Confirmar qué cuentas se admiten: dominio permitido, lista habilitada o cualquier cuenta Google; definir alta automática o usuario precreado y cómo se asocia con una entidad.
  - Si la aplicación emite sesión propia, confirmar JWT en cookie `httpOnly`, duración, nombre, `Secure`, `SameSite`, `Path`, dominio y logout.
  - Definir estrategia CSRF según origen y modo de envío de cookies.
  - Confirmar qué devuelve `POST /auth/login` y si el frontend necesita `GET /auth/me`.
  - **Aceptación:** flujo Google, política de cuentas y entidad, contrato de sesión y configuración local/despliegue documentados; frontend confirma el cambio desde el mock email/password.

- [ ] **E0.5 — Definir reglas de telemetría y disponibilidad**
  - Confirmar frecuencia de publicación, formato real del timestamp, unidades y si una medición puede ser parcial.
  - Definir umbral de conectado/desconectado y fuente de `ultima_comunicacion`.
  - Confirmar si la ubicación vigente viene de `dispositivos` o se toma de la medición más reciente.
  - **Aceptación:** ejemplo de payload válido y reglas sin depender de los mocks provisionales.

- [ ] **E0.6 — Definir alertas de la Etapa 2**
  - Confirmar si se almacenan en colección propia o se calculan desde mediciones/estado.
  - Definir reglas técnicas/agronómicas, severidad, transiciones, resolución y orden del Dashboard.
  - **Aceptación:** esquema y ciclo de vida de alerta descritos; alcance compatible con filtros usados por frontend.

- [ ] **E0.7 — Elegir hosting de prueba**
  - Comparar Render/Railway según soporte Node, HTTPS, variables, persistencia de logs, límites del plan y conexión a Atlas.
  - **Aceptación:** proveedor elegido, URL/origen esperado y proceso de despliegue anotados.

## Etapa 1 — Contratos API y persistencia

**Objetivo:** dejar definido qué datos entran, cómo se relacionan y qué respuestas consume el frontend.

- [ ] **E1.1 — Documentar schemas completos de MongoDB**
  - Comparar el estado físico actual con [SCHEMA_PROPUESTA.md](SCHEMA_PROPUESTA.md).
  - Documentar tipos BSON y relaciones de `entityId`, `campoId` y `deviceId`; usar `googleSub` para identificar la cuenta Google interna. Completar o normalizar `entityId` si algún documento existente no lo tiene.
  - Precisar si la colección física `lotes` ya representa a los campos o si hay que crear/migrar `campos`.
  - **Aceptación:** esquema actual, esquema objetivo y diferencias/migración están documentados; no se inventan relaciones como si ya existieran.

- [ ] **E1.2 — Resolver timestamp y estrategia Time Series**
  - Verificar en Atlas el tipo real de `mediciones.timestamp` y formato de valores existentes.
  - Validar la propuesta Time Series (`timestamp` como Date BSON, `contexto` como metadata, `entityId` filtrable); definir granularidad y retención.
  - Si se requiere convertir string a BSON Date, preparar una estrategia reversible/mapeada y acordar quién transforma la ingesta.
  - **Aceptación:** consultas temporales y esquema de escritura no dependen de conversión implícita de strings.

- [ ] **E1.3 — Definir unidades, nombres y nullabilidad de mediciones**
  - Mapear `soil.humidity`, `soil.temperature`, `soil.conductivity` y `nutrients.nitrogen`, `phosphorus`, `potassium` a las variables del frontend.
  - Confirmar unidad por variable, reglas de ausencia y si las seis aparecen en todos los documentos.
  - **Aceptación:** tabla de mapeo con variable API, campo Mongo, unidad, tipo y comportamiento ante ausencia.

- [ ] **E1.4 — Acordar contrato de errores, fechas y límites**
  - Confirmar formato uniforme de error, status 400/401/404/409/429/500, timestamps UTC y formato esperado de fechas.
  - Confirmar límites de históricos y alertas y si se usará paginación en esta entrega.
  - **Aceptación:** reglas documentadas y compartidas con frontend; distinguir el tipado estático de cualquier validación que se acuerde ejecutar en runtime.

- [ ] **E1.5 — Especificar OpenAPI v1**
  - Documentar `/auth/login`, `/auth/logout`, `/auth/me`, `/dashboard/resumen`, `/areas`, `/areas/{areaId}`, `/areas/{areaId}/sensores`, `/sensores/{deviceId}`, `/sensores/{deviceId}/historico`, `/mapa/sensores`, `/alertas` y `/health`.
  - Incluir seguridad de cookie, parámetros, esquemas, nullabilidad, ejemplos y errores.
  - **Aceptación:** frontend y backend revisan el mismo archivo OpenAPI y los tipos de respuesta coinciden con los mocks o se registra el cambio requerido.

- [ ] **E1.6 — Acordar contrato de ingesta con MongoDB**
  - Comparar mensaje publicado por el dispositivo/Make con los documentos persistidos.
  - Acordar claves de correlación, timestamp, unidades y propiedad de cada cambio al schema.
  - **Aceptación:** ejemplos aprobados por responsables de backend e ingesta; no hay un campo que la API espere y la ingesta no produzca.

## Etapa 2 — Base técnica, configuración y acceso

**Objetivo:** contar con una API que arranca de forma reproducible, se conecta a Atlas y tiene políticas comunes antes de sumar endpoints de dominio.

- [ ] **E2.1 — Crear estructura inicial de `be-agro`**
  - Agregar `package.json`, TypeScript, scripts de desarrollo/build y configuración de lint/formato dentro de `be-agro/`.
  - Separar configuración, rutas, middleware, servicios y repositorios.
  - **Aceptación:** instalación limpia, build reproducible y servidor local iniciado según README.

- [ ] **E2.2 — Validar configuración de entorno**
  - Crear `.env.example` sin secretos y validar variables de entorno al iniciar.
  - Definir comportamiento claro si falta `MONGODB_URI`, origen de frontend o secreto de sesión.
  - **Aceptación:** valores ausentes o inválidos producen error de arranque claro; `.env` no se versiona.

- [ ] **E2.3 — Implementar servidor, rutas base y `/health`**
  - Configurar Express, parser JSON con límite razonable, `/api/v1` y middleware de errores.
  - Definir si health diferencia disponibilidad del proceso y de MongoDB (`/health` y readiness si hace falta).
  - **Aceptación:** ruta responde con estado/código acordados sin devolver secretos ni stack trace.

- [ ] **E2.4 — Implementar conexión a MongoDB Atlas**
  - Crear conexión administrada por configuración, manejo de errores y cierre ordenado.
  - Definir acceso tipado a colecciones existentes, respetando nombres y tipos BSON reales.
  - **Aceptación:** conexión verificada en entorno de desarrollo; falla de DB no se presenta como respuesta exitosa.

- [ ] **E2.5 — Crear infraestructura común de DTOs y errores**
  - Preparar ubicación y convención de nombres para DTORequest/DTOResponse TypeScript por operación.
  - Implementar errores de aplicación tipados y un error handler global con status HTTP y `{ error: { code, message } }`.
  - Los DTOs elegidos no validan payloads en runtime; mantener explícito ese límite.
  - **Aceptación:** respuestas de error cumplen OpenAPI; errores internos no filtran detalles en producción.

- [ ] **E2.6 — Agregar seguridad y logs comunes**
  - Configurar CORS para origen permitido y cookies con `credentials` si aplica.
  - Agregar cabeceras de seguridad, rate limit para login y logs con request ID/duración.
  - **Aceptación:** pruebas/manuales demuestran origen permitido y rechazado; logs no incluyen password, cookie, JWT ni URI de Mongo.

## Etapa 3 — Autenticación y recursos de dominio

**Objetivo:** implementar las funcionalidades del contrato. Las tareas de áreas, mediciones y mapa se pueden distribuir en paralelo una vez que modelos, repositorios y autorización estén acordados.

### 3A. Autenticación y autorización

- [ ] **E3.1 — Implementar verificación de identidad Google y resolución de usuario**
  - Verificar en backend la credencial Google según el flujo aprobado y resolver el usuario interno asociado.
  - No almacenar contraseñas de Google ni confiar únicamente en un email enviado por el cliente.
  - **Aceptación:** identidad válida, credencial inválida, cuenta no habilitada y usuario sin entidad tienen comportamiento documentado y cubierto.

- [ ] **E3.2 — Implementar sesión, logout y `/auth/me`**
  - Emitir/limpiar cookie según decisiones de E0.4 y recuperar usuario/contexto desde la sesión.
  - **Aceptación:** sesión funciona con el origen real del frontend, expira según configuración y logout invalida la sesión.

- [ ] **E3.3 — Implementar middleware de autenticación y contexto de entidad**
  - Resolver identidad y la entidad única del usuario desde una fuente confiable y pasar el contexto de forma tipada.
  - Aplicar filtros de entidad/lote/dispositivo a cada consulta de repository; no aceptar entidad elegida desde query/body.
  - **Aceptación:** pruebas comprueban usuario sin sesión y que no se devuelven datos de otra entidad.

### 3B. Áreas y dispositivos

- [ ] **E3.4 — Implementar `GET /areas` y `GET /areas/:areaId`**
  - Resolver si el recurso se llama área o lote mediante la decisión E0.3.
  - Construir totales y última actualización de datos autorizados.
  - **Aceptación:** esquema coincide con OpenAPI; área sin dispositivos y área inexistente se distinguen correctamente.

- [ ] **E3.5 — Implementar `GET /areas/:areaId/sensores`**
  - Listar sensores asociados, estado, comunicación, ubicación y contador de alertas activas.
  - **Aceptación:** respuesta ordenada de forma estable y solo contiene dispositivos autorizados.

- [ ] **E3.6 — Implementar `GET /sensores/:deviceId`**
  - Resolver información del dispositivo y asociar la última medición disponible.
  - Convertir campos Mongo al contrato API, incluyendo unidades y `null` para ausencias.
  - **Aceptación:** sensor sin lecturas devuelve ficha y `ultima_medicion: null`; recurso inexistente/ajeno aplica política acordada.

### 3C. Mediciones e históricos

- [ ] **E3.7 — Implementar repositorio de mediciones y mapeo de variables**
  - Consultar por `device_id` y rango/orden temporal usando el tipo real de timestamp.
  - Mapear nombres Mongo a nombres API y unidades aprobadas.
  - **Aceptación:** consultas cubren las seis variables y no convierten datos faltantes en cero.

- [ ] **E3.8 — Implementar `GET /sensores/:deviceId/historico`**
  - Validar variable, fechas, rango y límite; consultar puntos ascendentes y calcular `truncado` según política acordada.
  - **Aceptación:** respuesta UTC con `{timestamp, valor}`, `unidad`, `truncado`; rango inválido y sensor inexistente tienen error definido.

### 3D. Mapa y Dashboard

- [ ] **E3.9 — Implementar `GET /mapa/sensores`**
  - Devolver catálogo autorizado, ubicación elegida por regla de E0.5 y resumen de humedad/temperatura reciente.
  - **Aceptación:** incluye sensores sin coordenadas válidas con `ubicacion: null`; no descarta dispositivos autorizados.

- [ ] **E3.10 — Implementar `GET /dashboard/resumen`**
  - Agregar conteos, áreas, alertas recientes y timestamp de última actualización.
  - Evitar que los conteos del dashboard y las listas usen reglas divergentes.
  - **Aceptación:** totales recalculables desde las respuestas/consultas de dominio y reglas del Dashboard documentadas.

### 3E. Alertas

- [ ] **E3.11 — Implementar modelo o servicio de alertas**
  - Aplicar el diseño de E0.6; añadir colección/índices si se aprueba persistirlas o reglas de cálculo si son derivadas.
  - **Aceptación:** ciclo de vida, fuente, timestamp y criterios de severidad trazables.

- [ ] **E3.12 — Implementar `GET /alertas`**
  - Aceptar filtros combinables de área, tipo, estado, severidad, fechas y límite.
  - Ordenar alta→media→baja y fecha descendente; devolver total antes del límite.
  - **Aceptación:** filtros se aplican en conjunto, entradas inválidas producen 400 y el resultado respeta ámbito de cliente.

### 3F. Pruebas de funcionalidades

- [ ] **E3.13 — Cubrir autenticación, aislamiento y contratos tipados**
  - Probar credenciales inválidas, sesión faltante/expirada, ámbito de entidad cruzado y DTOs de request/response.
  - **Aceptación:** pruebas automatizadas independientes de una base real compartida.

- [ ] **E3.14 — Cubrir consultas y agregaciones**
  - Probar colecciones vacías, nulls, límites de fechas, orden, resultados parciales, 404 y fallo de base de datos.
  - **Aceptación:** cada endpoint tiene casos positivos, negativos y borde relevantes.

## Etapa 4 — Integración, QA y entrega

**Objetivo:** validar el recorrido del usuario de punta a punta y dejar una versión que el equipo pueda levantar y demostrar.

- [ ] **E4.1 — Conectar el frontend a la API**
  - Configurar URL base, envío de cookies y credenciales CORS; apagar MSW solo en el entorno integrado.
  - Ajustar cliente/tipos si el contrato difiere de los mocks y registrar el cambio.
  - **Aceptación:** login, sesión, expiración y manejo uniforme de errores funcionan desde el navegador.

- [ ] **E4.2 — Ejecutar recorrido funcional integrado**
  - Verificar Login → Dashboard → Áreas → Detalle de área → Sensor → Históricos, Mapa y Alertas.
  - **Aceptación:** datos reales/autorizados, estados vacíos, fechas, unidades y errores se presentan correctamente.

- [ ] **E4.3 — Revisar seguridad y configuración de despliegue**
  - Revisar secretos, CORS, cookies, CSRF, rate limit, logs y reglas de acceso a Atlas.
  - **Aceptación:** checklist de DoD completado en entorno de prueba y sin credenciales en repo/logs.

- [ ] **E4.4 — Desplegar backend de prueba**
  - Configurar variables, build/start, healthcheck, URL HTTPS y acceso de red a Atlas.
  - **Aceptación:** API permanece accesible, health refleja estado acordado y el frontend de prueba la consume.

- [ ] **E4.5 — Cerrar documentación y plan**
  - Actualizar README del backend, OpenAPI, especificación, decisiones y checks de este plan.
  - **Aceptación:** integrante nuevo puede hacer pull, instalar, configurar entorno local y ejecutar API/pruebas siguiendo documentación.

## Dependencias y trabajo en paralelo

```text
Etapa 0: decisiones
       ├── Etapa 1: modelo y OpenAPI
       └── Etapa 2: scaffold puede iniciar tras aprobar stack
                    │
                    └── Etapa 3: auth / catálogo / mediciones / alertas
                                  ├── dominios independientes en paralelo
                                  └── dashboard y mapa consumen servicios/repositorios
                                                    │
                                                    ▼
                                      Etapa 4: integración y despliegue
```

Para repartir entre cuatro integrantes, conviene tomar tareas completas por módulo y respetar contratos compartidos: una persona puede cerrar decisiones/documentación mientras otras preparan el scaffold cuando el stack está confirmado; luego se pueden trabajar autenticación, catálogo, mediciones y alertas en ramas distintas si los tipos/repositorios base ya están definidos. Dashboard debe integrar servicios de áreas, mediciones y alertas, así que no conviene duplicar sus reglas en paralelo.

## Definition of Done común

- [ ] Criterios de aceptación del Issue cumplidos y reflejados en OpenAPI/documentación.
- [ ] DTORequest/DTOResponse definidos y alineados con OpenAPI; el alcance actual usa tipos estáticos, no validación runtime.
- [ ] Middleware de autenticación y aislamiento por entidad aplicado en toda ruta protegida.
- [ ] Casos positivos, negativos y borde relevantes cubiertos.
- [ ] No hay secretos en código, fixtures, logs ni `.env.example`.
- [ ] Errores no filtran stack traces ni detalles internos en producción.
- [ ] PR revisado e integrado en `develop`.
- [ ] Casillas de esta planificación actualizadas en el mismo PR o en un PR de seguimiento.

## Bloqueos conocidos al iniciar el plan

- Faltan los campos completos y relaciones de `clientes`, `dispositivos`, `lotes` y `usuarios`.
- El schema declara `mediciones.timestamp` como string; validar documentos reales y decisión Time Series.
- No se definió la equivalencia `lotes` ↔ `areas`.
- No figura una colección de alertas ni reglas aprobadas para producirlas.
- Google login es requisito del profesor; el mock/cliente actual todavía usa email/password y token JSON, por lo que hay que acordar y alinear el flujo.
- Frecuencia, unidades, umbral de desconexión y ubicación vigente requieren confirmación.

No se debe marcar como terminada una funcionalidad que dependa de un bloqueo hasta resolverlo o reducir formalmente el alcance.
