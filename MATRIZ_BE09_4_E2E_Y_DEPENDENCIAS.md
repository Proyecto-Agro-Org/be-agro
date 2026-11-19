# BE-09.4 — Matriz E2E, MongoDB y dependencias

19/11/2026. Base dev `07f15511f26d3fce664d892dba7c8ea7bf48cfe1`.
Plan de pruebas **no ejecutado** en Preview, Google real ni MongoDB real.

## Estados y niveles

| Estado | Significado en esta matriz |
| --- | --- |
| Implementado y verificado | Cobertura local histórica en suites listadas; 266/266 y 13/13 en PR #13, sin reejecución aquí |
| Implementado sin prueba real | Repositorio Mongoose, adaptador Google y router aislado |
| Propuesto | 22 escenarios E2E y protocolo MongoDB M01–M12 siguientes |
| Pendiente de aprobación | Fixtures, políticas D01–D08, criterios operativos y permiso G/H del plan |
| Bloqueado | Ejecución real sin catálogo, MongoDB/GIS y Preview expresamente autorizados |
| No aplicable | Datos productivos, Atlas, pruebas destructivas externas, endpoints de BE-10 |

Niveles: U=unitario/offline; I=HTTP local con ports controlados; M=MongoDB autorizado;
D=dos o más procesos OS y almacenamiento compartido real; E=FE navegador+BE+GIS+MongoDB en
Preview autorizado. U/I no sustituyen M/D/E. Todos los E siguientes están pendientes.
Dependencias: A catálogo; B HTTP; C instancia Mongo; D store físico; E GIS;
F frontend; G Preview; H auditoría, según [plan](PLAN_BE09_4_IMPLEMENTACION_Y_APROBACIONES.md).

Fuentes de cobertura local histórica: [sesiones](test/sessions.test.js),
[Google](test/google-identity.test.js), [persistencia](test/authentication-persistence.test.js),
[autorización](test/authorization.test.js), [aislamiento de app](test/app-isolation.test.js),
[matriz BE-09.3A](MATRIZ_BE09_3A_TRAZABILIDAD.md). Se inspeccionó la documentación y el código;
no se equipara una familia de tests con ejecución de cada escenario E2E completo.

## Matriz de 22 escenarios completos

Fixtures futuras: dos clientes sintéticos A/B, usuarios U/V, identidad Google de prueba
preaprovisionada en catálogo de Preview, sin PII de terceros ni credenciales en artefactos.
Registrar correlación/estados y contadores; jamás tokens, hashes utilizables o payload de ID token.

