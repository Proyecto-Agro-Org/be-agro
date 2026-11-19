# AGRO-DB-01 — Riesgos concretos de iot-ingest

Auditoría de código fijada en `e6ffda0f0a4b9a18298c239ac34cc61de6b1c3fa`.
No se hicieron peticiones al servicio desplegado, EMQX o MongoDB. Las reproducciones son
offline sobre copias de DTO/controllers/services, repositories inyectados y getDb bloqueado.
No se modificó iot-ingest. Los riesgos describen código/condiciones de explotación, no incidentes observados.

## Hallazgos y recomendaciones al responsable IoT

| ID / severidad | Evidencia específica | Consecuencia / recomendación |
| --- | --- | --- |
| IOT-01 / Alta | src/app.ts y routes.ts no registran auth; controllers aceptan POST /ingest y /iot-device-status; README confirma PoC sin autenticación | Escritura/suplantación y contaminación de datos si la URL es accesible. Autenticar webhook, restringir origen, firma/HMAC o mecanismo aprobado con replay protection; broker debe verificar publicadores y permisos por dispositivo |
| IOT-02 / Alta | device.dto.ts toma primer alias encontrado, también query.clientid; convierte números a string y trim; service envía resto del cuerpo libre | Un emisor puede elegir clave técnica, introducir aliases contradictorios y sobrescribir metadatos de negocio. Resolver un identificador autenticado de broker, rechazar conflictos, separar campos técnicos permitidos y prohibir campos de propiedad comercial |
| IOT-03 / Alta | device.repository.ts crea índice único en runtime; catch registra y devuelve sin rethrow, luego updateOne upsert continúa | Si falla DDL/índice por duplicados/permisos, no hay garantía de unicidad. Provisionar índice fuera del runtime con operador, verificarlo al iniciar y fallar cerrado; manejar11000/reintento acotado según contrato, no afirmar garantía por una promesa local |
| IOT-04 / Alta, condicionada a usar datos como autoridad | mediciones acepta cualquier objeto no vacío; no requiere device_id/clientid/epoch; cliente comercial/timestamps son payload libre | Imposible autorizar datos comerciales por ID enviado. No unir a Cliente por clientid/email/nombre. Backend mantiene asociación confiable y cuarentena; IoT aporta identidad y atribución verificables |
| IOT-05 / Media, potencial alta con payload sensible | request-logger.ts imprime URL, content-type y primeros1000 caracteres del JSON; error-handler imprime details/cuerpo en400 y Error completo en500 | Fuga de credenciales/PII si un emisor las envía; truncar no es redactar. Allowlist de metadata no sensible, request ID generado, sin body/query/token ni excepción cruda |
| IOT-06 / Media | /debug lista toda la base/colecciones y estimatedDocumentCount; /health y error-handler responden error.message original | Exposición de topología/diagnósticos. Eliminar/proteger debug, health mínimo y errores constantes; métricas privadas con privilegio mínimo |
| IOT-07 / Media | insertOne por mensaje, sin event key ni índice de dedupe | Retries del broker/red generan filas duplicadas. Acordar evento verificado único por source/dispositivo/boot/seq o equivalente; no índice único nuevo sobre campos ausentes de históricos |
| IOT-08 / Media | express.text type always true, límite1mb, JSON inválido→{payload:text}; measurement DTO solo chequea objeto/no vacío | Cuerpos basura, costo/logging y formatos heterogéneos. Versionar schema técnico, limitar Content-Type/tamaño/tasa, validar sin inventar magnitudes; compatibilidad de históricos separada |
| IOT-09 / Media | estado merge conserva faltantes y reemplaza objetos completos; un evento disconnected puede coexistir con connectivity.status=connected previo | Estado técnico contradictorio; no derivar salud/alertas empresariales automáticamente. Contrato de eventos, precedencia/tiempo y mappers de estado por aprobar |
| IOT-10 / Media | configuración env selecciona DB defaultiot_sensores, colecciones libres; README sugiere compartir URI para local/prod y abrir red ampliamente | Riesgo de pruebas en base real y roles excesivos. Instancias/DB/roles por entorno y servicio; sin permisos auth/DDL a ingesta, sin cambios automáticos de red. Revisar operación con su administrador |

