# BE-09.3 — Matriz de persistencia y seguridad

19/11/2026. Base 3ac72ab. [Informe](INFORME_BE09_3_PERSISTENCIA_Y_CATALOGO.md).
Ejecución: **252/252** pruebas, **13/13** escenarios HTTP equivalentes.
P/K/I son prefijos exactos en `test/authentication-persistence.test.js`.
**Local** = comprobado offline; **Parcial** = control local con gate real pendiente;
**Pendiente** = no implementado/ejecutado. No se certifica atomicidad distribuida.

| Requisito | Amenaza | Control | Test/evidencia | Estado | Riesgo residual / decisión |
|---|---|---|---|---|---|
| Namespace explícito | Escribir en telemetría o app ajena | Prefijo auth validado sin default + realm fijado | P01/P17 | Local | Aprobar nombre/db/aislamiento por deployment |
| No auto-DDL/conexión | Creación o conexión involuntaria | autoCreate/autoIndex/buffering false; factory exige conexión ya abierta | P02/P03/P15/P19; app sin import | Local | DDL posterior/creación implícita por servidor no queda monitorizada |
| Readiness | Repositorio sin unicidad | Lee índices y rechaza faltantes/partial/sparse/hidden/collation ajena | P03/P19 | Parcial | No se inspeccionó ningún índice real; sharding/topología pendiente |
| Crear sesión | Datos arbitrarios o escritura sin ACK | Zod, validate Mongoose e insertOne con ACK/ID esperado | P04/P06/P14 | Local | ACK/majority real y pérdida de respuesta requieren DB |
| Hash de Bearer | Robo de token en storage/log | Solo digest SHA256; input hex validado | P06/I01/I05 | Local | XSS/token robado en FE no resuelto por hash |
| Mapeo BSON | Confusión Date/number/_id | Mapper cerrado y validación de vínculo _id | P04/P16 | Local | Schema técnico propuesto, no Atlas observado |
| Duplicados | Sobrescritura o sesiones colisionantes | _id único + índice realm/digest; insert sin upsert | P05/P08/I03 | Parcial | Verificar índices reales sin sharding o equivalente |
| Consumo único | Replay o dos logins ganadores | updateOne condicional de nonce/estado/expiry | P07/P08/I03 | Parcial | Simulador con predicados atómicos no prueba servidor |
| Estado null escalar | Arrays/ausencias tratados como estado pendiente | $expr/$type de campo completo == null | P18 falla antes/aprueba después | Local | Defensa contra datos malformados; validators DB pendientes |
| Vencimiento challenge | Uso de intento expirado | Expiry cliente/$$NOW y rechecks BE-09.2 | P07; regresión B conservada | Parcial | Relojes/snapshot real y MongoDB pendientes |
| Pérdida de confirmación | Retry emite una sesión adicional | No retry de aplicación ni rollback del claim | P09; regresiones C conservadas | Local | Puede quedar escritura confirmada con respuesta perdida |
| Actualización idle | Renovación antigua acorta la nueva | findOneAndUpdate/$max + predicado activo | P10/P12 | Parcial | Concurrencia/failover reales pendientes |
| Expiración sesión | Resurrección por update tardío | Absoluta/idle/created y $$NOW; TTL no autoriza | P10/P13; 220 anteriores | Parcial | Snapshot de comando no es reloj continuo durante I/O |
| Revocación durable | Reutilización tras logout | Primera fecha, estado condicional, ACK, sin upsert | P11/I03/I05 | Parcial | Durabilidad/consistencia real no ejecutadas |
| Logout vs actividad | Guardar snapshot elimina revokedAt | Solo $max idle; condición no revocada | P12/P18 | Parcial | Requiere semántica MongoDB efectiva |
| Múltiples sesiones | Revocar otras sesiones del usuario | Selección exacta realm+digest | P11/P17 | Local | Política de máximo de sesiones aún de producto |
| Aislamiento de entorno | Revocar/autenticar desde otro namespace | Colecciones separadas y realm fijado | P17 | Local | Catálogo store debe respetar realm de su puerto |
| Store caído/conexión perdida | Bypass o espera en buffer | Error seguro, requireConnection, sin fallback | P14/P15/P19/K07/I05 | Local | Deadlines de red y presupuesto total pendientes |
| Catálogo mínimo | Inventar usuarios/clientes o roles | Puerto readonly, sin JIT ni models de dominio | K01/K03/I04 | Parcial | Store físico y provisioning bloqueados por BE-02 |
| Principal estable | Colisión de email reasigna usuario | Lookup exacto issuer/sub/realm | K02/K05 | Local | Aprobar source/mapping real del catálogo |
| Pertenencia ausente/revocada | Cliente default permite acceso | Estado activo y cliente existente desde membership | K03/K04/I02/I04 | Local | Flags deben ir acompañados de versionado en writer real |
| Salida maliciosa de catálogo | Respuesta de otro usuario/cliente | Validación de IDs y schema estricto | K05/K06 | Local | Adapters siguen siendo infraestructura confiable |
| Cambiar cliente/deshabilitar | Sesión vieja entra a otro cliente | BE-09.2 compara clientId/securityVersion por admisión | I02; tests BE-09.2 conservados | Parcial | Reasignación/versionado atómicos reales pendientes |
| Snapshot catálogo | Estado mutable o método sustituido | Queries y resultados congelados, métodos bound | K06/K08 | Local | No hay transacción entre usuario, cliente y sesión |
| Consulta de recursos A/B | IDOR o falta de scope | Capacidades BE-09.1 + filtros por clientId | I01 | Parcial | No se crean consultas físicas agronómicas BE-10 |
| Revocación permanente de catálogo | Reactivar flag revive sesión vieja | Contrato exige incrementar securityVersion en writer futuro | Análisis, sin writer nuevo | Pendiente | No prometer permanencia solo con active=false/true |
| Metadata de actualización | Pertenencia incoherente | updatedAt lógico y orden parent/membership | K06 | Local | Regla propuesta; BSON físico y concurrencia writer pendientes |
| Errores/logging | URI/token/stack/datos de otro cliente | callPort/errores seguros y sink BE-08 cerrado | K07/I05 | Local | Revisar configuración debug/sink reales antes de activar |
| DTO público | Exposición de _id/digest/version | Mapper HTTP BE-09.2 intacto | I05 | Local | IDs lógicos usuario/cliente sí son parte del DTO propuesto |
| Retención/TTL | Acumular rows o borrar antes de tiempo | TTL Date propuesto en expiry/absoluta | P02/P04; propuesta de índices | Pendiente | No se crea ni observa limpieza física; retención aprobable |
| Compatibilidad | Regresión health/CORS/errores | Default app intacta y comparación contra 3ac72ab | Suite 252; comparador 13/13 | Local | Preview remoto no probado |
| Dependencias | Cambios no justificados | Lock/package intactos, npm ci reproducible | Dos rondas de ci; typecheck/build | Local | Warning node-domexception heredado; no garantiza seguridad universal |
| Atlas y persistencia real | Declarar DB lista sin acceso | No acceso/credenciales; readiness opt-in | Revisión de factories y pruebas | Pendiente | Aprovisionamiento, replica set/índices y pruebas reales faltan |
| FE/BE-03/GIS/Vercel | Activar contratos incompletos | Router nuevo fuera del grafo de app; gates documentados | AST/grafo; 220 regresiones conservadas | Pendiente | Configuración GIS, FE, limiter, deadlines, E2E/Preview |