| ID / escenario | Precondiciones | Acciones | Resultado esperado | Nivel y evidencia local relacionada | Dependencia pendiente |
| --- | --- | --- | --- | --- | --- |
| E01 Login exitoso | U activo en A, GIS/origen/audience correctos, challenge vivo | Obtener challenge; GIS con nonce; POST login | 200; identidad A completa, Bearer Agro distinto del ID token; guard navega solo al validar respuesta | U Google + I sesiones; E pendiente | A–G |
| E02 Google inválido | Challenge vivo | Enviar firma falsa, aud/iss incorrectos o nonce ajeno con DTO válido | 401 genérico, cero sesiones válidas; no filtrar token/causa criptográfica | U Google/I; E negativo con fixtures controlados | B/E/G; no usar tokens reales robados |
| E03 Google vencido | Reloj controlado y token de prueba vencido más allá de skew | Login | 401; sin sesión; comprobar frontera de tolerancia por separado | U tiempos; E mediante fixture aprobado, no editar reloj de entorno compartido | B/E/H |
| E04 Usuario desconocido | Google válido sin alta en catálogo de prueba | Login | 403 genérico; sin JIT ni cliente por email | U/I catálogo/sesión; E pendiente | A/D/E/G |
| E05 Usuario deshabilitado | U.active=false | Login; intentar sesión anterior | Login403; sesión401; ningún dato privado | U/I; M/E pendientes | A/D/G |
| E06 Sin cliente | U sin membership o pertenencia inactiva/cliente ausente | Login | 403; no seleccionar cliente por UI/header | U/I catálogo; E pendiente | A/B/D/G |
| E07 Cliente deshabilitado | A.active=false | Login y consultar sesión existente | Login403; sesión401; no lectura de negocio | U/I; E pendiente | A/D/G |
| E08 Sesión creada | Login correcto | Inspeccionar registro sintético con herramienta de prueba autorizada | Solo digest, realm, vínculo/version, fechas y revocación; sin Bearer/ID token/nonce en claro | U/I mapper; M/D/E pendientes | C/D/G |
| E09 Sesión recuperada | Sesión viva y almacenamiento FE disponible | Recargar pestaña; GET session | Estado recuperando hasta200; identidad del BE, sin nuevo token; no confiar en datos locales de cliente | I backend; FE actual no implementa restore real | B/D/F/G |
| E10 Sesión vencida | Absoluta o idle agotada, fila aún presente por TTL tardío | GET session, ambas fronteras | 401 aun existiendo documento; FE limpia solo generación correspondiente | U/I; M/E pendiente | B/C/D/F/G |
| E11 Logout | Bearer vigente, Origin permitido | POST sin body; repetir; GET session posterior | 204 vacío e idempotente; GET401; FE no parsea JSON de204. Sin ACK/red: cierre local no implica revocación confirmada | I backend; F04 pendiente | B/C/D/F/G |
| E12 Revocación | Dos procesos, sesión reconocida por ambos | Revocar A, confirmar ACK; iniciar admisión B después y leer estado | Rechazo401 bajo semántica aprobada; no deshacer revokedAt por touch; operación previa admitida tiene límite documentado | U/I; M/D/E pendientes | C/D/D03/G |
| E13 Dos sesiones | U inicia dos logins con challenges distintos | Usar S1/S2; logout S1; consultar S2 | Ambas inicialmente válidas, tokens distintos; S1 deja de servir y S2 sigue según política de múltiples sesiones | I; E pendiente | D04/B/C/D/F/G |
| E14 Cambio de pertenencia | U en A con sesión antigua | Writer CAS cambia a B e incrementa versión; usar sesión vieja; nuevo login | Vieja401, nunca se transfiere a B; nuevo login solo B; A→B→A no revive anteriores | U/I; writer real pendiente | A/D03/C/D/G |
| E15 Acceso cruzado | U/A y V/B; fixture de recurso B | Repositorio de prueba solicita B con contexto U y manipula IDs públicos | 404 sin revelar existencia; filtro por cliente en query. E de negocio diferido: no hay endpoint BE-10 | U autorización + M repositorio futuro; E auth no prueba todos los recursos | A/BE-02; endpoint de negocio fuera de esta fase |
| E16 Error de red | Sesión B nueva mientras request A antiguo sigue abierto | Perder red en challenge/login/session/logout y resolver 401 A tarde | UX reintento acotado; no falsa sesión/ACK; login B no se borra por401 A; intento consumido requiere challenge nuevo | FE F01 pendiente; I fallos controlados | B/F/G/H |
| E17 Error de persistencia | Store inyectable o instancia descartable | Fallar escritura/ACK de consume, insert, touch, revoke; provocar get/set/remove de storage FE fallidos | BE503 seguro sin éxito falso; no sesión parcial utilizable; FE envía Bearer de memoria, informa revocación no confirmada | U/I fallos; F02 pendiente; M/D requerido | B/C/D/F/G |
| E18 Challenge repetido | Challenge consumido, credential vinculada | Repetir login secuencial y simultáneo | Un solo ganador elegible; posteriores401; jamás dos sesiones entregadas para mismo challenge | U/I; M/D pendientes | C/D/G |
| E19 Challenge expirado | Challenge vencido antes de consume o durante espera de port | Login; liberar barrera tras vencer | 401, no token entregado; FE descarta nonce y solicita nuevo intento | U/I; M/E pendientes | B/C/D/F/G |
| E20 Requests simultáneos | Varias llamadas session y actividades fuera de orden | Barreras IPC liberan touch nuevo antes de antiguo; hacer logout concurrente | idle nunca disminuye ni supera absoluto; revocación no se limpia; respuestas FE obsoletas no sustituyen sesión | U/I A09; M/D/E pendientes | C/D/F/G |
| E21 Token robado simulado | Dos clientes de prueba conocen el mismo Bearer sintético | Usarlo desde segundo navegador; revocar legítimamente; repetir | Antes de revocar puede funcionar: Bearer no es proof-of-possession. Después rechazo según D03; documentar riesgo XSS, no inventar binding IP | I; E controlado pendiente | D04/B/C/D/G/H |
| E22 Baja concurrente | Barrera después de lectura de usuario y antes de touch/admisión | Confirmar baja+versión; liberar y observar todas las etapas | Política mínima: touch iniciado puede finalizar, autorización que observa baja rechaza; fuerte: fence debe impedirlo. Nunca afirmar garantía fuerte con diseño actual | U/I A10 histórico; M/D/E pendientes | D03/A/C/D/G/H |

