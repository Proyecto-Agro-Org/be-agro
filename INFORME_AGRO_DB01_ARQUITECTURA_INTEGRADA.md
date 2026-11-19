# AGRO-DB-01 — Arquitectura integrada FE / BE / IoT

Fecha: 19/11/2026. Trabajo local de preparación; **sin migraciones, publicación ni activación**.
BE-09.5A permanece integrado y se reutiliza. Este informe no aprueba los contratos propuestos
BE-02/03/04/09.4 ni certifica un modelo físico que no se pudo observar.

## 1. Versiones y alcance de la evidencia

| Repositorio | Referencia inspeccionada | Comparación / límite |
| --- | --- | --- |
| be-agro | dev / origin/dev `ec56d26510ef9cd2a9620c148a9ec062d13727ed` | Worktree `.local-consolidacion/dev`; base esperada confirmada; main `1bb20f76b7a739f42c75b37b9a64315276560ec1` preservada |
| fe-agro | origin GitHub dev `6d6c54526c64c6acd4b347ff723c13488038075e`; copia local `daa72a828eb79aad0f09dcb7786a2c5a4adfd3bc` | Comparación de blobs de los 184 archivos locales: solo tres archivos de presentación difieren; tipos/API/MSW inspeccionados coinciden |
| fe-agro main | `f30c76dbd7f2f87aa5ef02e0be176f2e112fbb96` | Frente a dev cambian package.json/lock, App.tsx y vercel.json; Analytics y rewrite SPA no demuestran proxy API |
| iot-ingest | main `e6ffda0f0a4b9a18298c239ac34cc61de6b1c3fa` | Árbol GitHub completo: 29 archivos; lectura de los 28 archivos textuales de código/config/documentación; lock identificado en árbol, no descargado ni instalación ejecutada |

FE difiere en `src/components/layout/AppLayout.module.css`, `AppLayout.tsx` y
`SelectorTema.module.css`; también se leyó la versión remota de AppLayout. No hay autorización
para cambiar FE ni IoT. Se usaron lecturas GitHub fijadas por SHA y la copia FE local limpia.
Los ZIP mencionados no aparecieron entre los adjuntos accesibles ni en documentacion-referencia;
**comparación contra ZIP no realizada**. No se afirma haber buscado en todo el equipo.

BE: revisión del plan, especificación, DoD, informes BE-02/03/04/09.1–09.5, contratos propuestos,
modelos/repositorios auth, composición, sesiones/challenges, CAS, autorización y error/validación.
FE: dominio, tipos de respuesta, los nueve consumidores API, sesión, MSW, logout y configuración.
IoT: recorrido app → parser/logger/routes → controllers/DTOs → services → repositories → driver,
incluyendo configuración, adapters de requests, errores y README. No se inspeccionó EMQX real.

## 2. Resultado y decisiones técnicas adoptadas

Separar **dominio empresarial** y **dominio de ingesta**, con namespaces por entorno y permisos
independientes. Empresarial: catálogo existente, identidad/sesión, Cliente → Campo → Área → Sensor
lógico y asociaciones temporales administradas. Ingesta: dispositivos técnicos, mediciones crudas
y recepción. FE usa DTOs de BE; no accede directamente a MongoDB ni al webhook como API comercial.

No se construyó un segundo catálogo usuario-cliente. Se reutilizan SessionService.current(),
autorización privada, errores de aplicación y validadores existentes. No se añadieron modelos
agronómicos físicos, repositorios Mongo productivos, rutas, dependencias ni autenticación activa.

La matriz completa de IDs, colecciones, propietarios, ocho consultas internas e índices está en
[modelo y relaciones](MODELO_AGRO_DB01_DATOS_Y_RELACIONES.md). Las colecciones de código IoT son
`dispositivos` y `mediciones`, con base default `iot_sensores`, todas configurables. No son un
inventario físico observado. Los modelos auth existentes usan `<prefix>_users`, `_clients`,
`_sessions`, `_challenges`; también requieren comprobar configuración/servidor real.

Campos/áreas/sensores/asociaciones son propuestas de dominio y nombres físicos pendientes.
`lotes` no se equipara a áreas ni campos. IoT escribe su dominio; no usuarios, pertenencias ni
asociaciones. Runtime BE consulta ingesta con proyección y scope; administración/DDL separados.

## 3. Incompatibilidades y riesgos demostrados

La [matriz FE/BE/IoT](MATRIZ_AGRO_DB01_COMPATIBILIDAD_FE_BE_IOT.md) registra rutas y DTOs reales,
null/0, fechas, unidades, auth y diez ejemplos sintéticos comprobados contra los tipos FE.
`device_id` de FE identifica un Sensor lógico; no es prueba de equivalencia con `_id` BSON,
`clientid` MQTT ni `device_id` libre del cuerpo IoT. Email/nombre tampoco autorizan pertenencia.

