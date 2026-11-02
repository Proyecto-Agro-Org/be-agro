# Especificación inicial del backend `be-agro`

**Proyecto:** A26T02 — Red IoT de Sensores de Suelo  
**Estado:** Borrador para revisión del equipo  
**Fecha:** 30 de octubre de 2026

## 1. Propósito

Definir el alcance, requisitos, tecnologías, contrato HTTP y tareas de implementación del backend de consulta para conectar el frontend con MongoDB Atlas. El documento sirve como base para confirmar decisiones con el equipo y crear Issues pequeños, verificables y asignables.

## 2. Alcance

`be-agro` es una API HTTP para autenticar usuarios y servir datos de áreas, sensores, mediciones, alertas y resúmenes al frontend.

El alcance de esta especificación incluye:

- Autenticación de usuarios y autorización de consultas.
- Lectura de datos persistidos en MongoDB Atlas.
- Endpoints requeridos por las pantallas actuales del frontend.
- Validación de parámetros, manejo de errores y documentación OpenAPI.
- Pruebas automatizadas y despliegue de prueba.

Fuera de alcance inmediato:

- Consumir MQTT o conectarse directamente al broker desde esta API.
- Recibir telemetría de los dispositivos o decidir el mecanismo de ingesta.
- Escribir comandos de configuración hacia dispositivos.
- Análisis/IA y recomendaciones agronómicas.
- CRUD administrativo de clientes, áreas, sensores y usuarios, salvo que el equipo lo incorpore expresamente.

La ingesta MQTT → MongoDB es un componente separado. La API leerá las colecciones compartidas que produzca ese flujo; ambos componentes deben acordar el esquema de documentos e identificadores.

## 3. Autenticación y separación por entidad

- Un usuario autenticado pertenece a una sola entidad/cliente en esta etapa.
- Las rutas de negocio requieren autenticación; login y health son públicos salvo decisión operativa distinta.
- Cada documento de dominio incluye `entityId`, que lo vincula con su entidad. El middleware obtiene el `entityId` del usuario autenticado y las consultas filtran por ese valor en el repository.
- La relación funcional se mantiene: entidad → usuarios/campos; campo → dispositivos; dispositivo → mediciones. El `entityId` de un recurso relacionado debe ser consistente con el de su campo/dispositivo padre.
- No se implementan roles ni permisos granulares por endpoint en esta etapa. La regla de acceso es el aislamiento por entidad.
- Nunca se confía en un `cliente_id` o `entity_id` enviado por el frontend para seleccionar el ámbito de datos.
- Recurso inexistente y recurso perteneciente a otra entidad deben responder según una política uniforme; por defecto `404` para no revelar existencia.

## 4. Requisitos funcionales

### RF-01 — Inicio de sesión con Google

El login debe realizarse con una cuenta de Google, como requisito del profesor. El backend verifica la identidad/credencial de Google según el flujo aprobado y la vincula con un usuario interno y una entidad. No se almacenan contraseñas de Google. Una autenticación válida crea la sesión de la aplicación según la decisión de E0.4; una credencial inválida o una cuenta no habilitada se rechaza sin filtrar información sensible.

### RF-02 — Sesión y cierre de sesión

Proveer una forma de cerrar sesión que expire la cookie y una forma para que el frontend conozca al usuario autenticado si la necesita. Definir explícitamente expiración, `Secure`, `SameSite`, dominio/path y estrategia de renovación. No almacenar secretos ni credenciales de MongoDB en el cliente.

### RF-03 — Dashboard y áreas

Servir un resumen calculado desde los datos autorizados, lista de áreas y detalle de cada área con sensores asociados. Totales y estados deben derivarse de una fuente consistente, no duplicarse como datos manuales.

### RF-04 — Sensores y últimas mediciones

Servir la ficha de un sensor con ubicación, estado, última comunicación y última medición disponible. Un dato ausente se representa como `null`, nunca como cero. Un sensor sin comunicación previa es desconectado y su `ultima_comunicacion` es `null`.

### RF-05 — Históricos

Consultar la serie de una variable por sensor dentro de un rango temporal. Aceptar fechas ISO 8601 con zona horaria, responder timestamps en UTC y validar que `desde < hasta`. Limitar la cantidad máxima de puntos y marcar explícitamente si la serie fue truncada.

