# Plan de implementación del backend be-agro

**Actualizado:** 16/11/2026 · alineación BE-00/BE-01.
**Fuente rectora:** Plan de Trabajo Backend A26T02 del 05/11/2026 §§7–11.
**Contrato y evidencia:** [ESPECIFICACION.md](ESPECIFICACION.md), [INFORME_BE00_BE01.md](INFORME_BE00_BE01.md).

## Uso y estado

- [ ] Pendiente; [/] trabajo local preparado/en revisión; [!] requiere decisión/evidencia; [x] PR integrado y criterios satisfechos.
- Una entrega local o un PR abierto no está Done. No se completa ninguna etapa por haber redactado su propuesta.
- Solo main y origin/main comprobadas. No asumir develop/dev; acordar rama de integración antes de crear feature/<issue>-<tema>. Esta auditoría no crea ramas, commits, Issues ni despliegues.
- BE-00 y BE-01 producen documentación; no incluyen BE-02/03/04 ni instalación/migración de paquetes.
- Ya existen Express/JS, health y CORS. Se adaptan al stack objetivo conservando comportamiento; no se reconstruyen.
- Las casillas anteriores E0…E4 no estaban completadas. Se reorganizan con los IDs del plan del 05/11, evitando colisiones con la numeración BE sugerida del antiguo documento.

## Backlog vigente y dependencias

| Estado | ID | Etapa | Trabajo y criterio de aceptación | Dependencias |
|---|---|---|---|---|
| [/] | BE-00 | 0 | Auditar repo, ramas, health, scripts, entorno, pruebas, Vercel y documentación. Informe trazable con límites de acceso; PR revisado/integrado para cierre. | Repo y fuentes disponibles |
| [/] | BE-01 | 0 | Consolidar capas, Zod, jerarquía, colecciones comunes, auth observada y alertas. Documentos coherentes, decisiones pendientes explícitas; PR integrado para cierre. | BE-00 y plan 05/11 |
| [ ] | BE-02 | 1 | Definir IDs y schema Mongo físico/objetivo con ejemplos sanitizados, BSON, lotes, relaciones y alcance de cliente; índices convencionales e históricos preservados. | BE-01; evidencia Atlas/ingesta |
| [ ] | BE-03 | 1 | Definir DTORequest/DTOResponse, schemas Zod y OpenAPI con frontend: campo_id/area_id/device_id, rutas sensores, auth, errores, filtros, límites y nullabilidad. | BE-01; modelo mínimo BE-02 y decisiones de sesión |
| [ ] | BE-04 | 1 | Catálogo de unidades, precisión, fuente, null, fechas adquisición/recepción y conversión de datos previos; ejemplos aprobados por dominio/ingesta. | BE-02/03; muestras y Agronomía |
| [ ] | BE-05 | 2 | Migrar Express JS a TypeScript sin perder health/CORS/Vercel; scripts dev/build/start o estrategia equivalente documentada y reproducible. | Contrato mínimo BE-02/03/04 |
| [ ] | BE-06 | 2 | Implementar capas por recurso y DTOs/mappers/adapters, sin consultas Mongo en controllers ni Express en services. | BE-05 |
| [ ] | BE-07 | 2 | Configurar Mongoose y Zod requests/env; conexión segura, fallos controlados y configuración validada. | BE-05/06; modelo aprobado |
| [ ] | BE-08 | 2 | Error handler/404 uniforme, logging con request ID, CORS, seguridad HTTP y límites; pruebas sin secretos. | BE-03 y base TS |
| [ ] | BE-09 | 3 | Integrar Google/sesión aprobada, contexto de cliente, recuperación/logout y aislamiento de consultas por jerarquía. | BE-07/08; política auth cerrada |
| [ ] | BE-10 | 4 | GET campos por cliente y catálogo áreas; campos vacíos, 400/401/404, filtro por cliente dentro de repository. | BE-02/03/09 |
| [ ] | BE-11 | 4 | Dispositivos por área y detalle, mappers/ubicación/última comunicación, recursos ajenos 404; conservar rutas públicas acordadas. | BE-10 |
| [ ] | BE-12 | 5 | Última medición por dispositivo autorizado, unidades/fuentes, nulls y sensor sin lecturas; ruta a acordar sin duplicar detalle innecesariamente. | BE-04/11 |
| [ ] | BE-13 | 5 | Históricos con Zod, ISO/zona, rango válido, límite, orden y truncamiento; cliente y dispositivo verificados e índices evaluados. | BE-04/12 |
| [ ] | BE-14 | 6 | Dashboard por campo, conteos consistentes, cinco alertas según contrato, fecha nullable; vacío sin datos inventados. | Catálogo/mediciones y contrato alertas |
| [ ] | BE-15 | 6 | Mapa por campo, coordenadas válidas o null, conserva dispositivos sin ubicación y últimas lecturas. | BE-11/12 |
| [ ] | BE-16 | 6 | Contrato/datos de alertas aprobadas: filtros, orden, total y límite; distinguir ausencia visual en FE de historial persistente. | Origen/ciclo de vida aprobado; BE-09/11 |
| [ ] | BE-17 | 7 opcional | Evaluar necesidad de worker/tiempo real, comparar polling/SSE/WebSocket y alojamiento; documentar adoptar/posponer/descartar. | Caso operativo confirmado; no bloquea MVP |
| [ ] | QA-01 | 1–2 | Pruebas Zod, contratos y errores; validación de ejemplos DTO/OpenAPI/FE y fallos HTTP. | BE-03/05/07/08 |
| [ ] | QA-02 | 3 | Auth válida/inválida, expiración, logout/recarga y cruces de dos clientes. | BE-09 |
| [ ] | QA-03 | 4 | Cliente/campo/área/dispositivo ajenos, IDs inválidos y listas vacías. | BE-10/11 |
| [ ] | QA-04 | 5 | Últimas/históricos, parciales, unidad, fecha, truncamiento, fallo DB y ausencia distinta de cero. | BE-12/13 |
| [ ] | QA-05 | 6 | Regresión Dashboard, Mapa y Alertas, cambio de campo y respuestas vacías/errores. | BE-14/15/16 |
| [ ] | INT-01 | 8 | Integración FE/BE/Atlas con datos controlados, mocks desactivados y contrato real validado. | Funcionalidades/QA |
| [ ] | DEP-01 | 8 | Validar deploy Vercel, variables/orígenes/Atlas, HTTPS y humo; sin secretos ni regresión. | Configuración acordada y QA |
| [ ] | E2E-01 | 8 | Prueba trazable sensor/simulador→EMQX→ingesta→Mongo→API→FE, coordinada con responsables. | INT-01, DEP-01, IoT/ingesta |

