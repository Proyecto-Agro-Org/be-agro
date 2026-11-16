# Especificación del backend be-agro

**Proyecto:** UADE A26T02 — Red IoT de Sensores de Suelo
**Actualización:** 16/11/2026 · BE-00/BE-01, entrega documental local pendiente de PR.
**Fuente rectora:** Plan de Trabajo Backend A26T02 del 05/11/2026, §§3–8.

## 1. Alcance y precedencia

API de consulta y autenticación entre frontend y MongoDB Atlas. El flujo de adquisición permanece separado: ESP32 → MQTT/EMQX → acción HTTP → iot-ingest → Atlas → be-agro → frontend.

Precedencia: acuerdos confirmados del plan del 05/11 → código y contratos implementados → especificaciones técnicas recientes → propuestas históricas. El plan define el objetivo; el código determina qué existe hoy. La presente actualización no implementa endpoints, schemas, paquetes ni migraciones.

Fuera del MVP: consumo MQTT desde be-agro, reemplazo de ingesta, CRUD administrativo público, comandos a hardware, entrenamiento IA y procesamiento continuo no aprobado. Worker/WebSocket son opciones futuras.

## 2. Estado actual comprobado

Referencia local: commit `9cab86f35facf0ae49795e9ccf301cfc3c147094`.

| Componente | Estado comprobado |
|---|---|
| Runtime | Node 24.x en engines; entorno de auditoría v24.19.0, npm 11.17.0 |
| HTTP | Express ESM en JavaScript; package declara ^5.1.0, lock/instalación resuelven 5.3.0 |
| Dependencias | cors ^2.8.6 (instalado 2.8.6); ninguna devDependency |
| Ruta | Solo GET /health → 200, {"status":"ok"}, público, salud del proceso |
| CORS | CORS_ORIGINS, coincidencia exacta; admite sin Origin y wildcard; rechaza con 403 |
| Errores | Handler básico con error string; 404 por defecto de Express, sin envoltorio uniforme |
| Servidor | scripts/start.js; PORT por defecto 3000; sin parser JSON explícito |
| Hosting | vercel.json: framework express, fluid true; configuración presente, operación publicada no comprobada en esta auditoría |
| Pruebas | node:test + assert + fetch HTTP local: cinco pruebas aprobadas |
| Ausente | TypeScript, Zod, Mongoose, conexión Mongo, autenticación, aislamiento, negocio, DTOs, OpenAPI, logging con request ID, lint/build |

No existe `/api/v1/health` ni ninguna ruta de negocio implementada. Las secciones siguientes son requisitos/contratos de referencia para trabajo posterior.

## 3. Decisiones confirmadas

- Capas Route → Controller → Service → Repository → Model, con middlewares, DTOs y adapters por responsabilidad.
- Node/Express; migración a TypeScript; Zod para validación runtime de entradas y entorno; DTORequest/DTOResponse por operación; Mongoose previsto para Atlas; Vitest/Supertest previstos.
- Colecciones MongoDB convencionales, **no Time Series**. Históricos conservados e índices por cliente, dispositivo y tiempo.
- Cliente → Campo → Área → Dispositivo → Mediciones; usuario asociado a un cliente. Campo y Área son niveles diferentes.
- Cliente autorizado derivado de identidad confiable; todas las consultas y agregaciones limitadas en repository. No implementar roles por endpoint en esta etapa.
- Nombres/unidades y normalización hacia API centralizados en backend; ausencia → null, nunca cero.
- Alerta visual por falta de mediciones a cargo del frontend. Persistencia de alertas, worker y WebSocket requieren definición adicional.

## 4. Autenticación y aislamiento

El requisito previo de login Google se conserva como objetivo de integración, sin dar por aprobado un flujo OAuth concreto. El plan exige verificar el funcionamiento existente.

Frontend auditado en commit `f30c76dbd7f2f87aa5ef02e0be176f2e112fbb96`:

