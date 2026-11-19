# BE-09.5A — Auditoría final del catálogo usuario-cliente

19/11/2026. Base de revisión: dev `0f3bb209cf4b762da3bf8b6235a48c63727598af`.
Objeto: código BE-09.5 local, su seguridad, pruebas y preparación para integración.
**Resultado técnico: apto para PR Draft e integración de infraestructura deshabilitada,
sujeto a las comprobaciones/revisiones de GitHub. No habilita login ni aprueba el modelo BE-02.**

## 1. Alcance y preservación

Se revisaron todos los archivos de BE-09.5: modelos/validadores, schemas Zod y contratos internos,
mappers, store Mongoose, writer administrativo, invalidator de sesiones, lector existente,
sonda opt-in, tests, README, plan e informes. Sin cambios públicos HTTP/DTO ni frontend.

Worktree correcto, rama inicial dev, árbol con cuatro modificaciones y doce archivos nuevos,
sin staging. Fetch confirmó HEAD/origin-dev en la base esperada, main/origin-main en
`1bb20f76b7a739f42c75b37b9a64315276560ec1`. No hubo avance que reconciliar.
Se inventariaron ambos worktrees; el histórico BE-09 permanece en su rama original.

Se preservaron los 16 archivos iniciales con copias verificables y SHA256 fuera del árbol
publicado: `.local-consolidacion/integraciones/be09-5a-20261119/archivos-iniciales/`.
Verificados contra manifiestos: 22 originales/copias históricos y 21 respaldos; informe
privado BE-05 intacto. No se versionan copias, logs, .env, dist, node_modules ni datos externos.

## 2. Hallazgos y correcciones

| ID / severidad | Evidencia antes de corregir | Corrección mínima / regresión |
| --- | --- | --- |
| F95A-01 / Media, integridad | A01: insertClient que resuelve undefined sin escribir se interpretaba como alta confirmada | Ports de alta retornan recibo strict acknowledged=true/realm/id. Adaptador lo emite solo tras ACK booleano verdadero e insertedId exacto; servicio valida correlación. A01 ahora rechaza |
| F95A-02 / Media, confirmación operativa | A02: invalidator void sin operación se interpretaba como revocation confirmed | Recibo strict del barrido con ACK, realm, userId, beforeVersion y contadores validados/correlacionados. Void, false, metadata incorrecta o fallo→pending. A02/A03 ahora lo prueban |

La validación anterior de `z.undefined()` detectaba un false malformado (C36), pero
**ausencia de resultado no prueba persistencia**. Los nuevos recibos son contratos internos,
no DTO HTTP. C36 se conserva; no se cambian expectativas para esconder el defecto.
No se afirma que un recibo de un port arbitrario pruebe almacenamiento: se exige el adaptador
confiable que verifica la respuesta nativa del driver. No se permiten mocks en runtime productivo.

Cada limpieza retorna checkpoint `{realm,userId,beforeVersion}` junto con confirmed/pending.
Es reconstruible desde realm/id/securityVersion del usuario persistido si el proceso o la
respuesta del CAS se pierden; retryRevocation valida que no se solicite una versión futura.
El checkpoint no es una cola durable ni una transacción. A04 demuestra recuperación/reintento
idempotente tras CAS aplicado y error de respuesta, sin devolver permisos a la sesión vieja.

No hay hallazgos altos/críticos locales sin resolver. Los hallazgos previos F95-01/02/03 y
sus regresiones se conservaron; esta conclusión no certifica MongoDB real, GIS o seguridad universal.

## 3. Auditoría de modelos, tipos e índices

- Modelos auth-only `<prefix>_users`/`<prefix>_clients`; no duplican el Cliente agronómico definitivo.
  `_id` realm:id, claves string lógicas, issuer Google canónico/sub, email de contacto sin identidad por email.
- Pertenencia única nullable, no array. Boolean requerido; enteros seguros no negativos para versión;
  BSON Date validado y mapper a epoch. Null explícito se distingue de campo ausente/undefined.
- Zod strict y barreras antes/después del driver; escalado/casting no sustituye validación. Mongoose
  strict/strictQuery throw, cast false en escalares, autoCreate/autoIndex/buffering false.
