# BE-09.0 — Matriz de autenticación y autorización

Fecha: 17/11/2026. Actualización BE-09.1: **infraestructura interna implementada;
autenticación real BE-09 pendiente**. Resultados actuales: 160/160 pruebas, 40 nuevas.
Base backend `63c7eb20882e1e63e9ed03e2b6afa0a91e124afc`; frontend
`daa72a828eb79aad0f09dcb7786a2c5a4adfd3bc`; integración
`422dc7aace5d1b6b3e895cb166f21ead4a7b52b8`.

E01…E14, F09-01…03 y G01…G06 remiten a
[INFORME_BE09_ANALISIS_AUTENTICACION.md](INFORME_BE09_ANALISIS_AUTENTICACION.md).
Estados: Confirmado (en código/documento o control Git), Ausente en código, Reproducido con dobles,
Propuesto, Pendiente externo, No verificado y Diseñado/no ejecutado.
Ningún estado Propuesto o Diseñado significa aprobado, implementado o probado.
Los riesgos altos futuros no acreditan una brecha de datos desplegada actualmente.
La sección B conserva el diseño de BE-09.0; la sección D registra la cobertura real
actual y las partes que siguen pendientes. Detalle en
[implementación](INFORME_BE09_1_INFRAESTRUCTURA_AUTORIZACION.md) y
[auditoría](INFORME_BE09_1_AUDITORIA_SEGURIDAD.md).

## A. Investigación, requisitos y decisiones