La matriz de estado/evidencias/faltantes para todos los IDs está en el informe BE-00/BE-01. Prioridad alta para BE-00…13 y QA-01…04; media para BE-14…16 y QA-05; BE-17 posterior/opcional. Integración, despliegue y E2E son prioridad alta de cierre.

## Etapa 0 — Alineación y preparación

BE-00/01 documentan estado actual versus objetivo, inspeccionan frontend e ingesta en lectura y registran acuerdos del 05/11. No considerar que login visual, health o documentación prueban autenticación/Atlas. Rama de integración y política de PR quedan por acordar.

**Aceptación:** informe con comandos/resultados, brechas, fuentes/commits, limitaciones y decisiones pendientes; documentación coherente y PR integrado. Preparado localmente, no marcado Done.

## Etapa 1 — Modelo y contrato

BE-02 releva colecciones/IDs y diagrama físico; no asume lotes=campos=áreas ni copia propuesta como schema real. Colecciones comunes e índices por cliente/campo/área/dispositivo/tiempo.

BE-03 conserva nombres públicos observados: /sensores y campo_id; endpoint real de campos/identidad/logout por acordar. Google-demo es MSW. Cookie y Bearer no están ambos aprobados; decidir uno y sus protecciones. Acordar transición de error string a {error:{code,message}}.

BE-04 acuerda normalización de soil/nutrients, readings, measurements y payload string solo para formatos efectivamente encontrados. Distingue fecha de adquisición de _receivedAt, valores medidos/estimados/derivados/laboratorio/ausentes. S8 no mide NPK/pH. No usar %RH como VWC ni aplicar umbrales sin calibración/método.

