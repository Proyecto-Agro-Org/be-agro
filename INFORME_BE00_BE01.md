# Informe de auditoría BE-00 y BE-01

**Proyecto:** UADE A26T02 · be-agro
**Fecha:** 16/11/2026 (America/Buenos_Aires)
**Entrega:** auditoría y alineación documental local; pendiente de revisión e integración mediante PR.
**Límite de alcance:** BE-02 y siguientes no iniciados.

## A. Resumen ejecutivo

El backend es un esqueleto operativo de Express/JavaScript con CORS y health de proceso. Cinco pruebas existentes pasan; no hay autenticación, conexión Mongo, aislamiento multicliente ni rutas de negocio. Es una base útil para la migración prevista, no una API integrada al frontend.

BE-00 produjo inventario, contraste con diez documentos de referencia y revisión en lectura de frontend/ingesta. BE-01 consolida los acuerdos del 05/11: capas, Zod runtime, jerarquía completa, colecciones comunes, normalización en backend y ausencia visual a cargo del frontend.

Los hallazgos críticos son la falta de una identidad real verificable en backend, la ausencia de relaciones físicas de cliente/campo/área garantizadas por ingesta y la incompatibilidad entre su JSON libre y el modelo histórico fijo. También hay diferencias de errores y sesión con frontend. No corresponde implementar consultas basadas en el schema propuesto sin resolverlas.

### Fuentes y límites de la evidencia

Precedencia aplicada: decisiones confirmadas del plan del 05/11 → código/contratos implementados → especificación reciente → historia/propuestas. Fuentes locales no se publican ni se agregan a Git.

| Fuente local en documentacion-referencia | Contenido efectivamente consultado y uso |
|---|---|
| Plan_Trabajo_Backend_A26T02 (1).docx | Versión 05/11/2026, decisiones §3, arquitectura §5, flujo §6, etapas §7, backlog §8, testing/DoD §§10–13. Rector para IDs BE-00…17 y alcance. |
| Especificacion_Tecnica_UADE_A26T02_NUEVA_COPIA.docx | Versión 1.0, 30/10, propuesta sujeta a validación. S8, cinco registros, MQTT/JSON 2.2, measurements/derived, UTC/recepción, colecciones propuestas devices/observations y límites de calibración. |
| Anexo_Formulas_S8_UADE.docx | Versión 1.0, 30/10. Distingue medida/estimada/derivada/laboratorio; NPK/pH no inferibles del S8; dependencias y trazabilidad de fórmulas; CE y humedad calibrada. |
| Informe_Frontend_A26T02_Etapa_2.pdf | 10 páginas extraídas; ocho pantallas previstas, MSW, Bearer/sessionStorage, /api/v1, nulls, históricos/mapa y contratos; señala Alertas en curso en esa versión. |
| INFORME DE NECESIDADES AGRONOMICAS (1).docx | Variables y tablas: NO₃⁻/P/K, pH, CE, humedad volumétrica, temperatura y ensayos físicos/químicos; unidades, frecuencias y umbrales orientativos, no reglas universales aprobadas. |
| Etapa 1 Propuesta de estructura y funcionalidades de la aplicación web (4).pdf | 10 páginas extraídas; navegación, contratos por pantalla y criterios de vacío/error, auth Bearer, errores string, umbral de 30 min como ejemplo. |
| Proyecto A26T02 – Red IoT de Sensores de Suelo con Inteligencia Artificial para Evaluación de NPK y Variables Ambientales-4 (1).docx | Propuesta de Solución Ingeniería de Sistemas: capas separadas, payload soil/nutrients, alternativas Python/FastAPI/PostgreSQL/Influx/AWS; contexto histórico, no stack vigente. |
| SOIL-MB-THC-S-DS.pdf | 38 páginas extraídas; Rev.04 del 01/11/2024, pp.2,15–17: unidades, registros 0…4, factores/offsets y humedad declarada. Sin NPK/pH. |
| Matriz_Comparativa_Sensores_UADE_A26T02.xlsx | Tres hojas: Matriz de cobertura, Catalogo sensores, Criterios y fuentes; 14 requerimientos vs S1…S9; S8 con CE/temperatura y humedad por validar. |
| Planner_Universitario_Proyecto_IoT_A26T02 (1).xlsx | Cuatro hojas: Planner_Gantt, Matriz_Justificacion, Tareas - Alumnos, Perfil del Alumno. Investigación de tecnologías y dependencias; no aprobación de FastAPI/Influx/cloud. Valores cacheados de fechas contienen #NAME?, no se recalcularon ni corrigieron. |