| ID | Descripción | Evidencia | Estado | Riesgo | Acción recomendada | Dependencia |
|---|---|---|---|---|---|---|
| R01 | Rama y base BE-09 correctas | Fetch/SHA BE-08; HEAD esperado | Confirmado | Bajo operativo | Mantener análisis local | BE-08 |
| R02 | FE inspeccionado sin modificarlo | HEAD dev limpio; huella de 184 archivos | Confirmado | Bajo operativo | Conservar versión trazable | Acceso local |
| R03 | Integración no contiene otro servidor auth en ese ref | E12, árbol completo no truncado y README/DoD | Confirmado en código | Evitar asumir proveedor oculto | Revisar otra implementación si el equipo la identifica | G01 |
| R04 | Login email/password del FE | E01/E05, POST /auth/login | Confirmado en código | Confundir UI con auth real | No implementar password paralelo por semejanza visual | G01/G05 |
| R05 | Google real | E01/E05/E08, package/index/source | Ausente en código inspeccionado | Alto si se acepta demo como credencial | Confirmar proveedor/flujo y obtener credencial verificable | G01 |
| R06 | Google demo limitado por flag | E01/E05/E08 | Confirmado en código | Datos demo públicos/reutilizables | No replicar endpoints/tabla demo en producción | G01 |
| R07 | Naturaleza del token real | E10 solo exige string | No verificado | Alto si se trata cualquier string como JWT válido | Definir y validar protocolo | G01/G02 |
| R08 | Transporte actual Bearer | E03/E04 | Confirmado en código | Robo de Bearer permite replay | Reutilizar transporte solo con validación servidor y política de sesión | G02 |
| R09 | Almacenamiento en sessionStorage | E02/E03 | Confirmado en código | Lectura por JS si hay XSS | Evaluar reducción de exposición/cookie según topología | G02/G06 |
| R10 | Cookies propias/credentials:include | E04 y búsquedas de fuente | Ausente en código de auth | Cookies no pueden adoptarse sin migración | Acordar FE/CORS/CSRF; default fetch same-origin no implica ausencia de toda cookie | G02/G06 |
| R11 | Recuperación identidad demo | E02/E05 | Confirmado en código | Tomar MSW como autoridad real | Mantener separado del endpoint real a aprobar | G05 |
| R12 | Recuperación real de identidad/validación al recargar | E02/E06 | Ausente en código | Token arbitrario puede abrir UI; no acceso probado a API privada | Acordar una operación de sesión/identidad | G02/G05 |
| R13 | Expiración observada por 401 | E03/E04 | Confirmado en código | No es verificación previa ni refresh | Autoridad de expiración en backend | G02 |
| R14 | 401 de request antiguo limpia sesión nueva | F09-01, microverificación sin red | Reproducido con dobles | Medio: cierre indebido de sesión actual | Asociar expiración al token/generación enviado; tarea FE separada | FE/G02 |
| R15 | Storage bloqueado deja transporte sin token | F09-02, tres módulos reales en memoria | Reproducido con dobles | Medio: UI/transporte inconsistentes | Fuente única de token o login fallido explícito | FE/G02 |
| R16 | Logout actual local | E02/E03/layout | Confirmado en código | Alto si un token real robado sigue autorizado | Revocar sesión servidor y limpiar cliente, sin revivir respuestas tardías | G02 |
| R17 | Logout servidor/revocación/refresh | E11 | Ausente en código | Alto antes de publicar negocio privado | Definir ciclo, no inventar refresh por anticipado | G02/G05 |
| R18 | Rutas protegidas FE | E06 | Confirmado en código | Guard solo de navegación | Mantener auth obligatoria en servidor | G01/G02 |
| R19 | Campos reales disponibles sin mocks | E07/Dashboard/EstadoSinCampo | Ausente en código | Integración real de vistas bloqueada | Acordar catálogo/endpoint y habilitar fuente real en FE | G03/G04/G05 |
| R20 | Preferencia local de campo no autoriza | E07, validación de lista vigente | Confirmado en código | Alto si backend confía en preferencia/query | Scope servidor, validar campo_id | G03/G04 |
| R21 | Scope por token/campo en MSW | E09 y pruebas de alcance leídas | Confirmado en código mock | No es enforcement backend | Trasladar invariantes a repositories, no copiar tokens demo | G03/G04 |
| R22 | App default autentica | E11; middleware interno BE-09.1 aún no montado | No implementado en producción | Bloquea montar negocio privado | Conectar proveedor/servicio reales tras gates; no habilitar fakes | G01/G02/G03 |
| R23 | Health público e independiente | E11, BE-08 | Confirmado en código | Sin datos privados que autenticar aquí | Preservar GET/HEAD/200 y ausencia de conexión | BE-08 |
| R24 | SDK/proveedor preexistente reutilizable | E01/E12, dependencies/búsquedas | No encontrado en fuentes | Crear segundo proveedor innecesario | Validar con equipo si hay otro sistema fuera de los repos analizados | G01 |
| R25 | Usuario interno ↔ identidad externa | E13, FE usuario_id | Propuesto; persistencia no verificada | Alto si email mutable es llave confiable | Catálogo por identidad verificada y política de alta/asignación | G01/G03/G04 |
| R26 | Usuario pertenece a un cliente | AGENTS/plan; E10 mock | Confirmado por acuerdo; datos reales pendientes | Alto si hay tenant vacío/default | Resolver asignación activa única en servidor | G03/G04 |
| R27 | Jerarquía cliente/campo/área/dispositivo/medición | AGENTS/plan/E13 | Confirmado por acuerdo | Alto IDOR si se salta un nivel | Verificar toda cadena dentro del repository | G04 |
| R28 | BSON/colecciones/índices físicos | E13, Atlas no autorizado | Pendiente externo | Alto si se inventan filtros/campos | Inspección física de lectura autorizada en BE-02 | G04/Atlas |
| R29 | clientid MQTT no es cliente empresarial | E13/ingesta documentada | Confirmado por análisis documental | Alto al confundir alias con tenant | Resolver correlación confiable separada | G04 |
| R30 | device_id/_id/alias MQTT equivalentes | E13 | No verificado; no asumir | Alto para cruces e históricos | Mapper/catálogo y propiedad temporal acordados | G04 |
| R31 | Significado de lotes | E13 | Pendiente externo | Modelo/alcance erróneos | No equiparar a campo/área ni introducir nivel obligatorio | G04 |
| R32 | Roles/permisos por endpoint | AGENTS/E10 | Fuera del alcance vigente | Escalada si se confía en role público | No implementar RBAC ni aceptar roles desde FE | Acuerdo de etapa |
| R33 | Contexto interno solo desde pipeline de puertos confiables | BE-09.1 servicio/middleware y tests | Implementado y probado internamente | Verificación criptográfica real sigue pendiente | Capacidad privada/runtime; adapter real antes de producción | G01/G02/G03 |
| R34 | Reader de referencias ligado obligatoriamente al cliente | BE-09.1 repository y tests de argumentos | Implementado con puerto simulado | Queries reales todavía requieren auditoría | Factory scoped y validación de padres; no se implementó Mongo | G03/G04 |
| R35 | Listas/count/agregados/populate/cachés con scope | Informe §15 | Propuesto | Alto filtrado parcial | Comprobar filtros en persistencia y claves de caché | G04 |
| R36 | Telemetría sin tenant/correlación ambigua | E13/informe §15 | Pendiente externo | Alto: asignación por inferencia | No exponer registros hasta tener vínculo autorizado | G04 |
| R37 | Identidad válida sin usuario/cliente activo | Informe §16 | Propuesto | Alto por tenant default | Denegar genéricamente; 403 candidato según flujo acordado | G03/G05 |
| R38 | Errores 400/401/403/404/500/503 y logs | BE-08, informe §16 | Propuesto para auth | Enumeración/confundir fallo técnico con credencial inválida | Adapter seguro, mensaje fijo, sin tokens ni causa | G05 |
| R39 | Lector FE acepta error:{code,message} | F09-03 | Incompatibilidad reproducida | Medio de compatibilidad | Migración BE-03/FE antes de cambiar envelope | G05 |
| R40 | Logout 204 consumido por apiFetch | E04 siempre consume JSON en éxito | Incompatibilidad por lectura de código | Error espurio en cierre correcto | Aprobar 200 JSON o adaptar consumo 204; no afirmar prueba ejecutada | G05/FE |
| R41 | Bearer opaco revocable | Informe §§11/13 | Propuesto, no aprobado | Store/ciclo y robo de token | Candidato si se confirma proveedor y transporte | G01/G02/G06 |
| R42 | Cookie HttpOnly | Informe §11 | Alternativa pendiente | CSRF/topología/cross-site | Evaluar con orígenes reales y cambio FE; no habilitar credentials globales | G02/G06 |
| R43 | JWT propio | Informe §§11/12 | Alternativa no preferida por ahora | Rotación/revocación/refresh | No instalar biblioteca antes de confirmar necesidad | G01/G02 |
| R44 | Sesión compartida entre workers | Informe §13 | Propuesto | Inconsistencia si se usa Map por proceso | Store aprobado; comprobar expiración aunque TTL no haya limpiado | G02/G04/G06 |
| R45 | Google verifica firma/issuer/audience/exp y subject | Informe §12, fuente oficial | Diseño condicionado, no ejecutado | Alto si se decodifica sin verificar | Adapter mantenido y fixtures, sin cuentas reales | G01/G06 |
| R46 | Flujo OAuth/cookie protegido contra CSRF/replay | Informe §§10/12 | Propuesto según alternativa | Alto si login se puede fijar/reutilizar | Nonce/state/CSRF/PKCE cuando corresponda, no mezcla indiscriminada | G01/G02/G06 |
| R47 | Configuración real Google/CORS/Vercel | No se consultó administración ni endpoints | No verificado | Bloqueo de integración real | Obtener evidencia autorizada de audience/orígenes/routing | G06 |
| R48 | Pruebas locales sin Atlas/Google | 40 casos BE-09.1; cobertura sección D | Implementadas/ejecutadas para infraestructura | No son validación del proveedor/DB reales | Mantener doubles fuera de src y probar integración después | G01…G05 |
| R49 | App/contratos previos intactos y sin dependencias nuevas | Diff/AST BE-09.1, package/lock idénticos | Confirmado | Bajo operativo | Infra nueva no montada; sin cambios de dominio | Alcance BE-09.1 |
| R50 | Preservar 120 pruebas BE-08 | npm test BE-09.1 | 160/160: 120 anteriores + 40 nuevas | Ninguna anterior eliminada/modificada | Repetir al conectar adapters reales | BE-08/09.2 futura |
| R51 | Documentos consistentes y sin secretos | Revisión y diff --check | Validado documentalmente | Bajo operativo | Mantener propuestas separadas de hechos | Este análisis |
| R52 | No modificar otros repos/ramas/informe BE-05 | HEAD/hash/status/huellas | Confirmado | Bajo operativo | Sin publicación, Atlas o credenciales de usuarios reales | Restricciones |

