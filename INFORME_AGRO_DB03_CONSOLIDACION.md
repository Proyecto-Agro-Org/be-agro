# AGRO-DB-03 — Auditoría y consolidación DB-01 / DB-02

19/11/2026. Repositorio Proyecto-Agro-Org/be-agro. Base auditada dev/origin-dev:
`ec56d26510ef9cd2a9620c148a9ec062d13727ed`.
**Apto para publicar infraestructura deshabilitada y fusionar solo si los controles finales
GitHub lo permiten. MongoDB real, telemetría comercial y autenticación productiva siguen pendientes.**

## 1. Inventario y preservación

Worktree `.local-consolidacion/dev`, rama inicial dev,130 archivos versionados sin modificar y
22 archivos sin seguimiento DB-01/DB-02. No faltó ninguno. Fetch y lectura GitHub confirmaron
la base sin avance. Main/origin-main conservan `1bb20f76b7a739f42c75b37b9a64315276560ec1`.
Worktree histórico BE-09 permanece en63c7eb20882e1e63e9ed03e2b6afa0a91e124afc.

Antes de corregir: copia de los22 archivos y hashes de152 archivos en
`../integraciones/agro-db03-20261119/archivos-iniciales/` y estado-inicial.json.
Se verificaron22 originales/copias históricos,21 respaldos y184 archivos FE sin cambios.
Informe privado BE-05 preservado; sin reset/clean, force push, migraciones ni borrados ajenos.

## 2. Alcance incorporado y archivos revisados

Se revisaron íntegramente los22 archivos de DB-01/DB-02 y sus dependencias de sesión/catálogo:

| Grupo | Archivos |
| --- | --- |
| Contratos/validación DB-01 | src/telemetry/association.contracts.ts y association.schemas.ts |
| Preparación de lectura | src/repositories/telemetry-metadata.mapper.ts y associated-telemetry.planner.ts |
| Sonda DB-01 | scripts/audit-agro-db01-mongodb-local.ts |
| Pruebas DB-01 | test/associated-telemetry.test.js |
| Documentación DB-01 | INFORME_AGRO_DB01_ARQUITECTURA_INTEGRADA.md, MATRIZ_AGRO_DB01_COMPATIBILIDAD_FE_BE_IOT.md, MODELO_AGRO_DB01_DATOS_Y_RELACIONES.md, PLAN_AGRO_DB01_MONGODB_REAL.md, RIESGOS_AGRO_DB01_INGESTA_IOT.md |
| Harness DB-02 | scripts/audit-agro-db02-mongodb-local.ts y scripts/agro-db02/{guard,resources,cases,processes,worker}.ts |
| Launcher/guardias | scripts/agro-db02-local.ps1 y test/agro-db02-guard.test.js |
| Documentación DB-02 | INFORME_AGRO_DB02_PRUEBAS_MONGODB_REAL.md, MATRIZ_AGRO_DB02_RESULTADOS.md y GUIA_AGRO_DB02_ENTORNO_LOCAL.md |

Este informe es el archivo23. No se incluyen logs, respaldos, copias IoT de evidencia, .env,
dist, node_modules ni documentación privada. Package/lock, app, rutas, middleware, configuración
Vercel, catálogo BE-09.5 y sus pruebas anteriores permanecen idénticos a la base.

Los documentos DB-01/DB-02 conservan su evidencia histórica348/356. El resultado vigente de esta
consolidación es357; no se reescriben sus resultados pasados como si hubieran ejecutado MongoDB.

## 3. Revisión técnica y hallazgos

DB-01 distingue cliente comercial/clientid MQTT/sensor lógico/ID BSON. Zod valida IDs, páginas
completas y límites sin coerciones; metadata no devuelve payload/lecturas ni campos comerciales.
El planner revalida SessionService.current(), jerarquía, source autenticado/atribución temporal,
unicidad técnica e intervalos [inicio,fin), con chequeo de solapamientos/revisión y filtros Mongo
acotados. Source sin evidencia queda rechazado; timestamp del emisor no decide autoridad.
Planes no son permisos durables: el futuro ejecutor debe revalidar al ejecutar y limitar la página
global. No se implementa ni aprueba un writer físico de asociaciones ni una garantía distribuida.

DB-02: opt-in estricto, contexto Docker IPC local, contenedor propio por ID/label, red interna
exclusiva, binding127.0.0.1 y exactamente dos tmpfs; namespace aleatorio de testing, sin URI
arbitraria, discovery remoto o credenciales de MongoDB. Creación explícita y limpieza solo de
colecciones propias; retiro de contenedor/red requiere ownership. Sin ejecución destructiva por
defecto. Timeout/kill puede impedir finally: manifiesto y recuperación manual propia siguen necesarios.

| Hallazgo | Evidencia / severidad | Corrección |
| --- | --- | --- |
| DB03-01 | Importar worker.ts ejecutaba su cuerpo y cambiaba exitCode a1 sin invocarlo como programa. En un proceso IPC también podía iniciar su protocolo/disconnect. Baja: efecto lateral del harness; no ruta productiva | Se encierra el worker en su función de entrada y se ejecuta solo si import.meta.url coincide con argv[1]. Regresión DB03-G09: falló1!==0 antes, aprueba después |

Se añadió únicamente esa regresión por un defecto reproducido. No nuevas suites simuladas,
abstracciones genéricas, endpoints, normalizadores ni refactorizaciones ajenas. Las sondas antiguas
y el harness DB-02 tienen alcance distinto documentado; no se duplican modelos/catalogue/auth.

