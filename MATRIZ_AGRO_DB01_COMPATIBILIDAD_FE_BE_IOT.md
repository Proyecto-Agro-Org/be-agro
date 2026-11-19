# AGRO-DB-01 — Compatibilidad FE/BE/IoT y ejemplos

FE dev6d6c545 y localdaa72a8 comparten por SHA todos los tipos/API/MSW aquí analizados.
BE devec56d26 conserva sus contratos HTTP. IoT maine6ffda0 no tiene contrato empresarial.
Las formas de frontend son evidencia de consumo, no aprobación de endpoints productivos nuevos.

## Diferencias concretas

| Tema | FE real / BE | IoT real | Acción / dueño |
| --- | --- | --- | --- |
| Cliente | cliente_id de usuario/campo; BE clientId confiable de sesión | clientid es identificador técnico elegido desde múltiples aliases/payload/query | Mapping explícito y namespaces; nunca equivalencia por texto. BE/Datos/IoT |
| Sensor | FE Sensor usa device_id lógico y area_id | `_id` Mongo técnico y clientid; device_id solo si emisor lo incluye | Sensor lógico separado + asociación. Mantener nombres públicos hasta aprobación FE/BE |
| Campo/área | Jerarquía por IDs; mocks campo_norte/sur/este/oeste son áreas | Ninguna relación empresarial obligatoria | No inferir por prefijo, nombre, email ni payload. Datos/BE |
| Medición | Seis Medida {valor:number|null,unidad:string}, timestamp ISO | Body arbitrario; readings/payload pueden ser objeto/string; no seis variables obligatorias | Mapper de formato aprobado futuro; DB01 solo metadata, no inferir unidades |
| Humedad | UI variable humedad | Puede representar humedad ambiental, suelo, estimación u otro dato | BE-04/IoT/Agronomía antes de equivalencias VWC; no normalizar por nombre |
| NPK/pH | FE espera N/P/K entre sus seis variables | S8 no los demuestra como medición directa; cuerpo puede llevar cualquier clave | No fabricar datos; null con unidad contractual si no hay fuente aprobada |
| Fecha | FE usa strings/Date.parse; BE-03 precisión adicional pendiente | _receivedAt Date de servicio; timestamp del emisor libre | Recepción para índices/metadata, adquisición separada. No convertir datos reales ni dar autoridad a fecha del payload |
| Recepción/historia | FE histórico por sensor/variable y campo_id | Ingesta no requiere identidad de dispositivo en mediciones; no dedupe | Inventario/formato e identidad/source antes de lectura real |
| Estado | FE conectado/desconectado y última comunicación nullable; mock umbral30min | Mezcla eventos y connectivity previos, _lastSeen recepción | Política técnica por aprobar, no usar estado global después de transferir cliente |
| Errores | FE parser actual usa error como string; BE-03 exige code/message | IoT {ok:false,error,received} y driver.message sin sanitizar | FE F03 pendiente; no enviar respuesta IoT al FE como error BE |
| Auth | FE Bearer demo/password; BE Google/session infra deshabilitada | Webhook público sin auth | Tres contextos distintos. No conectar FE directamente a ingesta ni tratar payload como sesión |
| Almacenamiento Bearer | F01 401 tardío y F02 storage fallido continúan en código FE | No aplica al webhook | Corregir en su tarea/repositorio con autorización; FE read-only aquí |
| Logout | FE solo local; F04 parse JSON ante204 | Sin logout ni sesión comercial | Contrato BE-09.4 y FE pendiente; DB01 no cambia rutas |
| Catálogos | Campos solo /auth/demo/campos en MSW | /debug enumera colecciones, no campos autorizados | /debug no es catálogo de negocio; BE-10 no se inicia |

## Operaciones realmente consumidas

Prefijo de apiFetch: VITE_API_BASE_URL o /api/v1. Accept JSON y Bearer cuando corresponde;
no cookies credentials. Paths codifican IDs mediante encodeURIComponent en detalles.

| Operación FE | Entrada | DTO / vacío / relación |
| --- | --- | --- |
| POST /auth/login | email/password; sinSesion | LoginRespuesta, token obligatorio, usuario/cliente opcionales; mock200/401 |
| POST /auth/google-demo | sin body, solo mocks | LoginRespuesta demo; no Google real |
| POST /auth/demo/sesion | token body, solo mocks | IdentidadSesion completa |
| GET /auth/demo/campos | Bearer demo, sin cliente en query | {campos:Campo[]}; [] válido, valida cliente e IDs sin duplicados |
| GET /dashboard/resumen | campo_id | DashboardRespuesta; conteos0, listas[] y ultima_actualizacion:null válidos |
| GET /areas | campo_id | AreasRespuesta; AreaApi.campo_id opcional en DTO aunque dominio lo requiere |
| GET /areas/:areaId | campo_id | AreaDetalle; inexistente/ajena404 |
| GET /areas/:areaId/sensores | campo_id | SensoresDeAreaRespuesta; relación dada por ruta, no area_id por fila |
| GET /sensores/:deviceId | campo_id | SensorDetalle, ultima_medicion:null si nunca midió |
| GET /sensores/:deviceId/historico | campo_id, variable, desde, hasta, limit1000 | HistoricoRespuesta; puntos[], valor nullable, truncado boolean |
| GET /mapa/sensores | campo_id | MapaRespuesta; ubicación null no elimina sensor |
| GET /alertas | campo_id; area_id/tipo/estado/severidad/desde/hasta/limit opcionales | AlertasRespuesta; total/limit/alertas[] |