- `src/api/client.ts` envía Authorization: Bearer desde sessionStorage; no configura credentials para cookies.
- `LoginPedido` usa email/password; `LoginRespuesta` exige token y hace opcionales usuario/cliente.
- `/auth/google-demo`, `/auth/demo/sesion` y `/auth/demo/campos` son exclusivos MSW. Google real está deshabilitado sin mocks.
- AuthProvider recupera identidad al recargar solo en modo mock; logout limpia estado local sin llamar al servidor. Un 401 privado invalida sesión.
- CampoProvider y consulta de campos están habilitados solo con mocks. El selector usa IDs y una preferencia local contrastada contra el catálogo.
- El mock actual limita datos al cliente del token y valida campo/área/sensor; esto no constituye una frontera de seguridad real.

Pendientes: ID token Google versus OAuth callback; cuentas habilitadas y alta/asignación de cliente; Bearer versus cookie httpOnly; expiración/renovación/revocación; recuperación real de identidad, logout y CSRF/CORS según decisión. No se introduce bcrypt como requisito de un login Google.

La API deberá obtener cliente desde sesión/usuario verificado, validar Campo → Área → Dispositivo y limitar mediciones usando relaciones persistidas. `campo_id` selecciona dentro del cliente autorizado, nunca autoriza un tenant. No confiar en `cliente_id` ni `entityId` enviados por navegador o telemetría sin verificación. Recurso ajeno/inexistente: 404; sin sesión: 401.

## 5. Contratos frontend observados, aún no implementados en be-agro

Base: VITE_API_BASE_URL, por defecto `/api/v1`. Referencia primaria: `src/api/*`, `src/types/*` y `src/mocks/handlers/*` del commit frontend indicado. Mantener rutas públicas actuales; las rutas `/dispositivos` sugeridas por el plan no sustituyen silenciosamente a `/sensores`.

| Método y ruta relativa | Entradas/alcance observado | Respuesta de referencia |
|---|---|---|
| POST /auth/login | email, password; sin Bearer | token; usuario y cliente opcionales en tipo real |
| POST /auth/google-demo | Solo MSW | LoginRespuesta demo |
| POST /auth/demo/sesion | Solo MSW, body token | usuario y cliente completos |
| GET /auth/demo/campos | Solo MSW, cliente desde Bearer | { campos: Campo[] } |
| GET /dashboard/resumen | campo_id | { resumen, areas, ultimas_alertas, ultima_actualizacion } |
| GET /areas | campo_id | { areas: AreaResumen[] } |
| GET /areas/:areaId | campo_id | { area_id, nombre, campo_id? } |
| GET /areas/:areaId/sensores | campo_id | { sensores: SensorDeArea[] } |
| GET /sensores/:deviceId | campo_id | SensorDetalle |
| GET /sensores/:deviceId/historico | campo_id, variable, desde, hasta, limit | HistoricoRespuesta |
| GET /mapa/sensores | campo_id | { sensores: SensorMapa[] } |
| GET /alertas | campo_id; opcionales area_id, tipo, estado, severidad, desde, hasta, limit | { total, limit, alertas } |

Los mocks requieren exactamente un `campo_id` no vacío; sin identidad responden 401, campo ajeno o recurso fuera de ese campo 404. Debe acordarse el endpoint real de campos (el plan propone GET /campos), recuperación de identidad y logout en BE-03. No copiar endpoints demo a producción.

### Formas y reglas observadas