### RF-06 — Mapa

Servir sensores autorizados con ubicación y resumen de última medición. Coordenadas faltantes o inválidas no deben impedir que el sensor aparezca en la respuesta.

### RF-07 — Alertas

Listar alertas con filtros opcionales por área, tipo, estado, severidad y fechas. Ordenar severidad alta→media→baja y, dentro de cada nivel, más reciente primero. Informar el total antes del límite aplicado.

### RF-08 — Salud y operación

Exponer un endpoint de salud que compruebe disponibilidad del proceso y, si el despliegue lo requiere, conectividad con MongoDB. No incluir secretos ni detalles internos en respuestas públicas.

## 5. Requisitos no funcionales

- **RNF-01 Seguridad:** HTTPS en despliegues; secretos por variables de entorno; CORS limitado al origen del frontend; protección contra fuerza bruta en login, al menos con rate limit básico.
- **RNF-02 Contratos:** cada endpoint declara DTORequest y DTOResponse TypeScript. Esta decisión ofrece comprobación estática; por sí sola no valida en runtime los datos JSON recibidos.
- **RNF-03 Consistencia del contrato:** prefijo `/api/v1`; respuestas serializadas con nombres y nullabilidad acordados con el frontend.
- **RNF-04 Fechas:** persistir/transportar timestamps como UTC ISO 8601; interpretar los límites de históricos como instantes, no como fechas locales implícitas.
- **RNF-05 Rendimiento:** índices para claves de acceso y filtros frecuentes; paginación/límites para consultas que puedan crecer.
- **RNF-06 Errores:** formato uniforme y códigos HTTP coherentes; no exponer stack traces ni mensajes internos en producción.
- **RNF-07 Observabilidad:** logs estructurados con método, ruta, estado, duración e identificador de petición, sin passwords, tokens ni datos sensibles.
- **RNF-08 Mantenibilidad:** separar rutas, validación, lógica de aplicación, acceso a datos y configuración.
- **RNF-09 Documentación:** mantener README de ejecución/configuración y especificación OpenAPI actualizados.

## 6. Tecnologías propuestas

| Área | Propuesta inicial | Estado / decisión pendiente |
|---|---|---|
| Runtime | Node.js LTS | Confirmar versión concreta y fijarla en `engines`/archivo de versión. |
| HTTP | Express | Propuesta del documento de backend; confirmar con el equipo. |
| Lenguaje | TypeScript | Propuesta; compartir tipos con frontend solo si no genera acoplamiento de modelos internos. |
| Base de datos | MongoDB Atlas | Base seleccionada por el proyecto. |
| ODM | Mongoose | Propuesta; validar compatibilidad con colección Time Series y esquema de ingesta. |
| Mediciones | MongoDB Time Series Collection | Decisión mencionada para históricos; definir `timeField`, `metaField`, granularidad y retención. |
| Contratos HTTP | DTORequest/DTOResponse TypeScript | Decisión: interfaz/tipo por operación. La validación de runtime de requests no forma parte del alcance actual. |
| Autenticación | JWT en cookie `httpOnly` | Propuesta; falta decidir access/refresh, expiración, `SameSite`, CSRF y logout. |
| Hash de contraseñas | bcrypt / bcryptjs | Elegir paquete y factor de costo. |
| Pruebas | Vitest + Supertest | Propuesta; decidir base aislada/mock y estrategia de integración Mongo. |
| API docs | OpenAPI (Swagger UI o archivo OpenAPI) | Incluir en la primera entrega para que frontend y BE validen el contrato. |
| Hosting | Render o Railway | Pendiente. Verificar plan, variables, conexión de Atlas, URL pública y proceso de deploy. |

Estas tecnologías son propuestas, no decisiones aprobadas salvo MongoDB Atlas. Confirmarlas antes del primer Issue de scaffolding.

## 7. Contrato HTTP inicial

Todas las rutas se publican bajo `/api/v1`. Los ejemplos de respuesta reflejan los tipos y mocks actuales del frontend; son el punto de partida para acordar el contrato, no una promesa de que todos los campos del dominio ya estén confirmados.