**Aceptación:** ejemplos/documentos y tipos aprobados, DTO/Zod/OpenAPI concordantes, catálogo de unidades y fechas con casos de null, fechas inválidas e IDs ajenos. No se implementa esta etapa en la auditoría.

## Etapa 2 — Migración y base técnica

BE-05…08 adaptan lo existente a TS, capas, Mongoose, Zod, errores/logging y seguridad. Mantener health público del proceso; readiness de DB si se aprueba como ruta separada. Definir parser JSON/límites, configuración de entorno, errores asíncronos y 404 seguro.

**Aceptación:** arranque/build o compilación de despliegue documentados, Vitest/Supertest previstos, regresión health/CORS, Zod 400, fallo DB simulado seguro y pruebas independientes de producción. No instalar paquetes antes de esta etapa autorizada.

## Etapas 3–6 — Funcionalidades

Auth y aislamiento preceden a exposición de datos; validaciones de pertenencia ocurren en repositories. Catálogo mantiene nivel Área bajo Campo. Mediciones preservan históricos y nulls; mapa incluye sensores sin ubicación. Dashboard comparte reglas/conteos de dominio.

Alerta visual por ausencia de lecturas: frontend. BE expone timestamps/configuración acordados. Alertas técnicas/agronómicas consultables requieren origen, reglas, estado y persistencia o cálculo aprobado; no derivar historial de desconexión desde observaciones del navegador.

**Aceptación:** HTTP y DTO acordados, pruebas positivas/negativas/borde por módulo, cruces de clientes/campos/áreas y fallos DB; QA-02…05.

## Etapa 7 — Evaluación opcional

BE-17 distingue worker (proceso) de WebSocket (canal). No exige proceso perpetuo en Vercel ni infraestructura adicional sin caso aprobado. La decisión puede posponerse sin bloquear el primer hito.

## Etapa 8 — Integración y QA

INT-01/DEP-01/E2E-01 validan recorrido real con usuarios de prueba, dos clientes, campo vacío, dispositivo sin lecturas y datos parciales. Validar CORS/sesión en dominios reales, Atlas y trazabilidad; pruebas HTTP separadas de las escrituras coordinadas de ingesta.

**Primer hito:** usuario autenticado → cliente autorizado → campo → área → dispositivo → última medición Atlas → DTO normalizado → frontend publicado.

## Bloqueos y decisiones concretas

- Acceso de lectura o muestras sanitizadas Atlas, BSON, colecciones/opciones/índices y relaciones persistidas.
- Tabla de correlación clientid MQTT ↔ device_id público ↔ _id BSON y política ante reasignación/IDs repetidos.
- Fuentes confiables usuario-cliente, catálogo y campos; sesión Google real, recuperación/expiración/logout.
- Migración coordinada de errores FE, contrato campos y límite de históricos (cliente envía 1000; mock default 500).
- Unidades reales, fecha de adquisición/recepción, humedad calibrada, procedencia y periodicidad; definición de última lectura parcial y ubicación vigente.
- Origen de alertas distinto de aviso visual de ausencia.
- Rama de integración; estado de despliegue no verificable desde el entorno de auditoría.

## Correspondencia con planificación histórica

| Tareas anteriores (02/11) | Destino vigente, sin considerarlas completadas |
|---|---|
| E0.1…E0.7 | BE-01 (acuerdos), BE-02/03/04 (pendientes), BE-16, DEP-01 |
| E1.1…E1.6 | BE-02/03/04 y QA-01; se retira diseño Time Series |
| E2.1…E2.6 | BE-05/06/07/08; base JS ya existente |
| E3.1…E3.3 | BE-09, QA-02 |
| E3.4…E3.6 | BE-10/11, QA-03 |
| E3.7…E3.8 | BE-12/13, QA-04 |
| E3.9…E3.12 | BE-14/15/16, QA-05 |
| E3.13…E3.14 | QA-01…05 |
| E4.1…E4.5 | INT-01, DEP-01, E2E-01 y documentación/DoD por entrega |

Se conserva esta trazabilidad y los criterios útiles; el plan anterior completo está en Git base 9cab86f. Las propuestas de Time Series, hosting alternativo y cookie obligatoria no rigen como acuerdos. Para cierre usar [DEFINITION_OF_DONE.md](DEFINITION_OF_DONE.md).