- Cliente: `{cliente_id,nombre}`; Usuario: `{usuario_id,nombre,email,cliente_id}`; Campo: `{campo_id,nombre,cliente_id}`; Área: `{area_id,nombre,campo_id}`; Sensor: `{device_id,nombre,area_id}`. Área API mantiene campo_id opcional temporalmente.
- AreaResumen añade sensores, conectados, desconectados, alertas_activas, ultima_actualizacion nullable. Dashboard resumen tiene esos cinco conteos (areas en lugar de identidad de área).
- SensorDeArea: device_id, nombre, estado, ultima_comunicacion, ubicacion, alertas_activas. El área se expresa mediante la ruta.
- SensorDetalle: identidad del sensor + area_nombre, estado, ultima_comunicacion, ubicacion, ultima_medicion. Última medición: timestamp y seis variables `{valor:number|null, unidad:string}`, o null si no hubo lecturas.
- Histórico: device_id, nombre, area_id, area_nombre, variable, unidad, puntos `{timestamp,valor:number|null}[]`, truncado. El cliente envía limit=1000; el handler usa 500 si se omite. Límite máximo y política de truncamiento deben cerrarse en BE-03.
- Mapa: identidad + area_nombre, estado, ubicacion, ultima_comunicacion, ultima_medicion nullable con timestamp, humedad y temperatura. Ubicación `{lat,lon}|null`; conservar dispositivos sin coordenadas.
- Alerta: alerta_id, device_id, sensor_nombre, area_id, area_nombre, tipo, severidad, descripcion, timestamp, estado. Tipos tecnica/agronomica; severidad alta/media/baja; estado activa/resuelta.
- Alertas: default limit 50, máximo 200 en mock; total antes del límite; orden por severidad alta→media→baja y fecha descendente. Dashboard usa las cinco más recientes por fecha e incluye resueltas.
- Variables de UI: humedad, temperatura, conductividad, nitrogeno, fosforo, potasio. Unidades demo: %, °C, dS/m, mg/kg. No certifican la unidad física de cada documento.
- Fechas de respuesta objetivo: ISO 8601 UTC; históricos con zona horaria, desde < hasta, límites y orden estable. La validación de UI/MSW no reemplaza Zod del backend.

### Errores y transición

Objetivo aprobado local: `{"error":{"code":"...","message":"..."}}`. Códigos estables como VALIDATION_ERROR, UNAUTHENTICATED, RESOURCE_NOT_FOUND e INTERNAL_ERROR; status 400/401/404/409/429/500 según semántica. El 403 actual de CORS se conserva como comportamiento existente y deberá documentarse al migrar errores.

Frontend/MSW actuales consumen `{error:string}`; `leerMensajeError` no interpreta el objeto objetivo. Registrar y acordar adaptación en BE-03 antes de integrar; este cambio documental no modifica cliente ni handler. 404 uniforme, propagación asíncrona y logs seguros son trabajo futuro.

## 6. Persistencia e incompatibilidades de ingesta

Fuente inspeccionada: iot-ingest commit `e6ffda0f0a4b9a18298c239ac34cc61de6b1c3fa`, README y modules/measurements, modules/devices, config/env.ts.

| Aspecto | Evidencia de código, no inspección Atlas |
|---|---|
| Base/colecciones | Defaults iot_sensores, mediciones, dispositivos, configurables por entorno |
| Mediciones | POST /ingest acepta objeto JSON no vacío, elimina _id entrante, agrega _receivedAt BSON Date e inserta nuevo documento |
| Sobre MQTT | Si EMQX manda sobre, payload puede permanecer string; no se garantiza desanidado de telemetría |
| Dispositivos | Upsert por clientid string, índice único clientid; _createdAt y _lastSeen BSON Date |
| Merge de estado | Reemplazo de campos superiores recibidos, conservación de omitidos; un subobjeto recibido reemplaza al anterior |
| Identificador | Acepta variantes de ID y números a string; clientid identifica dispositivo MQTT, no cliente del dominio |
| Tenant/relaciones | No garantiza entityId/cliente_id, campo, área ni catálogo de usuarios |
| Magnitudes | No garantiza soil/nutrients, readings ni measurements; unidades y timestamp de origen libres |
| Históricos | Inserciones sin deduplicación de mediciones demostrada; no se modifica ingesta en esta etapa |

El inventario histórico del repositorio enumera clientes, lotes, usuarios y dispositivos con _id string, y mediciones con device_id, location, soil, nutrients y timestamp string. Se conserva como información documental no verificada, no como esquema físico vigente. El código de ingesta genera _id Mongo y usa clientid en dispositivos: no asumir igualdad con device_id ni con el _id string del inventario anterior.

No se accedió a Atlas, configuración EMQX o payload capturado del hardware. BE-02 debe resolver nombres/tipos BSON y relaciones reales; BE-04 distingue adquisición de recepción y formato temporal. Ver [propuesta de schema](SCHEMA_PROPUESTA.md).

## 7. Mediciones, procedencia y reglas científicas