### 7.1 Autenticación

| Método y ruta | Acceso | Respuesta esperada |
|---|---|---|
| `POST /auth/login` | Público | Recibe la credencial/código de Google definido en E0.4; `200`: usuario autenticado y cookie de sesión; `401`: credencial inválida o cuenta no habilitada. |
| `POST /auth/logout` | Autenticado | `204` y cookie expirada. |
| `GET /auth/me` | Autenticado | Usuario y contexto de entidad actual. |

El contrato actual del mock usa email/password y devuelve token JSON, pero no satisface el requisito de Google. Debe actualizarse el cliente del frontend al flujo Google aprobado y acordar CORS/credentials si la sesión de la aplicación usa cookie `httpOnly`.

### 7.2 Recursos de consulta

| Método y ruta | Uso | Respuesta principal |
|---|---|---|
| `GET /dashboard/resumen` | Métricas, áreas, alertas recientes y última actualización. | `{ resumen, areas, ultimas_alertas, ultima_actualizacion }` |
| `GET /areas` | Listado y resumen por área. | `{ areas: AreaResumen[] }` |
| `GET /areas/:areaId` | Nombre e identidad de área. | `{ area_id, nombre }` |
| `GET /areas/:areaId/sensores` | Sensores de un área. | `{ sensores: SensorDeArea[] }` |
| `GET /sensores/:deviceId` | Ficha, estado y última medición. | `SensorDetalle` |
| `GET /sensores/:deviceId/historico` | Serie histórica de una variable. | `HistoricoRespuesta` |
| `GET /mapa/sensores` | Ubicación y resumen de cada sensor. | `{ sensores: SensorMapa[] }` |
| `GET /alertas` | Alertas filtradas, total y límite. | `{ total, limit, alertas: Alerta[] }` |
| `GET /health` | Disponibilidad de API/DB según política operativa. | Estado simple sin información sensible. |

### 7.3 Parámetros y reglas del contrato

- `GET /sensores/:deviceId/historico`: requeridos `variable`, `desde`, `hasta`; opcional `limit` (el mock usa 500). Variables: `humedad`, `temperatura`, `conductividad`, `nitrogeno`, `fosforo`, `potasio`.
- Los puntos históricos tienen forma `{ timestamp, valor }`; `valor` puede ser `null`. La respuesta incluye `unidad` y `truncado`.
- `GET /alertas`: filtros opcionales `area_id`, `tipo`, `estado`, `severidad`, `desde`, `hasta`, `limit`. El mock fija `limit` por defecto 50 y máximo 200.
- Estados de sensor: `conectado | desconectado`. Tipos de alerta: `tecnica | agronomica`; severidad: `alta | media | baja`; estado de alerta: `activa | resuelta`.
- Una medida tiene forma `{ valor: number | null, unidad: string }`.
- Timestamps de salida en UTC ISO 8601; ubicación `{ lat, lon } | null`.
- Área o sensor inexistente/fuera de entidad: `404`. Entrada inválida: `400` cuando sea detectada por las comprobaciones implementadas. No autenticado: `401`.

### 7.4 Errores