- Identidad id/issuer/sub no modificable por CAS; realm se obtiene del store ligado a configuración,
  nunca de un request público. A07 verifica rechazo de mutaciones de identidad y downgrade de versión.
- Unicidad requerida: users realm/id, users realm/issuer/subject, clients realm/id; además `_id`.
  Declarado índice no único realm/membership.clientId/id. Sin unicidad de email ni TTL de catálogo.
- Factory comprueba listIndexes, índices completos y simple collation; rechaza requeridos parciales,
  sparse, hidden, no únicos, TTL en índice requerido o collation ajena. Nada de DDL/seed en runtime.
- Cursor limit2 falla ante duplicado inesperado, en lugar de elegir primero. Valores/operator objects,
  arrays, identificadores discordantes, campos extra y BSON malformado se rechazan.

**Límite:** los índices declarados no son índices reales observados. listIndexes es verificado aquí
mediante driver simulado; validadores, unicidad, CAS y opciones reales del servidor siguen pendientes.
Tampoco se monitoriza DDL continuamente: el operador debe impedir cambios externos no coordinados.

## 4. CAS, invalidación y revocación

El writer interno usa versión esperada y snapshot completo de los campos observados,
`$expr/$literal`, `$set` de mutables, versión+1, tiempo no decreciente y no upsert.
El perdedor recibe CONFLICT; no hay overwrite ciego. Respuesta after debe coincidir con lo esperado.
Snapshots de identidad y administración permanecen dentro de repositories/services, sin Express.

Las altas reales se confirman desde ACK/insertedId; cambios CAS desde documento after y validación;
limpieza desde ACK/contadores y recibo correlacionado. Un void no confirma ninguna de esas altas
o barridos en el servicio. Fallos de repositorio, getters/proxies hostiles y causas se sanitizan.

Primero se persiste la invalidación lógica del usuario; después se barren solo sesiones de ese
realm/usuario con versión inferior. Nuevas sesiones de la versión vigente no se revocan por
un retry antiguo. Fallo de limpieza deja pending/checkpoint, no revierte el CAS ni restaura acceso.
Pérdida del ACK del CAS produce error no confirmado; debe releerse el usuario antes de actuar.

Confirmed significa **operación de barrido reconocida**, no barrera global de inserciones futuras.
A08 inserta tardíamente una sesión obsoleta después de un barrido: puede quedar físicamente sin
revokedAt, pero el catálogo/versionado le niega acceso; reintentar el checkpoint la recoge.
No hay equivalencia entre invalidación lógica y que toda fila física haya sido borrada/revocada.
La recuperación operativa debe tolerar ese caso sin proclamar consistencia global instantánea.

## 5. Reactivación y aislamiento

- Cliente cambia de generación por CAS al deshabilitar/reactivar. Su pertenencia vieja queda
  obsoleta; reactivar el cliente no revive una sesión. Revincular usuario incrementa su versión.
- A→B y A→B→A siempre versionan usuario. No hay traspaso silencioso de una sesión a otro cliente.
- Usuario o pertenencia inactivos/ausentes y cliente inactivo no conceden ámbito. Usuario desconocido
  no se provisiona desde Google. El writer no tiene rutas administrativas públicas.
- C27 cubre recursos propios/ajenos mediante repository acotado; ajeno404. A05 agrega dos realms
  físicos sobre el doble compartido, con los mismos IDs/principal y baja independiente.
- C09/C24: dos writers de una versión, un ganador. C14/C15: baja/logout durante touch no restauran
  permisos. Puede completar un touch contable ya iniciado; capacidad ya admitida tiene límite de lease.
- A06: conexión perdida bloquea operaciones posteriores sin emitir comandos ni reconectar en secreto.

No se promete atomicidad global entre usuario/cliente/sesiones, cancelación instantánea,
snapshot conjunto ni linealizabilidad distribuida. Majority/journal/maxTimeMS no prueban esas garantías.

## 6. Pruebas agregadas y clasificación de evidencia