IoT acepta mediciones sin identificador técnico obligatorio. Resuelve dispositivos mediante aliases,
con precedencia, trim y número→string; puede colisionar o ignorar aliases contradictorios. Su insert
elimina `_id` aportado, conserva el cuerpo y agrega `_receivedAt: Date`; no deduplica. Su upsert
preserva campos anteriores y mezcla datos libres con metadata técnica. `$literal` evita interpretar
el objeto como expresión: no se demostró ejecución de operadores Mongo desde el payload.

Hallazgos altos: webhook sin autenticación; identidad técnica suplantable/campos empresariales
libres; fallo de índice único capturado sin impedir upsert. La contaminación de autoridad sería
crítica si BE confiara en clientId/área de ese documento; DB01 no los utiliza para autorizar.
Otros riesgos: logs con body, `/debug` público con inventario, errores internos, duplicados,
formatos libres y estado técnico ambiguo. Evidencia, severidad y recomendaciones por responsable
en [riesgos de ingesta](RIESGOS_AGRO_DB01_INGESTA_IOT.md).

Frontend conserva discrepancias F01–F04: 401 tardío puede borrar sesión nueva, fallo de storage,
parser de error incompatible con objeto BE y parse JSON ante204. Logout es local; rutas de campos
y Google demo son mocks. Ni MSW ni el README IoT constituyen prueba de datos o despliegues actuales.

## 4. Históricos, reasignaciones y aislamiento

Se adoptan intervalos [inicio, fin), jerarquía persistida y asociación versionada. Nunca se entrega
todo el histórico del dispositivo basándose solo en su asignación actual. Los diez escenarios de
traslado, cambio de cliente, retraso, timestamps manipulados, desconocidos y duplicados están en
el modelo. Las mediciones no tienen cliente comercial confiable en el formato IoT inspeccionado.

**Recepción no prueba atribución temporal.** Tras una transferencia, un buffer del cliente anterior
puede recibirse después y parecer nuevo. Hace falta identidad autenticada y epoch/handoff comprobado,
autoridad temporal común o alternativa equivalente revisada. Hasta entonces, fuente en cuarentena.
Los flags de confianza son configuración interna respaldada por evidencia, nunca campos del payload.
No se aprueba la fuente IoT actual mediante un flag ni se migran históricos automáticamente.

## 5. Implementación local independiente

| Archivo nuevo | Función y límite |
| --- | --- |
| [association.contracts.ts](src/telemetry/association.contracts.ts) | Identificadores etiquetados, asociación, ports de lectura y ocho contratos internos; sin modelos físicos |
| [association.schemas.ts](src/telemetry/association.schemas.ts) | Zod estricto, límites, intervalos, IDs sin coerción y páginas completas acotadas |
| [telemetry-metadata.mapper.ts](src/repositories/telemetry-metadata.mapper.ts) | Solo metadata BSON/identidad/recepción y filtro exacto con guardias escalares; no lecturas/unidades ni normalizador |
| [associated-telemetry.planner.ts](src/repositories/associated-telemetry.planner.ts) | History planificado por sesión vigente, jerarquía, fuente, identidad técnica única e intervalos no solapados; sin ejecutar consultas Mongo |
| [audit-agro-db01-mongodb-local.ts](scripts/audit-agro-db01-mongodb-local.ts) | Sonda opt-in para DB nueva descartable, índices/fixtures/consultas; no ejecutada positivamente |
| [associated-telemetry.test.js](test/associated-telemetry.test.js) | 28 regresiones nuevas, fuentes/datos sintéticos y ports aislados; conserva todas las anteriores |

El planner rechaza selección pública de cliente/realm, jerarquía ajena, source no verificado,
identidad desconocida/duplicada, ventanas ambiguas, páginas incompletas y cambios de asociación.
Recorta al tiempo actual confiable, conserva tipos ObjectId/string distintos y exige revalidación
de sesión. Filtros incluyen identidad exacta y fecha [from,to), no lectura global y filtrado en memoria.

Hallazgo corregido durante tests: usar únicamente authorize() heredado de BE-09.1 no garantizaba
releer revocación de sesión persistida. DB01-17 falló; se corrigió el planner para reutilizar
SessionService.current() y repetir control de vigencia antes de devolver planes. También se ajustó
el schema de metadata a campos explícitos tipados; sin ampliar el contrato de origen.

Un plan **no es una capacidad de autorización durable**. Un futuro adapter debe revalidar al ejecutar,
coordinar revisiones concurrentes, aplicar proyección y presupuesto global/paginación. Se limita cada
segmento a1000 y cada página a64 asociaciones; no se promete un límite HTTP global ya implementado.
La detección offline de solapamientos no prueba atomicidad de writers ni aislamiento distribuido.

## 6. Validaciones y evidencia reproducible

- `npm ci`: satisfactorio, lock y dependencias existentes conservados; sin paquetes agregados.
- `npm run typecheck` y `npm run build`: satisfactorios con TypeScript5.9.3; artefactos excluidos.
- Baseline reconstruida: **320/320**. Suite final: **348/348**, sin fallos, cancelaciones ni skips.
  Las 28 nuevas cubren separación de IDs, límites, cliente ajeno, revocación, reasignación,
  fechas manipuladas, metadata parcial, filtros, concurrencia y rechazo de sonda sin autorización.