## Plan reproducible MongoDB autorizado

### Requisitos antes de cualquier ejecución

No se identificó una instancia expresamente autorizada para esta tarea. No se ejecutó la sonda.
No usar MONGODB_URI del usuario, ni buscar credenciales/puertos desconocidos. **Bloqueo C**:
el operador debe registrar instancia local descartable exclusiva, versión, topología, puertos,
ausencia de túneles a Atlas, autorización para fixtures/DDL/limpieza y responsable de recuperación.
Loopback por sí solo no prueba aislamiento. Sin instalar herramientas sin autorización.

Para pruebas de durabilidad/failover y transacciones: replica set aislado con topología conocida,
primario y réplicas, mayoría/journal verificables; permiso específico para detener procesos/nodos
de ese entorno. Una instancia standalone y dos conexiones solo cubren parte del plan.
Definir timeout global por test, límite de reintentos, tolerancia de reloj y ventana de observación
TTL por escrito antes de correr. Congelar versión de MongoDB/driver y configuración en evidencia.

### Sonda existente: alcance exacto

[scripts/audit-auth-mongodb-local.ts](scripts/audit-auth-mongodb-local.ts) requiere
`AGRO_AUTH_LOCAL_AUDIT=AUTHORIZED_DISPOSABLE_LOOPBACK_ONLY` antes de conectar;
puerto decimal 1024..65535, default27017, replica set opcional validado.
Ignora MONGODB_URI; usa 127.0.0.1/directConnection y DB aleatoria nueva
`agro_auth_audit_<24hex>`. Crea únicamente dos colecciones propias e índices; no es read-only.
Dos Connections del **mismo proceso**, ocho consumos concurrentes, replay, índice único real,
revocación y un caso BSON array-null. No prueba TTL transcurrido, failover, catálogo físico,
durabilidad entre procesos ni semántica completa de ACK perdido.

Procedimiento futuro, **solo después del acta C de autorización**, en sesión PowerShell
dedicada con las tres variables AGRO_AUTH_LOCAL_* inicialmente ausentes:

```powershell
npm ci
npm run build
# Reemplazar el puerto de ejemplo SOLO por el puerto exclusivo aprobado.
$env:AGRO_AUTH_LOCAL_AUDIT = 'AUTHORIZED_DISPOSABLE_LOOPBACK_ONLY'
$env:AGRO_AUTH_LOCAL_PORT = '27019'
# Si corresponde, fijar AGRO_AUTH_LOCAL_REPLICA_SET al nombre aprobado.
try {
    node dist/scripts/audit-auth-mongodb-local.js
    if ($LASTEXITCODE -ne 0) { throw 'La sonda no aprobo' }
} finally {
    Remove-Item Env:AGRO_AUTH_LOCAL_AUDIT -ErrorAction SilentlyContinue
    Remove-Item Env:AGRO_AUTH_LOCAL_PORT -ErrorAction SilentlyContinue
    Remove-Item Env:AGRO_AUTH_LOCAL_REPLICA_SET -ErrorAction SilentlyContinue
}
```

No ejecutar ahora. Guardar nombre aleatorio anunciado y resultado sanitizado. Finally elimina
solo las dos colecciones creadas y valida propiedad; no dropDatabase. Si se interrumpe por kill,
no asumir limpieza: operador verifica exactamente DB y nombres propios antes de limpiar.
No borrar bases ajenas ni respaldos. El éxito de esta sonda es **parcial**, nunca aprobación D completa.

### M01–M12 — Campaña necesaria además de la sonda

Preparar en una tarea futura un harness con dos procesos Node independientes, puertos privados
de control/IPC, DB aleatoria única del coordinador y fixtures compartidos. Cada worker crea
su propia conexión/repositorio; barreras confirman puntos alcanzados antes de liberar acciones.
El coordinador distribuye solo alcance de fixture, nunca tokens reales. Este harness aún no existe;
no ejecutar dos sondas esperando concurrencia, porque cada una elige otra DB.

