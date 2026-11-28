# BE-09.5 — Matriz de seguridad y concurrencia

19/11/2026. Base0f3bb20, cambios locales en dev sin publicar.
**Implementado/validado localmente** no significa **probado en MongoDB real**.
No hay aprobación externa del modelo BE-02 ni activación de autenticación.

Actualización BE-09.5A: [auditoría final](INFORME_BE09_5A_AUDITORIA_FINAL.md),
**320/320** (312 conservadas +8 A01–A08), con13/13 HTTP. Las filas C y312 siguientes
registran la etapa previa. Void deja de confirmar altas/barridos: recibos strict y checkpoint
correlacionado sustituyen aquella validación. Sin MongoDB real ni autenticación activada.

Evidencia principal: [suite nueva](test/identity-catalogue.test.js),
[informe de implementación](INFORME_BE09_5_IMPLEMENTACION_CATALOGO.md),
[campaña real pendiente](MATRIZ_BE09_4_E2E_Y_DEPENDENCIAS.md).
La suite usa modelos Mongoose reales, Connection sin sockets y un driver simulado determinista.
Se controlan barreras de promesas, nunca sleeps como prueba del orden. No hay locks en memoria
en el runtime que pretendan sustituir índices/CAS compartidos del servidor.

## Trazabilidad C01–C37

| Casos | Riesgo / experimento | Control y resultado local | MongoDB real / límite |
| --- | --- | --- | --- |
| C01 | Import/modelos/DDL involuntarios | Namespace auth, Date, índices declarados, sin cliente/socket ni autoCreate/autoIndex/buffering | Crear/verificar colecciones/índices solo con permiso |
| C02 | Índice ausente, parcial, sparse, hidden, collation ajena o TTL en índice requerido | Factory rechaza antes de servir; cero DDL | listIndexes real y control de cambios de DDL pendientes |
| C03 | Mapeo inseguro/exposición BSON | Roundtrip Date/epoch, generaciones, snapshots congelados, sin _id/realm en logical record | BSON del servidor no muestreado |
| C04 | null/undefined/extra/operator/string vacío | Entrada strict bloquea antes de comandos | No depender de tipos TS |
| C05 ×10 | BSON con ausencia de membership, versión null/string/fraccionaria, realm/id arrays, fecha string, ID discordante, campos extra o pertenencia array | Todas las lecturas rechazan, sin devolver autorización | Falta fuzzing/campaña real de BSON/validadores |
| C06 | Dos altas simultáneas del mismo principal con IDs distintos | Barrera antes de insert; un ganador, otro CONFLICT, sin diagnóstico privado | Índice único simulado; confirmar11000 real |
| C07 | IDs repetidos, email igual o realm ajeno | IDs únicos; email compartido no fusiona usuarios; otro realm no encuentra datos; no JIT | Índices/relaciones reales pendientes |
| C08 | Duplicados inesperados | Cursor limit2, error por ambigüedad de usuario/principal/cliente; no primer resultado arbitrario | Índices necesarios, defensa adicional en lectura |
| C09 | Dos cambios de pertenencia con la misma versión | Barrera antes del CAS; exactamente un ganador, versión1; otro CONFLICT | Atomicidad servidor aún no certificada |
| C10 | A→B→A o desvinculación | Incremento siempre; sesiones anteriores401, null impide login | Revalidación observa snapshots, sin cancelación instantánea |
| C11 | Baja/alta de usuario | Versionado evita revivir sesión antigua; nueva sesión requiere login | Requiere writer confiable y no reiniciar contadores |
| C12 | Baja/alta de cliente | Generación0→1→2; miembro0 queda obsoleto; revincular versiona usuario antes de nuevo login | No barrido multiusuario atómico ni reactivación automática |
| C13 | Reactivación entre lectura de usuario y cliente | Generación se compara al resolver cliente; estado activo por sí solo no autoriza | Una última lectura puede volverse obsoleta después |
| C14 | Baja mientras touch espera; limpieza fallida | Touch puede terminar; posterior autorización401; usuario permanece inactivo; revocation pending | Semántica mínima D03, no cero escrituras tras baja |
| C15 | Logout durante touch | Revocación persiste; touch no restaura sesión ni autorización | Probar entre procesos y con ACK real |
| C16 | Fallo tras CAS y antes de revocación | Versión persistida, limpieza pending, sesión vieja rechazada; retry no revoca nueva versión | No cola durable; operador debe releer/reintentar |
| C17 | Versión vieja, cliente inexistente/inactivo, overflow | CONFLICT/404/403/500 seguros; sin overwrite | MAX_SAFE_INTEGER no se desborda ni reinicia |
| C18 | Store caído o ACK truthy no booleano | 503 seguro; nunca éxito confirmado por string true | ACK perdido puede dejar escritura aplicada pero no confirmada |
| C19 | Query/escritura sin scope, timeout, simple collation o majority | Comandos examinados por el doble; realm fijo, límites, no upsert, w majority | No prueba rendimiento/durabilidad de MongoDB |
| C20 | Dato cambia sin versión o se vuelve array antes del CAS | Comparación completa snapshot con $expr/$literal no coincide; no se modifica | Privilegiados no deben escribir fuera del protocolo |
| C21 | Generación de cliente ausente en una sola parte | Denegación. Compatibilidad solo cuando ambos ports lógicos heredados omiten metadata | Store físico exige generaciones siempre |
| C22 / F95-01 | Excepción tipada con getter code que lanza secreto | Falló antes; descriptor de datos seguro y error nuevo sanitizado después | No guardar excepción/cause del proveedor |
| C23 | Cliente cambia de generación antes de insertar usuario | Alta queda con pertenencia obsoleta, login denegado; no permiso por carrera | No snapshot transaccional entre ambos documentos |
| C24 | Dos cambios de estado del cliente, misma versión | Barrera CAS; un ganador y versión1 | Pendiente confirmar entre procesos reales |
| C25 | Generaciones físicas ausentes | Store/mapper no permiten fallback legacy de registros físicos | No migrar filas incompletas silenciosamente |
| C26 | Casts/defaults Mongoose | null explícito válido; missing, boolean/versión string, fecha número, email/subject inválidos rechazan | Mongoose no es barrera única |
| C27 | Recurso de otro cliente | Contexto de catálogo físico + repository acotado; 404, filtro por cliente observado | No implementa endpoint de negocio BE-10 |
| C28 | Revocación de otro realm o versión nueva | Solo usuario/realm y versiones antiguas; realm inválido rechazado | No es logout-all público |
| C29 | Array realm/revokedAt y ACK falso en barrido | No match malformado; ACK no válido→pending, sin rollback de versión | BSON malformado ya deniega en lectura |
| C30 | Proxy hostil/excepción o ports mutados | Errores sanitizados; métodos se capturan al construir servicio | DI debe seguir siendo confiable |
| C31 | Revocación de versión futura y reloj que retrocede | Conflicto o error antes de CAS; cero actualización | Sin sincronización distribuida de relojes demostrada |
| C32 | Lookup por email/operator/extra | Rechazo sin query | Identidad solo issuer/sub verificado |
| C33 | Especificación DDL incompleta | Requeridos/scalars/generaciones, sin TTL de catálogo | Validadores MongoDB no ejecutados positivamente |
| C34 | Sonda sin doble opt-in/puerto o replica set inválidos | Validador rechaza antes de sockets | Opt-in no sustituye autorización de instancia |
| C35 | Ejecución CLI sin permiso | Exit1, stdout vacío, error fijo sin secretos; sin conexión/DDL | No es prueba positiva MongoDB |
| C36 / F95-02 | Port void devuelve false | Falló antes con confirmed; ahora pending/alta rechazada | TypeScript no valida retornos runtime |
| C37 / F95-03 | Realm de servicio distinto al store/invalidator | Falló antes; constructor rechaza tras corrección, sin writes | Sin combinación de entornos por fallback |