Nuevos: seis módulos src, una suite y dos informes. README actualizado.
No se modificaron contratos/servicios BE-09.2, puertos de autorización, modelos de
dominio, pruebas anteriores, frontend ni ingesta. Sin commit/push/PR/deploy.
Lista para auditoría y posterior integración de infraestructura inactiva; BE-09 parcial.

## Actualización BE-09.3A — 19/11/2026

**266/266 pruebas**, 14 nuevas; 13/13 HTTP. La evidencia anterior se preserva como
historia de BE-09.3. Guardias de identidad/tipo en mutaciones y ACK estricto
corregidos, con cuatro regresiones fallidas antes/aprobadas después. Arrays,
missing, duplicados lógicos, actividad fuera de orden y errores ampliados.

MongoDB real continúa sin ejecutar: no se identificó instancia local autorizada.
La sonda manual está compilada y su guard de no opt-in probado; no se afirma
unicidad/durabilidad/cleanup reales. Catálogo ambiguo oculto y consistencia
catálogo-sesión siguen pendientes. A10 demuestra que puede terminar un touch
después de deshabilitar catálogo aunque la autorización final sea rechazada.

Detalle de estados/riesgos en [matriz A](MATRIZ_BE09_3A_TRAZABILIDAD.md) e
[informe A](INFORME_BE09_3A_AUDITORIA_FINAL.md). Apta para revisión como
infraestructura deshabilitada, no para habilitación real. Sin commits ni publicación.