Se leyeron README, ESPECIFICACION, IMPLEMENTATION_PLAN, SCHEMA_PROPUESTA, AGENTS, DEFINITION_OF_DONE, ddbb.puml y todos los archivos de aplicación/configuración/pruebas versionados. package-lock se inspeccionó para versiones y se verificó su integridad por Git; no se auditaron internals de cada paquete transitivo.

Se extrajo texto OOXML de Word y todas las hojas de Excel mediante ZIP/XML; PDF mediante pypdf del runtime disponible. El Python del PATH no pudo arrancar por acceso denegado; el runtime empaquetado permitió completar la lectura sin instalaciones. No se validaron visualmente diagramas incrustados, capturas o wireframes; el análisis se basa en texto/tablas/código, sin atribuirles contenido no leído. Los diez archivos resultaron legibles para extracción textual. Extractos auxiliares locales quedaron bajo documentacion-referencia/.auditoria-texto, también excluidos.

Referencias citadas por el plan pero no presentes: Plan_Trabajo_Web_A26T02_v2 y Propuesta_unificada_Backend_Etapa_0.pdf (03/11). El DoD general ../docs/DEFINITION_OF_DONE.md tampoco está disponible. No se inventa su contenido.

### Repositorios consultados en lectura

- Backend: [be-agro](https://github.com/Proyecto-Agro-Org/be-agro/tree/9cab86f35facf0ae49795e9ccf301cfc3c147094), commit local y remoto observado `9cab86f35facf0ae49795e9ccf301cfc3c147094`.
- Frontend: [fe-agro](https://github.com/Proyecto-Agro-Org/fe-agro/tree/f30c76dbd7f2f87aa5ef02e0be176f2e112fbb96), HEAD observado `f30c76dbd7f2f87aa5ef02e0be176f2e112fbb96`.
- Ingesta: [iot-ingest](https://github.com/Proyecto-Agro-Org/iot-ingest/tree/e6ffda0f0a4b9a18298c239ac34cc61de6b1c3fa), HEAD observado `e6ffda0f0a4b9a18298c239ac34cc61de6b1c3fa`.

Se inspeccionaron árboles de ambos repositorios relacionados, clientes/tipos, AuthProvider/CampoProvider y handlers relevantes del frontend; configuración, DTO/services/repositories, rutas, logger y README de ingesta. No se clonaron ni ejecutaron sus aplicaciones/tests.

La búsqueda de Issues de backend y el listado REST de Issues con state=all devolvieron vacío. No se encontraron Issues vinculados verificables en las fuentes locales; los IDs del plan son backlog documental, no números de Issues creados. No se consultaron tableros externos.

## B. Inventario técnico

| Archivo/componente | Función y evidencia |
|---|---|
| package.json | ESM, private, versión 1.0.0, engines.node 24.x; dependencias cors ^2.8.6 y express ^5.1.0 |
| package-lock.json | Lock v3; Express 5.3.0 y cors 2.8.6, coinciden con npm ls |
| src/app.js | createApp exportado + instancia default; desactiva x-powered-by, CORS, GET /health y handler de error |
| scripts/start.js | app.listen; PORT parseado con default 3000 |
| test/health.test.js | node:test/assert/fetch; HTTP efímero loopback, health, origen permitido, preflight, rechazo y 404 |
| vercel.json | framework express, fluid true; no credenciales, build ni rewrites explícitos |
| .env.example | Solo CORS_ORIGINS=http://localhost:5173; PORT es usado por código con default |
| .gitignore | Ignora node_modules, .env/.env.*, .vercel, logs y resultados; conserva .env.example |
| ddbb.puml | Diagrama documental; antes propuesta Time Series sin Área, actualizado como conceptual |
| Documentos raíz | Requisitos y propuestas que excedían la implementación real |

Scripts actuales: dev = node --env-file-if-exists=.env --watch scripts/start.js; start igual sin --watch; test = node --test. No hay build, typecheck, lint ni CI versionada. node_modules estaba presente, por eso pudo ejecutarse la suite sin instalar. Solo se observó .env.example en el directorio, sin leer secretos externos.

Entorno: Node v24.19.0, npm 11.17.0, PowerShell/Windows. No hay parser JSON explícito, controllers/services/repositories/models, SDKs, Mongo driver/Mongoose ni DTOs/validadores propios. Health no consulta DB.

## C. Matriz de brechas

“Pendiente” significa no implementado en este backend. BE-00/01 están preparados localmente, no Done. Para los criterios completos y etapas rige IMPLEMENTATION_PLAN.md.

| ID | Estado | Evidencia | Faltantes | Dependencias |
|---|---|---|---|---|
| BE-00 | Preparado local | Este informe, código y resultados H/I | Revisión/integración; humo publicado limitado | Fuentes/checkout |
| BE-01 | Preparado local | Documentos y diagrama alineados | Revisión/integración; resolver pendientes posteriores | Plan 05/11 y BE-00 |
| BE-02 | Pendiente | Ingesta JSON libre; schema solo propuesto | BSON/colecciones/IDs/relaciones/índices físicos | Evidencia Atlas y responsable ingesta |
| BE-03 | Pendiente | Tipos FE leídos, sin OpenAPI/DTO BE | Contrato aprobado y transición errores/auth/campos | BE-02 mínimo y frontend |
| BE-04 | Pendiente | Anexo/S8 y unidades demo | Unidades reales, null, fecha/fuente/calibración | Ingesta/Agronomía, BE-02/03 |
| BE-05 | Parcial base JS | Express/health/CORS existentes | Migración TS y scripts/deploy compatibles | Contrato mínimo |
| BE-06 | Pendiente | Solo app/start | Capas por recurso, DTOs y adapters | BE-05 |
| BE-07 | Pendiente | Sin dependencias Mongo/Zod | Mongoose, validación requests/env, conexión segura | BE-02/05/06 |
| BE-08 | Parcial | CORS y error handler básico | Error/404 uniforme, logs, límites, seguridad | BE-03 y base TS |
| BE-09 | Pendiente | Sin auth BE; demo FE | Identidad/sesión/contexto y pruebas de aislamiento | Política auth y BE-07/08 |
| BE-10 | Pendiente | CampoProvider solo mock | Campos/áreas reales y pertenencia | BE-02/03/09 |
| BE-11 | Pendiente | DTOs FE de sensores | Catálogo/detalle por área seguro | BE-10 |
| BE-12 | Pendiente | Solo mocks y payloads ilustrativos | Lectura real, mapper y nulls | BE-04/11 |
| BE-13 | Pendiente | FE envía limit 1000 | Histórico real, rangos, índices, truncado | BE-04/12 |
| BE-14 | Pendiente | Handler Dashboard mock | Agregación consistente por campo | Catálogo/mediciones/alertas |
| BE-15 | Pendiente | Tipos/cliente mapa FE | Endpoint y ubicación vigente | BE-11/12 |
| BE-16 | Pendiente | Lista/filtros mock FE | Origen/ciclo/persistencia o cálculo aprobado | Dominio y BE-09/11 |
| BE-17 | Opcional sin iniciar | Plan lo declara evaluación | Caso real, alternativa y alojamiento | Necesidad confirmada |
| QA-01 | Pendiente | No schemas Zod ni OpenAPI | Pruebas de contratos/validación/errores | BE-03/05/07/08 |
| QA-02 | Pendiente | Solo health/CORS tests | Auth/expiración/cliente cruzado | BE-09 |
| QA-03 | Pendiente | Sin jerarquía BE | Casos campo/área/dispositivo ajenos | BE-10/11 |
| QA-04 | Pendiente | Sin repositorio mediciones BE | Unidades, parciales, fechas, límites, DB fallida | BE-12/13 |
| QA-05 | Pendiente | Mocks no son evidencia BE | Regresión Dashboard/Mapa/Alertas | BE-14/15/16 |
| INT-01 | Pendiente | FE depende de MSW | Recorrido FE/BE/Atlas real | Contratos/módulos/QA |
| DEP-01 | Parcial configuración | vercel.json, URL comunicada | Validar ejecución publicada, entorno y seguridad | Configuración y QA |
| E2E-01 | Pendiente | Flujo descrito en ingesta | Evidencia trazable de hardware a FE | INT/DEP e IoT/ingesta |

## D. Contradicciones y resolución documental

| Diferencia | Evidencia/implicación | Tratamiento |
|---|---|---|
| Time Series propuesta vs colecciones comunes confirmadas | Antiguos ESPECIFICACION/SCHEMA/plan/ddbb | Retirada como arquitectura objetivo; solo mención histórica/rechazo |
| Tipado estático como único alcance vs Zod aprobado | AGENTS/DoD anteriores y plan 05/11 §3 | Zod runtime previsto; interfaces no validan JSON; aún no implementado |
| Campo equiparado a area_id | Schema/diagrama anterior omitía Área | Jerarquía completa, sin equivalencia lotes/campos/áreas |
| Stack documentado vs JS operativo | package y src/app.js | Tabla actual/objetivo; conservar health/CORS, migrar después |
| Cookie/JWT obligatoria vs Bearer FE | src/api/client.ts, sesion.ts | Documentar uso actual y decisión de sesión pendiente |
| Google “funcional” vs demo | loginGoogleDemo rechaza sin mocks | No hay Google real demostrado ni verificación BE |
| Hash de contraseña en tarea Google | Antiguo BE-06 y bcrypt propuesto | No imponer bcrypt al flujo Google; política real por decidir |
| Mongo fijo soil/nutrients vs JSON libre | measurement DTO/service | Inventario previo etiquetado histórico; no asumir campos/unidades/tenant |
| IDs string vs _id Mongo/clientid | device repository y esquema histórico | Correlación/tipos pendientes BE-02 |
| Broker HiveMQ/Make/proceso Node MQTT vs EMQX HTTP | Especificación 30/10/propuestas frente a código ingesta | Flujo observado separado; be-agro no consume MQTT |
| Hosting Render/Railway pendiente vs config Vercel | README/vercel.json | Vercel es base configurada; estado público no comprobado |
| Alertas backend/worker por desconexión vs alerta visual FE | Plan 05/11 | Sin worker/WebSocket obligatorio ni colección automática |
| IDs BE distintos entre documentos | Antiguo §11 vs plan rector | Backlog actualizado, correspondencia histórica E0…E4 conservada |
| develop asumida vs solo main | Ramas local/remoto | Recomendar acuerdo de integración, sin crear rama |
| Error string vs objeto objetivo | Cliente FE y handler BE | Incompatibilidad explícita; transición coordinada en BE-03 |
| Informe FE antiguo/guía A05 vs código actual | Informe dice Alertas en curso; guía A05 dice datos globales | Código HEAD incluye pantalla/tests/handlers y campoAutorizado; no tratar texto anterior como estado actual |
| Distintos nombres de humedad JSON | soil_moisture_reported_pct vs soil_moisture_sensor_pct | No alias automático aprobado; catálogo de formatos pendiente |

Las alternativas Python/AWS/Influx y los umbrales/frecuencias de documentos históricos son contexto de investigación. La planilla universitaria contiene fórmulas/cache con errores y referencias de tareas inconsistentes; no se usó como calendario ejecutivo aprobado.

## E. Contratos e integración

### Frontend

Fuentes: [cliente HTTP](https://github.com/Proyecto-Agro-Org/fe-agro/blob/f30c76dbd7f2f87aa5ef02e0be176f2e112fbb96/src/api/client.ts), src/api/*.ts, src/types/*.ts, AuthContext, CampoProvider, mocks/data/alcance y handlers.

Base /api/v1; rutas Dashboard, áreas/detalle/sensores, sensor/histórico, mapa y alertas. Todas las consultas de negocio observadas envían campo_id. El mock exige un campo_id único y valida que pertenezca al cliente del token; filtros area_id y device_id deben mantener esa jerarquía. Campo y Área son entidades independientes.

Login real esperado por cliente: email/password → token obligatorio, identidad opcional. Token en sessionStorage y Authorization Bearer. Google, recuperación y catálogo de campos funcionan mediante endpoints exclusivos MSW; CampoProvider se habilita solo con mocks. Logout es local. No hay integración de sesión segura con be-agro.

DTOs observados: medidas {valor,unidad}, valores nullable; sensor sin lecturas → ultima_medicion null; ubicacion nullable; resumen y listas con envoltorios específicos. Histórico incluye identidad, variable, unidad, puntos y truncado. El cliente fija limit 1000; handler default 500. Alertas limit 50/max 200 en MSW, total antes del límite, severidad+fecha; Dashboard cinco por fecha e incluye resueltas. Los contratos detallados quedan en ESPECIFICACION §5.

ErrorApi/leerMensajeError consume error string; formato objetivo error.code/message requiere adaptación. GET /campos, /auth/me y POST /auth/logout son opciones de contrato futuro, no rutas implementadas del backend ni llamadas actuales de ese frontend.

No se ejecutaron pruebas FE: existencia de archivos y handlers no demuestra que toda su suite pase. Los datos generados de MSW, intervalos y umbrales no son telemetría ni reglas agronómicas aprobadas.

### Ingesta y Mongo

Fuentes: [README de ingesta](https://github.com/Proyecto-Agro-Org/iot-ingest/blob/e6ffda0f0a4b9a18298c239ac34cc61de6b1c3fa/README.md), config/env.ts y modules/measurements/devices.

Flujo descrito: ESP32 publica MQTT → EMQX reenvía HTTP a /ingest y /iot-device-status → driver Mongo. No se verificó la configuración real del broker.

- mediciones: inserción de objeto libre no vacío; descarta _id entrante y añade _receivedAt Date. Sin validación fija ni deduplicación demostrada.
- dispositivos: merge/upsert por clientid, índice único solicitado, _createdAt y _lastSeen Date; los objetos recibidos reemplazan al subobjeto anterior.
- El resolver acepta variantes de ID de body/payload/query, y números como strings. No confundir clientid con cliente_id.
- Sobre EMQX completo puede conservar payload como string. Sin garantías de device_id, soil/nutrients, measurements/readings, timestamp adquisición, unidades ni entidad.
- Solo mediciones/dispositivos aparecen como colecciones accedidas por ese código. No se puede concluir qué otras colecciones existen físicamente en Atlas.

Ejemplos documentados, **no capturas reales**:

```json
{"schema_version":"2.2","clientid":"N1N4","message_type":"telemetry","readings":{"soil_moisture":41.2,"temp_c":19.8}}
```

El ejemplo anterior del README de ingesta difiere del payload histórico device_id/soil/nutrients y de la propuesta S8 measurements/derived. _receivedAt indica recepción; timestamp original, si viene, conserva su tipo/valor. _lastSeen puede corresponder a un evento MQTT y no a una lectura del suelo.

BE-02 necesita catálogo/relación de tenant confiable, correlación de IDs y ejemplos sanitizados; BE-04 necesita versión/formato, unidades, timestamps y parcialidad. Los adaptadores/mappers de lectura no deben inventar datos ni asignar cliente por parámetros públicos.

### S8 y alcance agronómico

Datasheet pp.15–17: humedad/temperatura int16 escalado por 10, CE uint16 µS/cm, salinidad/TDS uint16 mg/L; factores y offsets de configuración no equivalen a variables medidas. La ficha declara humedad %RH y precisión de temperatura ±5 °C; calibración/método pendientes.

S8 no provee NPK/pH. Salinidad/TDS son estimaciones del dispositivo; CE dS/m puede convertirse con unidad conocida, no inferida. Fórmulas de porosidad/aire requieren densidades/ensayos/humedad calibrada y profundidad compatible. No derivar NO₃⁻/P/K/pH desde CE. No reemplazar ausencias por cero ni mezclar datos demo con producción. La representación pública de procedencia/método queda para contrato posterior.

## F. Seguridad

1. Backend sin autenticación/tenant: no exponer futuras rutas de datos hasta tener identidad verificable y filtro en cada repository/agregación. No hay actualmente datos de negocio servidos por este backend.
2. Frontend con token accesible por JS y demos reproducibles: el login visual y los controles de navegación no autorizan acceso real. Deben decidirse Google, cuentas habilitadas y sesión/renovación/logout.
3. Ingesta declara y muestra endpoints sin autenticación; permite escrituras JSON y estado por ID público. Es un riesgo de integridad de la fuente compartida; no se modificó ni probó mediante escrituras. La API de consulta no debe confiar en tenant informado por esa telemetría.
4. Logger de ingesta serializa hasta 1000 caracteres del body; puede registrar información sensible enviada en el payload. Coordinar endurecimiento con sus responsables, sin copiar este patrón a be-agro.
5. CORS no es auth: sin Origin se permite y con wildcard también. No configura credentials ni rate limit/CSRF. El rechazo actual 403 está probado; definir política de producción cuando se implemente sesión.
6. Handler BE oculta mensaje de errores 500, pero registra Error completo por console.error; no existe redacción de secretos ni request ID. 404 devuelve HTML. Sin parser/validación runtime ni límites propios para futuros bodies.
7. No se encontraron credenciales en los archivos de configuración versionados revisados; no se inspeccionó todo el historial Git ni se realizó un escaneo externo de secretos/dependencias. No afirmar certificación de seguridad.

Pruebas pendientes obligatorias: 401 sin sesión, identidad inválida/expirada, dos clientes, campo/área/device cruzados, medición sin relación confiable, consultas agregadas y errores DB sin filtración. Recurso ajeno por defecto 404.

## G. Cambios documentales

| Archivo | Cambio y motivo |
|---|---|
| ESPECIFICACION.md | Estado real/objetivo, acuerdos, contratos FE actuales, brechas de ingesta, seguridad, magnitudes y pendientes |
| IMPLEMENTATION_PLAN.md | IDs/etapas 0–8 del plan 05/11, dependencias y criterios; BE-00/01 local sin Done; trazabilidad de tareas anteriores |
| SCHEMA_PROPUESTA.md | Colecciones comunes, Área separada, BSON/IDs pendientes, índices candidatos y compatibilidad sin migrar |
| AGENTS.md | Reglas Zod, jerarquía completa, estado actual, alertas y exclusión local |
| DEFINITION_OF_DONE.md | Zod/runtime, jerarquía, preservación/procedencia y pruebas; no exigir implementación futura a auditoría |
| README.md | Advertencias de alcance actual, health de proceso, stack futuro, CORS/auth y enlaces |
| ddbb.puml | Diagrama conceptual completo, elimina atributos timeField/metaField; no declara schema físico |
| INFORME_BE00_BE01.md | Informe solicitado A–J, evidencia y limitaciones |
| .git/info/exclude (local) | Añade /documentacion-referencia/ sin cambiar .gitignore compartido; no aparece en diff versionable |

Los borradores completos anteriores se conservan en Git base 9cab86f; se mantienen inventario histórico, contratos y pendientes útiles con su estado explícito. No se modificaron documentos fuente de referencia; se crearon extractos auxiliares locales dentro de su carpeta excluida.

## H. Testing y validaciones

| Comando/verificación ejecutada | Resultado |
|---|---|
| node --version / npm --version | v24.19.0 / 11.17.0, compatibles con engines 24.x |
| npm ls --depth=0 | express 5.3.0 y cors 2.8.6 instalados; sin instalar ni cambiar lock |
| npm test | 5/5 aprobadas, 0 fallos, node:test; health 200, CORS permitido, preflight 204, rechazo 403 y 404 |
| Probes HTTP adicionales en memoria, sin editar tests | 404 text/html “Cannot GET”; sin Origin → 200; allowlist vacía con Origin → 403; wildcard refleja origen permitido → 200; sin x-powered-by ni credentials |
| git status/branch/remote/log/diff/ls-files | Estado inicial y final documentado en I; sin cambios funcionales |
| git check-ignore -v sobre archivo de referencia | Coincide .git/info/exclude con /documentacion-referencia/ |
| Extracción textual de 10 fuentes | Word/Excel ZIP/XML y PDF pypdf disponibles; sin instalar |
| Lectura GitHub backend/FE/ingesta e Issues | Acceso disponible, commits fijados; Issues backend listado vacío |
| Humo GET backend publicado /health y FE /login | Herramienta web: URLs no accesibles; fetch Node: fetch failed. No se infiere caída de servicios |

Las URLs intentadas fueron https://be-agro-seven.vercel.app/health y https://fe-agro.vercel.app/login. El fallo de transporte del entorno impide certificar despliegue o su configuración CORS; no se hicieron POST de login/ingesta ni pruebas con datos reales.

No se ejecutaron: npm install/ci, npm audit (sin consulta a registry), migraciones, scripts E2E de ingesta (su README indica escrituras/borrado en producción), pruebas FE/ingesta, conexión Atlas, validación de índices físicos, OpenAPI/Zod/TS/Vitest/Supertest inexistentes, build/lint sin scripts, browser UI/OAuth ni despliegues.

La extracción de PDF no reemplaza revisión visual del hardware/wireframes. Las fórmulas/cache de Excel no fueron recalculadas. El diagrama PUML se revisó textualmente; no se ejecutó un renderer PlantUML.

Cierre: npm test volvió a pasar 5/5. git diff --check pasó tras corregir espacios finales; enlaces Markdown locales válidos, fences balanceados y sin caracteres de reemplazo. git diff --exit-code en src/scripts/test, package/lock, Vercel, .env.example y .gitignore confirmó ausencia de cambios funcionales; el índice Git siguió vacío. Las únicas menciones de Time Series quedaron como rechazo explícito o historia retirada.

## I. Git

Estado inicial antes de modificar:

- Rama: main, tracking origin/main.
- HEAD: 9cab86f; historial anterior incluye inicialización y CORS.
- Único contenido sin seguimiento: documentacion-referencia/. No había cambios staged ni modificaciones de archivos versionados.
- Ramas locales: main. Referencias remotas locales: origin/main y origin/HEAD → origin/main.
- Listado remoto GitHub /branches: solo main. No develop/dev.
- Remote origin: https://github.com/Proyecto-Agro-Org/be-agro.git.
- No se ejecutó fetch/pull; las refs locales no se presumen actualizadas fuera de la evidencia remota consultada.

Estado final comprobado para revisión: siete archivos documentales modificados, INFORME_BE00_BE01.md nuevo sin seguimiento; exclusión local aplicada. Nada staged, sin commits/push ni cambios de rama. La exclusión requirió escritura autorizada a .git/info/exclude fuera del permiso ordinario del sandbox; se aplicó solo la entrada solicitada.

Recomendación: acordar con el equipo rama develop o dev desde main estable; luego feature/<issue>-be00-be01-docs y PR documental a esa integración. Alternativamente, acordar PR directo a main para esta alineación si ese es el flujo elegido. No mover trabajo local ni crear ramas ahora. Integrar tras revisión y solo entonces actualizar estado Done.

## J. Próximos pasos

1. Revisar esta entrega y acordar rama de integración; no considerar BE-00/01 integrados hasta PR aprobado y checks satisfechos.
2. Para comenzar BE-02, obtener del responsable de datos un inventario de lectura y muestras sanitizadas de clientes/usuarios/campos/áreas/lotes/dispositivos/mediciones, tipos BSON, índices/opciones de colección y relaciones reales; correlacionar clientid con device_id/_id. No comenzar por migrar ni crear colecciones.
3. BE-03 requiere frontend y política auth: contrato real de campos/identidad/logout, Google/Bearer/cookie, errores string→objeto, filtros e históricos. Congelar rutas /sensores y nombres públicos antes de cambiar.
4. BE-04 requiere ingesta/Agronomía: unidades/precisión y procedencia, fechas adquisición/recepción, null/parcialidad, humedad calibrada y última lectura; definir tratamiento reversible de datos previos.
5. Después de aprobar contrato/modelo mínimo, autorizar BE-05…08 para TS/capas/Mongoose/Zod/seguridad/pruebas. La base health/CORS se conserva.

No se avanzó automáticamente a BE-02 ni se cerró por suposición ninguna decisión pendiente.