Formato recomendado, a confirmar con el frontend:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "La solicitud contiene parámetros inválidos",
    "details": []
  }
}
```

El mensaje es seguro para mostrar; `details` puede identificar campos inválidos sin revelar datos sensibles. El backend no debe devolver stack traces en producción.

## 8. Esquema actual de MongoDB

El esquema objetivo propuesto para completar este inventario está en [SCHEMA_PROPUESTA.md](SCHEMA_PROPUESTA.md). Allí se detallan los campos mínimos para login Google, aislamiento por entidad, endpoints y una eventual colección Time Series.

El equipo compartió el siguiente inventario de colecciones y campos. Se considera la referencia física disponible para esta especificación; no se infieren campos que no aparecen en el schema.

| Colección | Campos disponibles según el schema |
|---|---|
| `clientes` | `_id: string` |
| `dispositivos` | `_id: string` |
| `lotes` | `_id: string` |
| `usuarios` | `_id: string` |
| `mediciones` | `_id: ObjectId`, `device_id: string`, `location: { lat: double, lon: double }`, `nutrients: { nitrogen: double, phosphorus: double, potassium: double }`, `soil: { conductivity: double, humidity: double, temperature: double }`, `timestamp: string` |

**Aclaración de dominio confirmada por el equipo:** cada documento de datos se vincula con su entidad mediante `entityId`; en la colección raíz `clientes`, `_id` identifica la entidad. El schema inicial enviado no mostraba `entityId` en todos los inventarios. El esquema objetivo completo está en [SCHEMA_PROPUESTA.md](SCHEMA_PROPUESTA.md); resta estandarizar el tipo BSON y la forma en que la colección física `lotes` representa `campos`.

Representación equivalente del documento de medición:

```json
{
  "_id": "ObjectId",
  "device_id": "string",
  "location": { "lat": "double", "lon": "double" },
  "nutrients": {
    "nitrogen": "double",
    "phosphorus": "double",
    "potassium": "double"
  },
  "soil": {
    "conductivity": "double",
    "humidity": "double",
    "temperature": "double"
  },
  "timestamp": "string"
}
```

### 8.1 Correspondencia con el contrato del frontend

- `device_id` permite relacionar una medición con un dispositivo, sujeto a confirmar si `dispositivos._id` siempre coincide exactamente.
- `entityId` es el criterio de aislamiento: el backend lo deriva de la identidad autenticada y no lo acepta del frontend para elegir el tenant.
- `soil.humidity`, `soil.temperature` y `soil.conductivity` corresponden a humedad, temperatura y conductividad del frontend.
- `nutrients.nitrogen`, `nutrients.phosphorus` y `nutrients.potassium` corresponden a nitrógeno, fósforo y potasio.
- `location` puede alimentar la ubicación del sensor, pero el schema actual la guarda en cada medición. No define la ubicación vigente en `dispositivos` ni permite concluir cómo manejar dispositivos sin mediciones.
- El schema listado no incluye nombres visibles, relación de dispositivo con cliente/lote, cuentas y credenciales completas de usuario, ni una colección de alertas.
- El contrato de frontend también usa `area_id` y `area_nombre`. Aún no está establecido si un `lote` equivale a un `área`, ni qué documento relaciona lote, dispositivo y cliente.

Por lo tanto, los endpoints de históricos se pueden diseñar a partir de `mediciones`, pero varias vistas necesitan enriquecer esos documentos con datos de `dispositivos`, `lotes`, `clientes` y `usuarios`. El endpoint de alertas requiere definir y persistir alertas o calcularlas a partir de reglas de dominio; el schema actual no alcanza para implementarlo tal como lo consume el frontend.

### 8.2 Consideraciones de tipos y colección Time Series

El `timestamp` del schema actual está declarado como `string`; la propuesta Time Series usa BSON Date, `timestamp` como `timeField` y `contexto` como `metaField`. Antes de crear o migrar la colección, convertir/normalizar fechas y confirmar frecuencia, granularidad y retención. Ver [SCHEMA_PROPUESTA.md](SCHEMA_PROPUESTA.md).

Al estar las magnitudes tipadas como `double`, falta definir cómo se representan mediciones inexistentes o parciales: ausencia de campo, `null` u otro mecanismo. El backend debe mapear la ausencia a `null` para el contrato de UI, sin convertirla en cero. Confirmar asimismo si cada documento tiene todas las seis magnitudes y las unidades correspondientes.

### 8.3 Modelo lógico que falta documentar

Se necesitan ejemplos reales o acordados de documentos completos para resolver estos datos faltantes:

- **`usuarios`:** identificador de Google (`sub`), email, nombre, estado y relación con una entidad/cliente. El schema informado solo muestra `_id`; confirmar si se permite autoaprovisionar cuentas o si deben habilitarse previamente.
- **`clientes`:** nombre y demás metadatos necesarios para mostrar/autorizar. El schema informado solo muestra `_id`.
- **`dispositivos`:** nombre visible, relación con cliente y lote, ubicación vigente, configuración y fecha de última comunicación. El schema informado solo muestra `_id`.
- **`lotes`:** nombre, cliente propietario y relación con dispositivos; confirmar si representa las áreas del frontend.
- **`alertas`:** fuente, campos, reglas de generación, severidad, estado y ciclo de resolución. No aparece entre las colecciones listadas.
- **`mediciones`:** tipo/estándar del timestamp, unidades, frecuencia, lecturas parciales y claves de metadatos para consultas.

Definir índices únicos y compuestos luego de acordar cardinalidades y consultas. No asumir que `_id` de `clientes`, `dispositivos`, `lotes` y `usuarios` tiene el mismo tipo BSON que un ObjectId: el schema indica string.

## 9. Reglas de dominio pendientes de confirmación

1. Relación y nomenclatura entre **cliente**, **campo** y **área**. En el topic MQTT propuesto aparece cliente/campo/dispositivo; el frontend expone `area_id`.
2. Frecuencia esperada de telemetría y umbral real para conectado/desconectado. Los 30 minutos son solo valor provisional de mocks.
3. Unidades y rangos válidos de humedad, temperatura, conductividad, nitrógeno, fósforo y potasio.
4. Esquemas completos de `clientes`, `dispositivos`, `lotes` y `usuarios`, relaciones y claves foráneas lógicas.
5. Si `lotes` equivale a `areas` en la API y cómo se obtienen los nombres visibles.
6. Formato real de documentos recibidos por la ingesta Make/MongoDB y claves de correlación con sensores registrados.
7. Tipo BSON y formato actual de `mediciones.timestamp`; confirmar conversión a BSON Date para Time Series.
8. Origen de alertas técnicas y agronómicas, colección/reglas, transiciones de estado y criterio de severidad.
9. Qué significa “última medición” si la medición más reciente tiene variables faltantes.
10. Unidades y disponibilidad de cada variable por medición.
11. Orden y límite para las cinco alertas del Dashboard; el mock incluye alertas resueltas en el orden por fecha.
12. Paginación de alertas cuando `total > limit`: solo mensaje de resultados parciales está definido hoy; decidir cursor o paginación antes de necesitar navegación.
13. El middleware obtiene `entityId` del usuario autenticado y cada consulta filtra documentos por ese valor; recursos inexistentes o pertenecientes a otra entidad responden `404`.
14. Estrategia definitiva de sesión y despliegue.

## 10. Arquitectura lógica propuesta

```text
Frontend (React)
    │ HTTPS / JSON / cookie de sesión
    ▼