Son nueve operaciones de negocio observadas (dashboard, áreas, detalle, sensores de área,
sensor, histórico, mapa, alertas y login), más rutas exclusivas de mocks. BE default publica
health, no esas rutas. La factory auth aislada tiene cuatro rutas propuestas de BE-09.4;
no confundirla con password/demo activo ni con contratos BE-03 ya aceptados por todos.

## Ejemplos JSON fieles a los tipos consumidos

**Colección de ejemplos independientes**, no una respuesta HTTP conjunta. Cada entrada representa
un DTO de una operación distinta. Datos sintéticos, no muestras MongoDB ni token utilizable.
Unidades tomadas del mock para representar su forma; no certifican unidad/calibración IoT real.
Sintaxis JSON y las diez asignaciones TypeScript comprobadas contra los tipos FE, sin errores
y sin modificar ese repositorio. No equivale a validación runtime ni prueba de una API desplegada.

```json
{
  "campos": {"campos":[{"campo_id":"field-a","nombre":"Campo sintético","cliente_id":"client-a"}]},
  "areas": {"areas":[{"area_id":"area-a","campo_id":"field-a","nombre":"Área sintética","sensores":1,"conectados":1,"desconectados":0,"alertas_activas":0,"ultima_actualizacion":null}]},
  "area": {"area_id":"area-a","campo_id":"field-a","nombre":"Área sintética"},
  "sensores": {"sensores":[{"device_id":"logical-sensor-a","nombre":"Estación sintética","estado":"conectado","ultima_comunicacion":null,"ubicacion":null,"alertas_activas":0}]},
  "sensor": {"device_id":"logical-sensor-a","nombre":"Estación sintética","area_id":"area-a","area_nombre":"Área sintética","estado":"conectado","ultima_comunicacion":"2030-01-01T00:00:00.000Z","ubicacion":null,"ultima_medicion":{"timestamp":"2030-01-01T00:00:00.000Z","humedad":{"valor":null,"unidad":"%"},"temperatura":{"valor":0,"unidad":"°C"},"conductividad":{"valor":null,"unidad":"dS/m"},"nitrogeno":{"valor":null,"unidad":"mg/kg"},"fosforo":{"valor":null,"unidad":"mg/kg"},"potasio":{"valor":null,"unidad":"mg/kg"}}},
  "historico": {"device_id":"logical-sensor-a","nombre":"Estación sintética","area_id":"area-a","area_nombre":"Área sintética","variable":"temperatura","unidad":"°C","puntos":[{"timestamp":"2030-01-01T00:00:00.000Z","valor":0},{"timestamp":"2030-01-01T00:01:00.000Z","valor":null}],"truncado":false},
  "mapa": {"sensores":[{"device_id":"logical-sensor-a","nombre":"Estación sintética","area_id":"area-a","area_nombre":"Área sintética","estado":"desconectado","ubicacion":null,"ultima_comunicacion":null,"ultima_medicion":null}]},
  "alertas": {"total":0,"limit":50,"alertas":[]},
  "dashboard": {"resumen":{"areas":1,"sensores":1,"conectados":1,"desconectados":0,"alertas_activas":0},"areas":[{"area_id":"area-a","campo_id":"field-a","nombre":"Área sintética","sensores":1,"conectados":1,"desconectados":0,"alertas_activas":0}],"ultimas_alertas":[],"ultima_actualizacion":null},
  "login": {"token":"synthetic-not-a-session","usuario":{"usuario_id":"user-a","nombre":"Persona sintética","email":"synthetic@example.invalid","cliente_id":"client-a"},"cliente":{"cliente_id":"client-a","nombre":"Cliente sintético"}}
}
```

No completar ausencia con0: el0 del ejemplo es una lectura sintética válida; null es ausencia.
No fabricar nitrógeno/fósforo/potasio ni convertir payload IoT a estas seis medidas en DB01.
FE histórico usa unidades y serie generada en MSW; no evidencia disponibilidad de mediciones reales.

## Decisiones adoptadas, puntos no comprobados y cambios por repositorio

Adoptado: conservar nombres públicos; distinguir Sensor lógico/device_id FE de dispositivo técnico;
identidad y recepción explícitas, sin coerciones; errores/relaciones no salen directamente de raw IoT.
No comprobado: formatos reales, unidades, BSON/índices, broker, hardware y configuración FE desplegada.
FE main añade Analytics y rewrite SPA mientras dev no tiene ese vercel.json; ninguna configuración
observada demuestra proxy real a be-agro. No se ejecutó build/test FE ni se tocó su hosting.
Cambios: BE agrega planes/mappers/tests; FE debe resolver F01–F04/contratos/alias; IoT debe autenticar
y versionar procedencia. Responsables coordinan esos cambios antes de integrar datos reales.