| Test | Comprobación |
| --- | --- |
| A01 | Void de alta no confirma escritura |
| A02 | Void de revocación no confirma barrido |
| A03 | Recibos con realm/id/versión/ACK/contadores incorrectos se rechazan |
| A04 | CAS aplicado con respuesta perdida: reconstrucción de checkpoint y retry idempotente |
| A05 | IDs/principal iguales entre dos realms físicos sin cruce de cambios |
| A06 | Pérdida y recuperación explícita de conexión |
| A07 | Inmutabilidad de identidad y prohibición de downgrade |
| A08 | Inserción tardía obsoleta tras limpieza: no autorización; retry posterior |

**A — Unitario/offline demostrado:** schemas, mappers, confirmaciones, scopes, errores, políticas
del servicio, origen privado de identidad/contexto, no activación al importar y contratos HTTP locales.
**B — Driver simulado demostrado:** barreras deterministas de CAS/insert/touch/revocation,
metadatos de índices, filtros/updates y opciones Mongoose/native; no servidor ni sockets MongoDB.
**C — MongoDB real pendiente:** unicidad, comparaciones BSON/validadores del servidor, CAS entre
procesos, lectura majority, journal/durabilidad, failover, TTL, red/ACK perdidos y límites temporales reales.

## 7. Validaciones completas de esta auditoría

| Comando/control | Resultado |
| --- | --- |
| npm ci | Exit0, lockfile intacto, 120 paquetes; audit0 vulnerabilidades reportadas |
| npm run typecheck | Exit0 |
| npm run build | Exit0 |
| npm test | **320/320**, 312 conservadas +8 nuevas; cero fallos/canceladas/skips |
| Diferencial HTTP contra0f3bb20 | **13/13 equivalentes**, cero cambios intencionales/regresiones |
| git diff --check y archivos nuevos | Aprobados |
| Sonda opt-in positiva / Atlas / GIS / Preview funcional | **No ejecutados** |

Se compararon GET/HEAD health, CORS allow/deny/slash/subdomain/wildcard/allowlist vacía, OPTIONS,
404 de ruta desconocida y POST health, más500 inesperado. Body, status y headers preservados.
Health200/status ok público; app/listener/DTO/contratos legacy siguen sin cambios ni endpoints nuevos.
Se audita el grafo de imports para confirmar que app default no alcanza router/store/modelos auth.
No hay nuevas dependencias; frontend, configuración Vercel y credenciales laborales no se modifican.

## 8. Riesgos residuales y gate MongoDB/Preview

La sonda queda doble opt-in sobre una instancia local nueva, exclusiva y expresamente autorizada;
no se ejecutó ni se instalaron servidores. Se requiere operador que confirme versión/topología,
ausencia de túneles, alcance DDL/fixtures y limpieza propia. Dos conexiones de un proceso no
sustituyen dos procesos OS ni pruebas de durabilidad/replicación. Sigue la campaña M01–M12 BE-09.4.

Administración externa debe respetar versiones, IDs no reutilizables y no hard-delete/reset de
contadores. Falta runbook/automatización de revocation pending y recuperación conjunta de catálogo/
sesiones; el checkpoint conserva los datos para retry, no ofrece ejecución garantizada por sí solo.
Faltan deadline global/cancelación, limiter compartido, política de operación y configuración GIS/FE.
La correlación del cliente auth con BE-02 agronómico requiere aprobación/evidencia externa.

**Recomendación:** publicar un único PR Draft de BE-09.5 + esta auditoría, comprobar contenido,
checks/revisiones/reglas y fusionar a dev solo si GitHub lo permite sin bypass. Auth permanece
deshabilitada antes/después; no marcar BE-09 Done ni iniciar BE-10. Un deployment Success no
valida MongoDB/GIS/API remota. El resultado del merge y SHA se registra al finalizar la operación
en evidencia externa, sin anticipar aprobaciones ni convertir infraestructura aislada en login real.

Trazabilidad: [implementación](INFORME_BE09_5_IMPLEMENTACION_CATALOGO.md),
[matriz BE-09.5](MATRIZ_BE09_5_SEGURIDAD_CONCURRENCIA.md),
[suite](test/identity-catalogue.test.js),
[contratos/plan pendientes](PLAN_BE09_4_IMPLEMENTACION_Y_APROBACIONES.md).