## B. Matriz de pruebas para implementación futura

Todos los casos de esta sección están **diseñados/no ejecutados**: no constituyen
tests BE-09 aprobados. El resultado esperado es propuesta de aceptación que debe
alinearse con BE-03. Fixtures de identidad, credencial, store y persistencia son
artificiales; los verificadores fake solo se inyectan desde pruebas.

| ID | Descripción | Evidencia de necesidad | Estado | Riesgo | Acción / resultado esperado | Dependencia |
|---|---|---|---|---|---|---|
| T01 | Credencial ausente/vacía/múltiple/malformada | E04, R22 | Diseñado/no ejecutado | Acceso anónimo | 401 fijo, no llamar repository de recursos | G02/G05 |
| T02 | Sesión válida y usuario/cliente activo | R26/R33 | Diseñado/no ejecutado | Rechazo o tenant incorrecto | Contexto confiable; filtros del cliente correcto | G02/G03 |
| T03 | Token alterado/firma inválida/algoritmo inesperado | R45 | Diseñado/no ejecutado | Falsificación | Verificador rechaza; nunca decode como prueba | G01 |
| T04 | issuer/aud/sub inválidos o ID token usado como otro token | R45, RFC de identidad | Diseñado/no ejecutado | Confusión de credenciales | Rechazo y ningún vínculo por email de entrada | G01/G06 |
| T05 | exp vencido, borde exacto y tolerancia de reloj | R13/R44 | Diseñado/no ejecutado | Uso después de vencer | Reloj inyectado; 401 aunque TTL no borró registro | G02 |
| T06 | Usuario desconocido/inactivo | R25/R37 | Diseñado/no ejecutado | Alta implícita/enum | Denegación uniforme, no crear usuarios | G03/G05 |
| T07 | Cliente inexistente/inactivo/sin asignar | R26/R37 | Diseñado/no ejecutado | Tenant default | 403 candidato, sin consultas privadas | G03/G05 |
| T08 | Manipular cliente_id/entityId/role en body/query/headers | R26/R32/R33 | Diseñado/no ejecutado | Escalada | Ignorar como autoridad o rechazar DTO; scope no cambia | G03/G05 |
| T09 | Campo ajeno, inexistente o campo_id duplicado | E09, R27 | Diseñado/no ejecutado | IDOR | 404 ajeno/inexistente; 400 formato/duplicado acordado | G04/G05 |
| T10 | Área ajena o no perteneciente al campo autorizado | R27 | Diseñado/no ejecutado | IDOR | 404 y consulta limitada a scope/cadena | G04 |
| T11 | Dispositivo de otra área/cliente | R27/R30 | Diseñado/no ejecutado | IDOR | 404 indistinguible; no recuperar otros tenants | G04 |
| T12 | Mediciones sin tenant, alias ambiguo o reasignación histórica | R30/R36 | Diseñado/no ejecutado | Exposición histórica cruzada | Denegar hasta vínculo seguro; no usar dueño actual sin política temporal | G04 |
| T13 | Dos clientes con alias/IDs externos que colisionan | R29/R35 | Diseñado/no ejecutado | Cache/lookup cruzados | Resolver por scope/catálogo o rechazar ambigüedad | G04 |
| T14 | Dos usuarios/tenants y requests simultáneos | R33/R35 | Diseñado/no ejecutado | Estado global compartido | Contextos/queries/resultados independientes por request | G02/G04 |
| T15 | Verificar filtros reales de repository/count/agregación/lookup | R34/R35 | Diseñado/no ejecutado | Solo testear controller oculta bypass | Spy de operaciones exige scope y relaciones, incluidas listas vacías | G04 |
| T16 | Body con operadores Mongo/objeto donde se espera ID | Informe §10/R34 | Diseñado/no ejecutado | Inyección de filtros | Zod/mapper rechaza; no spread hacia Mongo | G04/G05 |
| T17 | Logout y replay posterior del token | R16/R17 | Diseñado/no ejecutado | Sesión reutilizada | Revocación efectiva para requests posteriores; limpieza FE | G02/G05 |
| T18 | Logout repetido, sesión ya vencida y endpoint vacío | R40 | Diseñado/no ejecutado | Error espurio/enumeración | Resultado idempotente y JSON/204 acordado consumible | G02/G05 |
| T19 | Recarga con credencial válida/inválida | R12 | Diseñado/no ejecutado | UI autenticada sin identidad | Consultar operación real y bloquear vistas hasta resolver | G02/G05/FE |
| T20 | Logout/cambio de cuenta durante recuperación | E02 | Diseñado/no ejecutado | Respuesta tardía revive sesión | Generación/cancelación; identidad vieja descartada | FE/G02 |
| T21 | 401 de A tras guardar sesión B | F09-01 | Diseñado/no ejecutado | Cierre de B | Solo expira generación/token originario; no se repite bug | FE/G02 |
| T22 | Storage no disponible | F09-02 | Diseñado/no ejecutado | Token solo en UI | Falla explícita o token compartido por contexto/transporte | FE/G02 |
| T23 | Proveedor caído, claves rotadas o respuesta inválida | R45/R47 | Diseñado/no ejecutado | Fallback inseguro | Fallo cerrado, error técnico seguro; caché/rotación según adapter | G01/G06 |
| T24 | Mongo/store rechazado, lento o caída entre validaciones | R44 | Diseñado/no ejecutado | Confundir error técnico con sesión válida | Sin acceso privado; status técnico acordado | G02/G04/G05 |
| T25 | Tokens/passwords/claims/URI en errores y callbacks | BE-08/R38 | Diseñado/no ejecutado | Fuga por diagnóstico | Sinks reciben solo DTO permitido; no inputs/cause/PII | BE-08/G05 |
| T26 | Sesión revocada por baja o reasignación de usuario | R26/R44 | Diseñado/no ejecutado | Scope viejo sigue válido | Nueva validación/política invalida pertenencia anterior | G02/G03 |
| T27 | Cookie/CSRF/CORS/Origin adverso si se elige cookie | R10/R42/R46 | Diseñado/no ejecutado | CSRF | Fixture de navegador separado; credenciales/orígenes explícitos | G02/G06 |
| T28 | Autorización no depende de preferencias/mocks/flag demo | R06/R20/R33 | Diseñado/no ejecutado | Bypass productivo | Composición real no acepta tokens demo o contexto fabricado | G01/G03 |
| T29 | Error string/nested y estados 400/401/403/404/500 | F09-03/R38 | Diseñado/no ejecutado | Ruptura del cliente | Matriz FE/BE conjunta antes de migrar errores | G05 |
| T30 | Regresión health/CORS/default export/Mongoose/Zod/120 tests | E11/BE-08 | Diseñado/no ejecutado | Romper infraestructura | npm ci/typecheck/build/test/diff cuando haya implementación | BE-07/08 |