No hay hallazgos altos/críticos abiertos en el cambio local **inactivo** revisado. Esto no cierra
los hallazgos altos de la ingesta ajena ni autoriza usarla para consultas comerciales.

## 4. Compatibilidad y ausencia de activación

Lectura remota actual: FE dev `6d6c54526c64c6acd4b347ff723c13488038075e`, IoT main
`e6ffda0f0a4b9a18298c239ac34cc61de6b1c3fa`; no avanzaron respecto de DB-01.
No se repitió la investigación de MongoDB, se accedió a Atlas ni se modificaron esos repositorios.
Los DTOs observados/nueve operaciones FE y unidades propuestas siguen documentados, no aprobados
por inferencia. La jerarquía y alias de sensores permanecen propuestas de mapping explícito.

App/default listener no importan el planner, modelos ni harness nuevos. Health sigue público,
200/{status:ok}; CORS/errores/404 preservados. No auth productiva, telemetría comercial, startup
MongoDB automático ni endpoints BE-10. Pruebas positivas MongoDB no forman parte de npm test.

## 5. Validaciones ejecutadas

| Control | Resultado |
| --- | --- |
| npm ci | Exit0,120 paquetes; lock/package intactos; warning transitivo existente |
| npm run typecheck | Exit0, strict/NodeNext |
| npm run build | Exit0 |
| npm test | **357/357**,356 anteriores +DB03-G09; sin fallos/skips/canceladas |
| HTTP diferencial contra ec56d265 | **13/13 equivalentes**, cero cambios intencionales nuevos |
| git diff --check / whitespace nuevos | Sin errores |
| Sintaxis launcher PowerShell / referencias locales | Verificadas |
| Import del worker | Sin efecto lateral después de corrección; evidencia antes/después |
| MongoDB real / replica set / multiproceso real | **0 ejecutados**;15 casos R01–R15 preparados, no aprobados |

Evidencia local excluida: `../integraciones/agro-db03-20261119/` contiene snapshot, logs npm,
worker-import-before.log, http-regression.json y verificación de identidad/reglas sin secretos.
Los manifests/salidas futuras MongoDB no se presentan como evidencia obtenida.

## 6. Publicación, reglas y Vercel

Rama única prevista `feature/agro-db01-db02-integracion`, basada en dev; commit
`feat: preparar integracion MongoDB FE BE IoT`. Author/Committer requeridos Camila Gonzalez,
camiiigonzalez1503@gmail.com. Staging explícito de23 archivos; ningún archivo previo fuera del alcance.

Cuenta del conector y credencial GCM específica de este repositorio verificadas como camiegonzalez,
con permiso push. No cambios de configuración global/credenciales laborales. El conector no permite
leer administración; la consulta read-only con la cuenta universitaria obtuvo dev sin protección
(404 Branch not protected), rules/branches/dev vacío y rulesets vacío. Sin workflows en GitHub.
No se utilizará bypass por ser administradora; si cambian reglas/revisiones, detener el merge.

El PR se crea Draft hacia dev y se evalúa su diff/HEAD/base, checks, revisiones y estado antes de
marcar Ready/fusionar. Production Branch=main fue confirmada por el usuario en esta sesión previa;
no equivale a una lectura nueva de Vercel Settings. Aquí no hay acceso Vercel para certificar reglas
externas/promociones; se registra lo que GitHub exponga, sin afirmar seguridad por nombre de rama.
La API deployments inicial devuelve lista vacía, lo que no demuestra ausencia de integración Vercel.
No se modifica main/configuración ni se ejecutan deployments manuales. Checks/statuses automáticos
de Vercel no se interpretan como pruebas funcionales remotas o de MongoDB.

El SHA final de dev, URL/estado del PR, checks y limpieza de rama se verifican **después** de la
operación y se registran en su PR/entrega y evidencia local final. Este documento fija la auditoría
que entra al commit; no anticipa un merge como realizado ni modifica el informe para inventar resultados.

## 7. Pendientes y condiciones para datos reales

- MongoDB local exclusivo autorizado con Docker/motor disponible; ejecutar la guía DB-02,
  standalone y replica set,15 casos, índices efectivos, PIDs y limpieza confirmada. Harness positivo
  aún no validado; no afirmar CAS, unicidad, BSON, expiración, sesiones o revocación reales aprobados.
- Durabilidad/journal/restart, failover multinodo, pérdidas reales de ACK/red, TTL físico y
  coordinación atómica de writers de asociaciones requieren campaña adicional; tmpfs no lo prueba.
- IoT: webhook sin auth, suplantación/aliases, índice fallido no bloqueante, campos libres,
  logging/debug y duplicados. Su responsable debe resolver riesgos antes de confiar en su fuente.
- Recepción no basta para atribuir atrasos después de reasignar un dispositivo. Exigir identidad
  autenticada, source y handoff/epoch comprobados; sin ello cuarentena, sin lectura comercial.
- Datos/BE: inventario autorizado BSON/índices/permisos, jerarquías y lotes, IDs físicos y mapping;
  FE/BE/Agronomía: contratos/errores/auth/unidades/fechas; GIS/Preview/activación requieren aprobación.

Siguiente acción técnica: habilitar el entorno local autorizado y ejecutar las pruebas existentes,
sin otra ronda documental ni BE-10. Integrar esta preparación no aprueba el modelo físico,
no cierra BE-09 ni habilita autenticación/telemetría en producción.