## Garantías y fronteras de consistencia

1. D01: máximo un objeto de pertenencia; null/inactivo no concede cliente.
2. D02: índices únicos propuestos/verificados por metadata, con defensa ante duplicados leídos.
   El driver simulado no prueba unicidad real distribuida. IDs/principal no se cambian mediante CAS.
3. D03: usuario siempre incrementa versión al cambiar estado/pertenencia o invalidar. Cliente
   incrementa generación al cambiar estado. Una revinculación nunca resetea versión del usuario.
4. El lector compara generaciones de cliente en cada resolución, además de estado y pertenencia.
   Una sesión conserva el cliente y versión del usuario originales; no se transfiere silenciosamente.
5. La invalidación lógica precede al barrido de sesiones. Pending no concede acceso ni restaura
   estado; retry es acotado al realm/usuario/versiones anteriores. No hay reintento infinito automático.
6. El CAS usa predicado de snapshot completo, no solo `_id`; éxito de un doble no equivale a una
   garantía de atomicidad del servidor. Falta campaña real de replica set/procesos/errores parciales.
7. Una lectura final puede quedar obsoleta inmediatamente después; touch en vuelo y capacidad ya
   admitida pueden completar según D03. No hay cancelación instantánea ni transacción entre stores.
8. No existen hard-delete ni reset de versión en el writer. Prohibir por operación externa la
   reutilización de IDs, edición sin versión y restauración inconsistente de catálogo/sesiones.

## Inicialización/prueba real: aprobación aún bloqueada

La [sonda nueva](scripts/audit-catalogue-mongodb-local.ts) solo permite DB local nueva aleatoria,
cuatro colecciones propias, validadores/índices y fixtures sintéticos. Ambos opt-ins obligatorios,
puerto/replica set validados, sin MONGODB_URI del usuario. No se ejecutó positivamente.
Dos Connections en un proceso, altas/CAS/versionado/baja-reactivación y rechazo BSON son el
alcance preparado. Aún faltan dos procesos OS, failover, journal/majority, red/ACK, TTL de sesiones,
deadlines globales y matriz M01–M12. Sin instancia expresamente autorizada, detener ejecución real.

El operador debe aprobar topología/versión, acceso exclusivo, alcance DDL/fixtures/limpieza,
presupuesto temporal y recuperación si finally falla. Loopback no demuestra ausencia de túneles.
No se llama a Atlas ni a servicios de Google. No compartir secretos en logs/artefactos.

## Resultado final y recomendación

- 266 pruebas existentes reejecutadas y preservadas; 46 nuevas; **312/312**, cero fallos/skips/canceladas.
- npm ci/typecheck/build aprobados; diferencial HTTP **13/13** contra base0f3bb20 sin cambios.
- 52 módulos TS, cero any explícitos/ciclos runtime; app default alcanza13 módulos sin auth/catálogo.
- Tres hallazgos del código nuevo reproducidos, corregidos y cubiertos; sin altos/críticos locales abiertos.
- Recomendación: revisión técnica y futura publicación Draft cuando se autorice. Aprobación externa,
  prueba MongoDB real, contratos FE/BE/GIS, controles operativos y activación Preview siguen pendientes.
- Runtime productivo deshabilitado; health público, sin endpoints nuevos, sin acceso Atlas/credenciales
  reales. Sin commit/push/PR/ramas nuevas/despliegue. BE-09 no se marca Done; BE-10 no iniciado.