Fuentes locales: especificación técnica del 30/10/2026 §§5,10,12–13; Anexo Fórmulas S8 §§1,5–8; datasheet SOIL-MB-THC-S Rev.04 pp.2,15–17; informe agronómico pp.4–9.

| Clase | Tratamiento |
|---|---|
| Medido directamente | S8 temperatura, conductividad y humedad reportada; conservar unidad/origen bruto |
| Estimado por dispositivo | Salinidad/TDS entregados por sonda; no presentarlos como ensayos independientes |
| Calculado/derivado | Conversión CE y fórmulas con entradas válidas; registrar método/versión/referencias |
| Laboratorio/campo | Nitrato/P/K/pH y caracterización externa con método, profundidad, fecha y vigencia |
| Ausente | null en HTTP, sin cero ni sustitución por datos demo; causa/procedencia a diseñar |

S8 no mide NPK ni pH; tampoco permite reconstruirlos a partir de CE/temperatura/humedad. `nitrogeno` genérico no equivale automáticamente a NO₃⁻/NO₃-N. Humedad %RH reportada no se homologa a % volumétrico sin calibración. Conversión de referencia: 1200 µS/cm = 1,2 dS/m; no aplicar esa conversión a valores cuya unidad de origen se desconoce.

Porosidad requiere densidades válidas; aire requiere humedad volumétrica calibrada de igual profundidad. No usar constantes de laboratorio ni umbrales agronómicos como universales. La normalización de respuesta será responsabilidad del backend, preservando históricos brutos y distinguiendo simulados/reales. No implementar fórmulas en BE-01.

## 8. Requisitos futuros verificables

- Controllers delgados, services sin Express, repositories con filtros de cliente dentro de Mongo; modelos separados de DTOs y adapters para Google/proveedores.
- DTORequest y DTOResponse tipados por operación; sin entrada documentar que no aplica. Zod valida realmente params/query/body/env; interfaces TS por sí solas no validan HTTP.
- Conexión Atlas segura administrada, colecciones convencionales y consultas con límites/índices por cliente/dispositivo/tiempo.
- CORS de orígenes explícitos; cookies/credentials/CSRF solo según sesión aprobada; protección de login, request ID y logs sin secretos.
- Errores seguros uniformes, 404 común, ninguna falla inesperada convertida a 200.
- Pruebas Vitest/Supertest de services, mappers, validación, sesión, aislamiento, errores y repositories en base aislada; preservar regresión de health/CORS.
- OpenAPI y documentación alineados con frontend. No existe todavía archivo OpenAPI en este checkout.

## 9. Decisiones pendientes y continuidad

BE-02: relevamiento físico sanitizado, IDs BSON, relación clientid/device_id/_id, catálogo confiable y significado de lotes; estrategia histórica sin pérdida y filtros de cliente aun para documentos antiguos.

BE-03: congelar DTOs/OpenAPI, campos reales, auth Google/sesión, endpoint de campos/identidad/logout, errores y límites con frontend; no renombrar rutas por propuesta.

BE-04: nombres/unidades/precisión, timestamps adquisición/recepción y fechas inválidas, lecturas parciales y última lectura por documento versus por variable, procedencia, calibración, frecuencia/umbral y ubicación vigente.

Alertas: aprobar origen y ciclo de vida para las que entregue API; no exigir colección propia ni detector continuo por la alerta visual de ausencia.

Flujo Git: solo main comprobada local y remota; acordar develop/dev antes de usarla como base. La auditoría no crea ramas/Issues ni marca tareas integradas.

## 10. Historial de decisiones

Los borradores del 30/10 y 02/11/2026 proponían Time Series, campo→dispositivo sin Área, cookie JWT y alternativas Render/Railway; trataban runtime validation como fuera de alcance. Quedan sustituidos por el acuerdo del 05/11. Se conserva el inventario histórico, los contratos de consulta y pendientes útiles, sin convertir propuestas en hechos.

La numeración BE-01…BE-15 del antiguo §11 era sugerida y difería del plan del 05/11. Rige el backlog de [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md); versiones anteriores completas disponibles en Git, commit base 9cab86f. Ver [informe de auditoría](INFORME_BE00_BE01.md) para evidencias y limitaciones.