API Express (/api/v1)
    ├── middleware: sesión, contexto de entidad, errores, logs
    ├── servicios: agregados y reglas del dominio
    └── repositorios Mongoose
             │
             ▼
       MongoDB Atlas
        ├── entidades de acceso y catálogo
        ├── alertas
        └── mediciones (Time Series)

Ingesta IoT (separada) ──► MongoDB Atlas
```

Las rutas no contienen lógica de agregación compleja ni acceden a colecciones arbitrarias. El aislamiento por entidad debe aplicarse dentro de cada consulta del repository, no solo en la respuesta final.

## 11. Plan de tareas para Issues

Orden recomendado. Los Issues marcados **bloqueados por decisión** no deben empezar hasta cerrar sus preguntas asociadas.

| ID sugerido | Tarea | Resultado / criterios de aceptación |
|---|---|---|
| BE-01 | Cerrar decisiones de stack, sesión, hosting y reglas de dominio | Decisiones registradas en este documento; usuario asociado a una entidad; no quedan alternativas ambiguas para iniciar el scaffold. |
| BE-02 | Acordar contrato API con frontend | OpenAPI inicial cubre login, recursos, query params, nullabilidad, errores, auth, límites y fechas; cada operación tiene DTORequest/DTOResponse y frontend valida nombres y formas. |
| BE-03 | Completar y acordar modelo de persistencia con ingesta | Schemas completos de `clientes`, `dispositivos`, `lotes`, `usuarios`, `mediciones` y alertas; relaciones; ejemplos JSON; timestamp BSON Date/Time Series; unidades, índices iniciales y reglas de identidad documentados. |
| BE-04 | Crear scaffold de `be-agro` | TypeScript, Express, scripts local/build, configuración validada, estructura modular, lint/formato y `/health`; arranque reproducible desde README. |
| BE-05 | Conectar MongoDB Atlas y preparar acceso a datos | Conexión por entorno, manejo de desconexión, repositorios tipados, índices documentados y prueba de conexión sin credenciales versionadas. |
| BE-06 | Implementar login, sesión, logout y `/auth/me` | Hash de contraseña, cookie con atributos acordados, validación, respuestas de error genéricas y protección comprobada para rutas privadas. |
| BE-07 | Implementar middleware de autenticación y separación por entidad | El middleware resuelve la entidad única del usuario; cada consulta filtra por ella y pruebas comprueban que no se filtran datos de otra entidad. |
| BE-08 | Implementar catálogo de áreas/sensores | `GET /areas`, `GET /areas/:areaId`, `GET /areas/:areaId/sensores`, `GET /sensores/:deviceId`; campos y 404 coinciden con OpenAPI. |
| BE-09 | Implementar Dashboard | Resumen/áreas/alertas derivadas de datos reales y consistentes con las reglas aprobadas. |
| BE-10 | Implementar medición actual e históricos | Última lectura, filtros y rangos, límite máximo, UTC, nullabilidad, orden estable y `truncado`. |
| BE-11 | Implementar mapa | Sensores autorizados con coordenadas y resumen; valores nulos/inválidos tratados según contrato. |
| BE-12 | Implementar alertas | Filtros combinables, orden acordado, total y límite, paginación/cursor si se aprobó. |
| BE-13 | Endurecer API y observabilidad | CORS, cookies/CSRF, rate limit, Helmet u opción equivalente, logs sin secretos, error handler uniforme y límites HTTP. |
| BE-14 | Completar pruebas y documentación | Unitarias, integración HTTP/DB, casos positivos/negativos/borde y OpenAPI/README actualizados. |
| BE-15 | Despliegue de prueba e integración con frontend | URL HTTPS operativa, variables configuradas, frontend con mocks desactivados en entorno de prueba, recorrido Login→Dashboard→Área→Sensor→Histórico/Mapa/Alertas validado. |

## 12. Definition of Done para Issues de backend

- Cumple criterios de aceptación y contrato documentado.
- DTORequest/DTOResponse TypeScript definidos para cada operación y alineados con OpenAPI.
- Middleware de autenticación y aislamiento por entidad aplicado a todas las rutas protegidas.
- Casos positivos, negativos y borde relevantes cubiertos por pruebas.
- No se versionan secretos; `.env.example` contiene solo nombres/valores no sensibles.
- Errores y logs no filtran credenciales, tokens ni stack traces.
- OpenAPI y README actualizados cuando cambia configuración o contrato.
- PR revisado y sin errores bloqueantes conocidos.

## 13. Variables de entorno previstas

```dotenv
NODE_ENV=development
PORT=3000
MONGODB_URI=
FRONTEND_ORIGIN=http://localhost:5173
JWT_SECRET=
JWT_EXPIRES_IN=
COOKIE_NAME=
COOKIE_SECURE=false
COOKIE_SAME_SITE=lax
```

Revisar la lista al decidir si se usa JWT en cookie, refresh token, sesiones almacenadas o configuración propia del hosting. Ningún valor real debe escribirse aquí ni en `.env.example`.

## 14. Decisiones para la próxima revisión del equipo

Para pasar de borrador a backlog implementable, confirmar en este orden:

1. ¿El stack queda aprobado como Node + Express + TypeScript + Mongoose?
2. ¿La API de esta etapa será solo lectura además del login/logout?
3. ¿Cómo se incorpora la relación usuario-entidad en `usuarios` y en los recursos existentes?
4. ¿El esquema de documentos de MongoDB ya existe y quién mantiene el contrato con Make/ingesta?
5. ¿Se mantiene cookie httpOnly para la sesión propia después de autenticar con Google? ¿Qué dominios/orígenes tendrán frontend y API?
6. ¿Qué hosting se elige y qué plan/limitaciones se aceptan?
7. ¿Cuáles son frecuencia, umbral de desconexión, unidades y reglas de alertas?

Una vez respondidas, registrar las decisiones aquí y convertir BE-01 a BE-03 en Issues del proyecto.