| ID | Experimento / control | Criterio de aprobación y evidencia |
| --- | --- | --- |
| M01 | Crear índices aprobados en DB vacía; altas duplicadas paralelas | Exactamente un principal/ID y digest por clave, demás11000; índices full unique/simple, tipos escalares, no sparse/partial. El factory actual comprueba unicidad de sesiones, no todo el futuro catálogo |
| M02 | Challenge único compartido entre ≥2 procesos con barrera, ≥8 intentos | Exactamente un consume=true y como máximo una sesión entregada; repeticionesfalse; realm/nonce ajenofalse; registrar conteos por proceso sin secretos |
| M03 | Expiración lógica con filas aún existentes, $$NOW y relojes controlados | Ningún consume/touch autoriza vencido por reloj aplicación/servidor; medir divergencia y rechazar configuración fuera del presupuesto aprobado |
| M04 | TTL expiresAt y absoluteExpiresAt sobre Date | Existencia/opciones del índice verificadas; expiración lógica inmediata al límite; eliminación eventual observada dentro de ventana operativa preacordada. Timeout de observación = no aprobado/investigar, no prometer borrado exacto en60s |
| M05 | Touches fuera de orden y logout antes/después | $max no disminuye idle, jamás excede absoluto, no reanima revoked/expired; snapshots after coherentes y vínculo inmutable |
| M06 | Revocación A, ACK, nuevas admisiones B; reiniciar workers | Revocación durable visible y rechazo conforme al SLA/semántica D03; no depende de caché o proceso original |
| M07 | Mayoría/journal y failover autorizado | Sesiones/claims/revocaciones confirmadas sobreviven elección/reinicio bajo configuración documentada; si no hay ACK, resultado desconocido, no falso éxito |
| M08 | Pérdida de ACK/red tras consume/insert/revoke, deadline total | Cero duplicación de sesión entregada; intento consumido no se reutiliza; revocación no confirmada explícita; deadline/cleanup/reintentos acotados. Revisar retryableWrites del driver, no confundir con retries de aplicación |
| M09 | Inyectar fixtures BSON inválidos por acceso exclusivo | Array/null/Date/string/número/Long fuera de rango, IDs discordantes, revokedAt:[null], consumedAt:[null]: fail closed, sin coerción peligrosa ni secreto; limpieza acotada |
| M10 | Catálogo real: usuario/membresía/cliente/version modificados durante sesión | Sin fallback a otro cliente; dup/ausencia/baja deniegan; A→B→A y disable/re-enable no reviven; consultas exactas por realm/IDs |
| M11 | Carreras de baja y dos writers CAS mediante barreras | Resultado E22 conforme a D03 aprobada; ningún permiso por touch; exactamente un CAS ganador para una versión. Si D03 fuerte, demostrar conflicto común y todas las escrituras participantes |
| M12 | Fallo de limpieza/caída parcial y aislamiento | Artefactos indican operaciones incompletas y objetos propios pendientes; ninguna colección ajena tocada; conteos finales/índices/versiones y logs sanitizados reproducibles |

La [limpieza TTL es asíncrona](https://www.mongodb.com/docs/manual/core/index-ttl/);
no autoriza una sesión. [Read concern majority](https://www.mongodb.com/docs/manual/reference/read-concern-majority/)
trata datos confirmados por mayoría, no convierte dos lecturas en una transacción conjunta.
Los experimentos, no la documentación del proveedor, deben probar el comportamiento de Agro.

### Gate de aprobación de pruebas distribuidas

C y D se aprueban por BE/Datos/QA/Seguridad solamente con: acta de alcance; versiones/topología/
índices y config reproducibles; scripts/harness revisados; al menos dos procesos OS sobre la misma
DB de prueba; todos M01–M12 aprobados o exclusiones justificadas que impidan habilitar lo no probado;
conteos/resultados y orden por barreras; revisión de fallos parciales/retries; limpieza confirmada;
informe sin secretos; política D03 satisfecha, sin hallazgos altos/críticos. Una exclusión de
durabilidad/failover **no** habilita declarar distribución/durabilidad aprobadas.

## Gate de E2E/Preview

G requiere autorización específica de Preview, commit/orígenes/client ID/namespace identificados,
contratos aprobados, catálogo real de prueba, limiter compartido y plan de rollback. H ejecuta
E01–E22 con evidencia FE+BE+DB, además de regresión /health y CORS sin mocks productivos.
En E15 el repository puede probar aislamiento con fixtures; los endpoints de negocio futuros
necesitan su propia aprobación y prueba cuando existan. No cerrar ese criterio como E2E completo
de negocio ni empezar BE-10 para mejorar el conteo.

Red/SDK/certificados/GIS bloqueados por proveedor deben registrarse como bloqueados, no como
tests aprobados. Un deployment Ready/Success no sustituye ninguno de estos resultados.
