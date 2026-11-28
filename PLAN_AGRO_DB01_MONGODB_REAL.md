# AGRO-DB-01 — Campaña MongoDB real autorizada

19/11/2026. **Preparada, no ejecutada positivamente.** No Atlas, servidores ajenos,
instalaciones automáticas, escrituras remotas ni eliminación de datos existentes.
La aprobación de esta tarea autoriza código/tests locales; no autoriza una base MongoDB real.

## Decisiones adoptadas

Reutilizar las sondas BE-09.3/09.5 para auth; no duplicar catálogo ni crear otra implementación
de sesiones. Añadir una sonda DB01 limitada a consultas/metadata con fixtures empresariales e IoT
en namespaces separados de una DB nueva. Cada sonda comprueba propiedad y limpia solo lo que creó.
Los nombres de fixtures no constituyen nombres físicos productivos aprobados.

## Gate P0 — autorización y registro del entorno

Operación/Datos/QA debe registrar antes de conectar:

- Instancia existente/provisionada expresamente, exclusivamente descartable, sin datos ajenos,
  host loopback/puerto reales y ausencia de túneles a Atlas/producción. Loopback solo no demuestra aislamiento.
- Versión MongoDB/driver/Node, topología, roles y permisos DDL/fixtures/limpieza. No deshabilitar
  auth de un servidor compartido para que las sondas funcionen. Estas sondas no aceptan credenciales/URI externas;
  si la instancia requiere otra autenticación, detenerse y preparar mecanismo aislado revisado.
- Presupuesto de tiempo, reloj, cuota de datos y criterio de limpieza si kill/fallo parcial.
  Registrar DB aleatoria anunciada, nombres creados, PIDs y logs sanitizados sin tokens/cadenas de conexión.
- Replica set aislado y permiso específico para fallos de nodos si se evaluarán majority/journal,
  failover/transacciones. Un standalone o dos conexiones no certifican esas garantías.
- Para datos empresariales reales, mappings/IDs/source/handoff aprobados. Los fixtures no conceden
  permiso para leer fuentes reales. FE/GIS/auth productiva permanecen deshabilitados.

Sin P0: solo validar schemas/guardias offline, como en los tests actuales; no escanear puertos
ni intentar conectarse a cuentas desconocidas. No instalar mongod/docker/CLI automáticamente.

## Sondas ejecutables existentes y alcance exacto

| Sonda | Objetos nuevos propios | Comprueba / no comprueba |
| --- | --- | --- |
| [audit-auth-mongodb-local.ts](scripts/audit-auth-mongodb-local.ts) | DB agro_auth_audit_*; dos colecciones auth | Índice digest, un consume entre8 llamadas/dos conexiones, replay, revocación, null escalar. No TTL físico/failover/dos procesos |
| [audit-catalogue-mongodb-local.ts](scripts/audit-catalogue-mongodb-local.ts) | DB agro_catalogue_audit_*; cuatro colecciones auth | Catálogo, validadores/índices, dos altas/CAS/dos conexiones, reactivación y sesión obsoleta. No durabilidad distribuida |
| [audit-agro-db01-mongodb-local.ts](scripts/audit-agro-db01-mongodb-local.ts) | DB agro_db01_audit_*; db01_business_associations, db01_ingest_devices, db01_ingest_measurements | Unicidad técnica, dos ventanas [100,500)/[500,1000), filtros/arrays/ObjectId, metadata y dos conexiones. No writer de asociaciones ni atribución IoT real |

Todas usan DB aleatoria nueva y directConnection=true a127.0.0.1, ignoran MONGODB_URI, autoCreate/
autoIndex/buffering deshabilitados y conexiones explícitas. Ninguna sonda positiva forma parte de npm test.
Solo sus rechazos sin opt-in se ejecutaron. No abrir la app/ingesta real para probarlas.

## P1–P3 — ejecución futura, únicamente después de P0

En PowerShell dedicado con las variables AGRO_* de auditoría inicialmente ausentes:

```powershell
npm ci
npm run typecheck
npm run build
$env:AGRO_AUTH_LOCAL_AUDIT = 'AUTHORIZED_DISPOSABLE_LOOPBACK_ONLY'
$env:AGRO_CATALOGUE_LOCAL_AUDIT = 'AUTHORIZED_DISPOSABLE_CATALOGUE_ONLY'
$env:AGRO_DB01_LOCAL_AUDIT = 'AUTHORIZED_DISPOSABLE_DB01_ONLY'
$env:AGRO_AUTH_LOCAL_PORT = '27019' # Sustituir exclusivamente por el puerto aprobado.
# Opcional: AGRO_AUTH_LOCAL_REPLICA_SET, nombre local aprobado.
try {
    node dist/scripts/audit-auth-mongodb-local.js
    if ($LASTEXITCODE -ne 0) { throw 'P1 no aprobada; verificar limpieza propia' }
    node dist/scripts/audit-catalogue-mongodb-local.js
    if ($LASTEXITCODE -ne 0) { throw 'P2 no aprobada; verificar limpieza propia' }
    node dist/scripts/audit-agro-db01-mongodb-local.js
    if ($LASTEXITCODE -ne 0) { throw 'P3 no aprobada; verificar limpieza propia' }
} finally {
    Remove-Item Env:AGRO_AUTH_LOCAL_AUDIT -ErrorAction SilentlyContinue
    Remove-Item Env:AGRO_CATALOGUE_LOCAL_AUDIT -ErrorAction SilentlyContinue
    Remove-Item Env:AGRO_DB01_LOCAL_AUDIT -ErrorAction SilentlyContinue
    Remove-Item Env:AGRO_AUTH_LOCAL_PORT -ErrorAction SilentlyContinue
    Remove-Item Env:AGRO_AUTH_LOCAL_REPLICA_SET -ErrorAction SilentlyContinue
}
```