## C. Resultado de salida

La investigación y la documentación están listas. **BE-09 no está lista para
implementar autenticación definitiva** hasta resolver proveedor/flujo, transporte,
catálogo usuario-cliente y contratos mínimos. Atlas/BE-02 bloquean persistencia y
repositorios reales, no el diseño ni futuras pruebas con doubles.

No se implementaron componentes, modelos ni endpoints de autenticación en BE-09.0.
Se ejecutaron únicamente tres microverificaciones de investigación en memoria y
validaciones documentales; no se reejecutaron suites BE/FE ni se instaló nada.
Ese fue el cierre de BE-09.0. Los avances internos BE-09.1 se documentan debajo.
Sin Done, commit, push,
PR, merge, despliegue ni cambios de frontend/IoT/producción/Atlas.

## D. Cobertura vigente BE-09.1 de los 30 escenarios

Evidencia ejecutable: `test/authorization.test.js` (40 casos) y las 120 regresiones
anteriores. No se reemplaza una verificación criptográfica/consulta Mongo real por
un fake. Los estados indican el alcance real alcanzado, no aprobación del contrato.

| Escenario | Cobertura actual | Evidencia / pendiente |
|---|---|---|
| T01 | Cubierto internamente | Bearer ausente/vacío/array/duplicado/malformado, sin llamada al verificador |
| T02 | Cubierto con doubles | Identidad y pertenencia activas; capacidad/scope emitidos |
| T03 | Parcial | Verificador simulado rechaza; firma/algoritmos reales requieren proveedor |
| T04 | Pendiente del proveedor real | source estático y objeto no forjable; no se validan issuer/aud criptográficos aquí |
| T05 | Cubierto internamente | Vencimiento, borde exacto, mínimo de expiraciones, reloj/lease y no reactivación |
| T06 | Cubierto con doubles | Usuario null/inactivo → FORBIDDEN; sin asignación default |
| T07 | Cubierto con doubles | Membresía null/inactiva → FORBIDDEN; no catálogo físico real |
| T08 | Cubierto internamente | Ignora req.user/body/query/X-Client; rechaza campos extra de puertos |
| T09 | Parcial | Campo ajeno/inexistente e ID malformado; DTO público/duplicados campo_id pendientes BE-03 |
| T10 | Cubierto con doubles | Padres de área y propiedad dentro del scope, 404 fijo |
| T11 | Cubierto con doubles | Device ajeno y cadena inconsistente, sin consulta fuera de scope |
| T12 | Parcial | Referencias measurement y padres probados; correlación física/reasignación histórica pendiente BE-02 |
| T13 | Parcial | IDs lógicos coincidentes A/B filtrados; aliases MQTT reales no comprobados |
| T14 | Cubierto internamente | 12 requests de dos clientes, async/stale y scopes independientes |
| T15 | Parcial | Argumentos de findResource congelados y scoped; sin count/aggregate/lookup Mongo reales |
| T16 | Parcial | IDs objeto/operadores rechazados; no queries Mongo ni DTO de filtros productivos |
| T17 | Parcial | Mock revoke invalida nuevas autenticaciones; no endpoint/logout real |
| T18 | Pendiente G02/G05 | Contrato revoke definido; sin protocolo HTTP de logout/idempotencia |
| T19 | Pendiente FE/G02/G05 | No implementación de recuperación real ni cambios de navegador |
| T20 | Parcial | Servidor descarta auth/contextos tardíos y requests cerrados; UI no modificada |
| T21 | Pendiente FE | F09-01 sigue abierto; no se afirma corregir apiFetch |
| T22 | Pendiente FE | F09-02 sigue abierto; no se modifica storage de FE |
| T23 | Parcial | Excepciones de verifier → 503 y output malformado → 500; no JWKS/rotación reales |
| T24 | Parcial | Fallos de puertos y consulta pendiente con invalidación; sin DB/timeout universal |
| T25 | Cubierto internamente | Tests HTTP BE-08 sin tokens/diagnósticos en respuestas ni sink |
| T26 | Parcial | Inactivos en resolución y revocación simulada; política de cambio en request en vuelo pendiente |
| T27 | Pendiente G02/G06 | No cookies ni CSRF nuevos; CORS existente se conserva por regresión |
| T28 | Cubierto para app actual | No nuevas rutas ni wiring auth/fakes en default; mocks solo test |
| T29 | Parcial | 400/401/403/404/500/503 probados con envelope BE-08; nested FE/contrato final pendientes |
| T30 | Cubierto localmente | 160/160; typecheck/build; diferencial 13/13 contra BE-08 |

Resultado vigente: infraestructura lista para revisión/auditoría y futuro PR Draft,
sin publicar. BE-09 real y BE-09.2 requieren cerrar los gates; no están Done.