- **13/13 escenarios HTTP** equivalentes frente a ec56d26: health/HEAD, CORS, OPTIONS,404 y500;
  sin cambios intencionales nuevos. `/health` público y auth/Mongo sin activación automática.
- **10 controles IoT offline**: copias fijadas al SHA, repositories inyectados y getDb bloqueado;
  se reprodujeron riesgos de aliases, cuerpo, duplicados, logging y endpoints. No son pruebas remotas.
- JSON de ejemplos válido; **10/10 asignaciones TypeScript contra DTOs FE**, sin modificar FE,
  sin build/test frontend y sin afirmar validación runtime de contratos todavía propuestos.
- `git diff --check`, revisión de archivos nuevos, referencias locales y preservación por SHA256.

Evidencia local excluida del diff del worktree: `../integraciones/agro-db01-20261119/`.
Contiene estado-inicial-versionados.json, fuentes/iot-ingest, npm-ci.log, baseline-tests.log,
npm-test-final.log, regresion-http.json, auditoria-iot-offline.json, ejemplos-fe-validacion.json
y harnesses reproducibles. Los logs/harnesses son evidencia local, no archivos para publicación.
La copia IoT de evidencia no modifica su repositorio original.

## 7. MongoDB real: preparación y límites

[Campaña concreta](PLAN_AGRO_DB01_MONGODB_REAL.md): gate de autorización/instancia exclusiva,
tres sondas reutilizando auth/catálogo, comandos opt-in, fixtures y limpieza propia, y matriz R01–R16
para índices, CAS, challenge, revocación, vencimiento, consultas, reasignación, fallos y durabilidad.
La nueva sonda comprueba unicidad con código11000, filtros escalares/BSON y dos ventanas/two connections.
Nunca usa MONGODB_URI externa ni se conecta al importar; el test ejecuta solo el rechazo sin opt-in.

**No hubo conexión positiva MongoDB**, Atlas, consultas de datos reales, DDL externo ni instalación
de servidores. Las sondas no demuestran dos procesos SO, TTL físico, failover ni majority/journal.
Esos casos necesitan el harness/entorno revisados descritos, no una etiqueta de aprobado artificial.
La campaña permite ejecutar sus sondas básicas tras autorización; su tramo distribuido sigue pendiente.

## 8. Puntos no comprobados y cambios necesarios por repositorio

| Responsable sugerido | Próxima evidencia/acción | Estado |
| --- | --- | --- |
| Datos / operador MongoDB | Inventario autorizado de namespaces, BSON/índices/validadores, lotes y permisos por servicio; instancia local descartable | Pendiente acceso/aprobación; no inferir desde mocks |
| IoT / responsable broker | Autenticar webhook/dispositivo, resolver aliases, no mezclar autoridad comercial, dedupe, índices fail-closed, logging/debug seguro y handoff/epoch | Riesgos abiertos; no modificado aquí |
| Backend | Revisar contratos nuevos, correr campaña autorizada, concretar adapters tras mapping/índices y protocolo temporal; reutilizar catálogo BE-09.5 | Preparación local implementada; integración real bloqueada |
| Frontend / FE-BE | Acordar alias sensor/device_id, null/unidades/fechas/auth/error/logout, endpoint de campos y F01–F04 | Propuestas/revisión pendiente; FE intacto |
| Agronomía / IoT | Confirmar magnitudes, unidades/calibraciones, medición vs estimación/derivado y humedad | BE-04 pendiente; no conversiones reales |
| Operación / QA | Autorizar instancia, pruebas entre procesos y fallos/durabilidad; después Preview separado | No desplegado ni declarado aprobado |

No se inspeccionaron variables Vercel/EMQX ni permisos efectivos de bases externas. No se utilizaron
credenciales reales. GIS, autenticación productiva, contratos definitivos y BE-10 siguen fuera de alcance.

## 9. Preservación y criterio de salida

Sin commit, push, PR, merge, cambio de rama ni modificación de referencias. Los 130 archivos
versionados de BE permanecen idénticos al estado inicial, incluyendo BE-09.5 y todos sus tests.
Los cambios son once archivos nuevos previstos (cinco TS, un test y cinco documentos).
Main/dev conservan sus SHA; worktrees, informe local BE-05 y respaldos históricos se preservan.
Verificación final SHA256: 130 archivos BE versionados, 184 archivos FE, 22 originales/copias
históricos y 21 respaldos conservados. Sin referencias locales rotas ni hallazgos de patrones
de secretos en los once archivos nuevos, junto con revisión manual de su contenido.

AGRO-DB-01 queda **preparada localmente**, con arquitectura, helpers seguros y campaña; no certifica
interoperabilidad de producción. El siguiente paso concreto es acordar formato/identidad/atribución
IoT e inventario físico, mientras QA autoriza la instancia local para ejecutar las tres sondas y
completar concurrencia/durabilidad. No habilitar lecturas comerciales desde raw sin esas garantías.