No se demuestra ejecución de operadores MongoDB mediante el payload: el pipeline de dispositivos
usa `$literal` y el filtro clientid es string derivado del DTO. Esa protección debe conservarse.
El riesgo comprobado es aceptar/mezclar datos no confiables y claves ambiguas, no una supuesta
ejecución de `$where`. Nunca eliminar `$literal` para intentar normalizar payloads.

## Flujo exacto y campos protegidos por el servicio

EMQX HTTP→bodyParser→requestLogger→stripApiPrefix→controller→DTO→service→repository.
Aliases /api/* y barra final; raíz/health/debug GET; ingest/status POST. Sin middleware de auth.
El repo no configura ni valida el broker: la regla `${payload}` frente a `${*}` está documentada,
no se inspeccionó EMQX real. Un sobre puede dejar payload como string JSON, sin extracción de mediciones.

- MeasurementService descarta _id top-level, conserva el resto y **sobrescribe _receivedAt con Date nuevo**.
  Esto protege fecha de recepción frente al body directo, pero no la identidad ni adquisición.
- DeviceService descarta _id top-level; repository fuerza clientid canónico, _lastSeen nuevo y
  _createdAt desde documento previo o now. Los demás campos entrantes reemplazan sus homólogos.
- No hay validación de unidades, timestamp de dispositivo ni relación comercial. Un atributo
  device_id opcional no queda demostrado como hardware, ID Mongo o Sensor del frontend.
- MongoClient se abre explícitamente al primer request de DB y comparte promesa/reintenta conexión
  fallida; no hay autenticación del webhook, cuotas ni deadline global específico en ese módulo.

## Reproducciones offline realizadas

Diez controles sobre copias de código fijadas al SHA, usando Express/TypeScript instalados en BE:
aliases contradictorios eligen primero; número5 y string con espacios convergen; /ingest sin credenciales
acepta objetos sin dispositivo; mensajes duplicados invocan dos inserts; recepción del servidor
sobrescribe la enviada; campos comerciales llegan al repository de prueba; texto no JSON es aceptado;
/debug sin auth devuelve metadata del stub; logger conserva marcador sintético privado.

getDb fue sustituido por una función que siempre lanza REMOTE_IO_FORBIDDEN_OFFLINE; ningún
repository real se ejecutó. Esto no valida MongoDB ni versiones instaladas de IoT, no certifica
un deployment y no equivale a las31 E2E mencionadas por su README. Esas31 son evidencia declarada
por el autor, sin script versionado ni reejecución en esta auditoría.

## Decisiones técnicas adoptadas

Mantener la ingesta intacta en esta tarea; no usar sus campos comerciales como autoridad.
Separar namespaces/permisos y exigir identidad/atribución verificadas antes de lectura comercial.
Conservar protecciones `$literal`, metadata de recepción y distinción entre datos originales y DTOs.

## Puntos no comprobados

No se comprobaron reglas EMQX, controles externos de red, credenciales/roles efectivos,
índices/BSON presentes ni exposición efectiva de deployments. Las reproducciones prueban el
código con stubs, no escrituras reales ni explotación remota. El responsable debe verificar esos
controles antes de atribuir una mitigación externa a los hallazgos de código.

## Cambios por repositorio y orden recomendado

1. Responsable IoT/broker + Seguridad: cerrar IOT-01/02/03/05/06 antes de confiar en telemetría.
   Evitar nuevas escrituras empresariales; revisar exposición con su responsable, sin probarla en producción.
2. Datos + BE + IoT: inventario sanitizado de BSON/índices, identidad de source, recepción y formatos;
   acordar epoch/handoff y política de atraso. Sin ello, cuarentena y no lectura multicliente productiva.
3. BE: adapters de lectura con privilegio mínimo y los filtros DB01 después de aprobar el mapping.
4. FE/BE/Agronomía: contratos de unidades, fechas/estados y valores ausentes; no convertir humedad
   ambiental a VWC ni estimar NPK para satisfacer seis campos de la interfaz.

No se implementaron correcciones en iot-ingest/FE ni se activaron mitigaciones externas.
Las recomendaciones son específicas para sus responsables y no autorizan migraciones o despliegues.