No ejecutado aquí. P1/P2/P3 crean **bases distintas**, no son una transacción conjunta ni concurrencia
entre procesos. El evento de scope identifica cada DB. Finally verifica DB/nombres/colecciones creadas,
sin dropDatabase. Ante error/kill, operador inspecciona y limpia solo esas colecciones tras confirmar
propiedad. No limpiar una base por simple prefijo ni ejecutar comandos sobre archivos de respaldos.

## Matriz de pruebas reales y criterios de aceptación

| ID | Preparación y acciones | Resultado exigido / evidencia |
| --- | --- | --- |
| R01 Namespaces/permisos | Instancias/DB de prueba y roles IoT/BE/admin; intentar operaciones propias y prohibidas en fixtures | IoT no escribe auth/empresarial; FE sin rol Mongo; BE lector raw no modifica ingesta; no DDL runtime |
| R02 Índices | Revisar listIndexes/options/validators reales antes de servir | Unique full/simple de catálogo y dispositivos; auth digest; índice técnico+recepción/id; no sparse/partial ocultando duplicados |
| R03 Unicidad | Dos procesos con mismo principal/id técnico e IDs documentales distintos | Exactamente un alta elegible y11000/conflicto seguro; ningún primer duplicado elegido |
| R04 CAS | Ambos workers leen versiónv; barrera IPC libera escrituras contradictorias | Un ganador v+1 y otro conflicto; sin mezclar pertenencias ni resetear versión |
| R05 Challenge | Dos procesos con challenge vivo, ≥8 consumes concurrentes | Un solo ganador, replay/nonce ajeno/vencido rechazan; no dos tokens entregados |
| R06 Revocación | CAS invalidante, barrido y ACK; nueva admisión desde otro proceso; perder ACK y reintentar | Versión vieja denegada; recibo correlacionado; checkpoint recuperable; newer sessions conservadas |
| R07 Expiración/TTL | Fila vencida aún presente, luego observar TTL | Rechazo lógico inmediato; borrado eventual dentro de ventana observada pactada, sin prometer60s exactos |
| R08 Identificación | clientid técnico igual al texto de cliente empresarial, aliases contradictorios, ObjectId/string iguales | No colisión de autoridad ni conversión implícita; mapping explícito, dispositivo0/2 resultados deniega |
| R09 Historia A/B | A[100,500), B[500,1000), recepción300/600 y timestamp manipulado | A solo300, B solo600 si fixtures de atribución son confiables; query ejecuta device+Date+guardias, no filtra raw global en memoria |
| R10 Atrasos/handoff | Mensaje de epoch anterior llega tras cambio, relojes sesgados, sin epoch/handoff demostrable | Cuarentena, ningún cliente hereda lectura ajena. Campo epoch libre del payload no sirve como prueba |
| R11 Solapamiento | Intentar dos asociaciones activas/intervalos solapados de distintos clientes con writers concurrentes | Writer/protocolo aprobado lo impide o lectura falla cerrada; índice unique por inicio solo no basta |
| R12 Versionado de relación | Cambiar cierre/revisión mientras plan/lectura espera en barrera | Plan/resultados obsoletos descartados; revalidar al ejecutar, no tratar plan estático como permiso durable |
| R13 BSON adverso | Arrays en identificador/Date, null/ausentes, `$`/`.` en valores, payload excesivo/parcial | Tipos/control de campos y $literal; no ejecución de operadores ni fuga por mapper/error/log |
| R14 Última medición/estado | Histórico de varias asignaciones, varios candidatos, sin mediciones, eventos contradictorios | Solo datos propios; vacío/null legítimos, orden estable, no _lastSeen global de otro cliente |
| R15 Durabilidad | ACK majority/journal, reiniciar worker/primario en replica set descartable autorizado | Escrituras confirmadas sobreviven según topología documentada; desconocido tras ACK perdido no es éxito |
| R16 Conectividad/cleanup | Caída antes/después de write/read, deadline global, abort y fallo de finally | Errores seguros, pending/checkpoint cuando corresponde, no retries infinitos ni limpieza ajena |

R03–R06/R11/R12/R15 requieren harness entre **dos procesos OS** con PIDs distintos, conexiones propias,
DB compartida del coordinador, fixtures propios y barreras IPC ready/read/commit/ack. No usar sleeps
como prueba del orden. El harness distribuido no está implementado/certificado por las tres sondas;
su preparación y revisión se completan con el operador en la tarea de MongoDB autorizado.
Los resultados de P1–P3 no completan esas filas por sí solos.

## Puntos no comprobados y aprobación de salida

No se obtuvo versión/topología de servidor porque no se conectó. Quedan pendientes casos reales,
explain/index usage/costo, paginación global y durabilidad. Source actual de IoT no tiene identidad
ni atribución temporal autenticadas: R09 sintético no aprueba conectar datos de producción.

Salida de campaña: P0 firmado por roles responsables; scripts/harness revisados; versiones,
índices/validadores y namespaces reproducibles; cada R con evidencia/aprobado o bloqueo explícito;
dos procesos demostrados donde corresponda; limpieza y restauración verificadas; cero hallazgos
altos/críticos sin resolver. Si falta prueba distribuida, no declarar atomicidad/durabilidad aprobadas.

Cambios por repositorio: BE prepara sondas/helpers y futuros adapters tras mapping; IoT/broker
entregan identidad/source/epoch y cierran riesgos; FE acuerda DTOs sin tocar DB. Preview/activación
requiere autorización independiente y contratos cerrados. Esta campaña no inicia BE-10 ni autoriza deploy.
