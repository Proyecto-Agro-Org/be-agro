# BE-09.2B — Auditoría de seguridad de implementación local

18/11/2026. Base `efb79c21e792e71fa14915325ed84189bd119afc`, worktree dev.
Evaluación interna con fixtures y revisión de código; no pentest ni certificación.
Ver [implementación y comandos](INFORME_BE09_2B_IMPLEMENTACION_SESIONES.md) y
[matriz histórica con resultados B](MATRIZ_BE09_2A_DECISIONES_Y_PRUEBAS.md).

## Hallazgos y correcciones verificadas

| ID / severidad | Defecto reproducido | Corrección y evidencia |
|---|---|---|
| B-F01 / media | consumeChallenge podía esperar hasta vencimiento y retornar true usando el instante previo; login emitía sesión vencido el intento | Recheck antes y después del claim; el intento consumido no emite sesión. `audit regression: delayed challenge consumption...` falló antes y aprobó después; cero filas de sesión |
| B-F02 / alta | Relectura tras insert solo comparaba ID: una fila con mismo ID/digest y otro usuario/cliente podía emitir una respuesta ajena | Comparar realm, ID, digest, usuario, cliente, securityVersion, creación, absoluta e idle; `audit regression: persistence cannot substitute...` falló antes y aprobó después |

B-F02 es defensa frente a un adaptador incoherente/defectuoso; no se afirma que un
cliente HTTP pudiera modificar el store de este modo. Se reforzó también el touch
para rechazar cambios de binding o una extensión distinta de la solicitada.
Se completó la lectura estricta de las tres duraciones de entorno y se probó el
rechazo de vacíos, exponentes, unidades, espacios y valores fuera de rango.

Se corrigieron dos errores en pruebas nuevas: la petición HTTP de headers crudos
carecía de Host obligatorio y llegaba a rechazo 400 del parser antes del middleware;
se agregó Host para comprobar el 401 por duplicación. El test de cuerpo excesivo
contaba la verificación del login de preparación; se compara ahora con ese contador
inicial. No se modificaron tests anteriores ni contratos para ocultar fallos.

## Amenazas y evidencia

Las pruebas citadas se encuentran en `test/google-identity.test.js` (G) y
`test/sessions.test.js` (S). Pruebas BE-08/09.1 anteriores se mantienen íntegras.

| Amenaza / riesgo | Control y prueba local | Límite residual |
|---|---|---|
| Suplantación de usuario | Firma SDK + issuer/sub; G official SDK / issuer audience | Falta GIS/catálogo reales |
| Firma falsa / token manipulado | RS256, verificación RSA real offline; G invalid signature | Claves reales/cache/red no probadas |
| Issuer/audience/azp de otra app | Checks explícitos; G issuer audience authorized party | Configuración OAuth por entorno pendiente |
| Token malformado/alg none/jku | Header cerrado, longitud, endpoint de claves fijo; G malformed | El SDK y Node siguen requiriendo mantenimiento |
| Access token confundido con sesión | Store solo admite opaco canónico; G malformed, S malformed credentials | El Bearer opaco robado sí es usable |
| Replay de ID token/intento | Nonce firmado + claim persistente de un uso; S challenge replay | Atomicidad real aún por demostrar |
| Dos workers emiten por mismo intento | Dos factories y barrera sobre store compartido; S two service instances | No es una prueba distribuida de DB |
| Session fixation | Token nuevo generado por servidor, DTO no admite token/clientId; S opaque, Origin/DTO | Login perdido deja huérfana expirable |
| Session hijacking / robo de Bearer | 256 bits, hashes, TTL, logout; S opaque/revoking one session | TLS y cliente real pendientes; robo no queda resuelto |
| XSS | No token en logs/query ni consulta current; S complete isolated HTTP | JS/sessionStorage siguen expuestos; CSP/FE pendientes |
| Escalada horizontal | Sesión ligada a client/version, scoped repository; S scoped resource reads | Repositories físicos BE-02 pendientes |
| Usuario desconocido | Resolución issuer/sub confiable, sin JIT; S unknown inactive | Catálogo real pendiente |
| Cliente ausente/inactivo | 403 sin default; S unknown inactive/unassigned | Fuente real de pertenencia pendiente |
| Sesión expirada | Límites absoluto/idle y recheck tras awaits; S idle, expiry pending | Necesita reloj confiable/sincronizado |
| Sesión revocada | Lookup durable por admisión; S logout/separate worker | Consistencia del adaptador real pendiente |
| Cambio de pertenencia | Comparación de clientId/securityVersion; S membership version change | Catálogo debe versionar cambios de seguridad |
| Carrera logout/touch | Update condicional y binding inmutable; S revocation racing | No cancela operaciones ya admitidas |
| Mezcla entre requests | Capacidades privadas BE-09.1, doce requests A/B; S simultaneous HTTP | No cancela capacidades remotas instantáneamente |
| Fallos de almacenamiento | Error seguro 503; S repository catalogue verifier, HTTP storage failures | Puertos deben implementar deadlines y cancelación |
| Fallo de proveedor/claves | 503 sin diagnóstico, promesa fallida descartada; G key retrieval failure | Fetch/caché real y rotación pendiente |
| Fuga por logs/respuestas | Proyección DTO y BE-08 cerrado; S complete HTTP, storage metadata | Login debe entregar token al cliente; perfil es dato autorizado |
| Agotamiento de recursos | Body 16 KiB, token 8192, admisión obligatoria 429; S admission/oversized | Limiter compartido por operación solo como puerto; cuotas por identidad/IP y carga real pendientes |
| CSRF/cambio involuntario de cuenta | POST exige Origin exacto, JSON y nonce; S Origin/JSON/DTO | FE GIS y política de navegadores aún no integrados |
| Fila adulterada por adaptador | Schemas strict y binding exacto; S dos audit regression / metadata | Adaptadores siguen siendo frontera confiable de infraestructura |

## Resultados y límites de auditoría

- `npm ci`, typecheck, build y suite completa finalizaron con exit 0.
- **206/206 pruebas**: 160 anteriores preservadas + 46 nuevas; cero omitidas.
- Regresión HTTP comparada contra HEAD base: **13/13 iguales**, sin nuevos cambios.
- `git diff --check` sin errores. JSON de package/lock y grafo de imports revisados.
- AST de 35 archivos src sin tipos any; sin ciclos en imports estáticos; servicio
  de sesiones y SDK Google no son alcanzables desde el grafo de `src/app.ts`.
- Lock conserva todos los paquetes anteriores. SDK 11.3.4 compatible por engines
  con Node 24.19.0; `npm ls` coherente. `npm audit --omit=dev` reporta cero avisos
  conocidos; esto no demuestra ausencia de vulnerabilidades. Warning transitorio
  deprecado node-domexception 1.0.0 registrado, sin actualización ajena al alcance.
- Revisión de candidatos: sin secretos reales, .env, compilados, dependencias ni
  documentación local de referencia. Fixtures RSA efímeras solo en tests.
- Once originales/once copias y 21 respaldos verificados por SHA256; informe A
  íntegro y matriz A conservada antes del anexo. Frontend e ingesta sin cambios.

No se realizaron llamadas funcionales Google, Atlas o Vercel, tests contra DB,
pruebas de carga, análisis de navegador/XSS ni despliegues. No se valida la totalidad
de los 60 casos A como producto: el anexo distingue cobertura local, parcial y pendiente.
Las garantías de claim/touch/revocación dependen del contrato de un adaptador aún
inexistente. La inyección de puertos es privilegio de composición servidor, no una
frontera frente a código servidor malicioso. No hay bypass HTTP productivo conocido
en el alcance revisado; esto no constituye una garantía universal.

## Decisiones y riesgos que bloquean habilitación

1. Aprobar catálogo de usuarios/clientes e identidad estable, mapping BSON y
   persistencia compartida (BE-02), unique/TTL/retención, consistencia y deadlines.
2. Aprobar contratos FE/BE/BE-03: rutas, DTO, errores anidados, TTL/skew, semántica
   de recuperación/logout y política de sesiones múltiples. Actualmente se permiten
   múltiples challenges/sesiones independientes, una sesión como máximo por intento.
3. Resolver Client IDs/orígenes GIS y entornos. No hay selección por NODE_ENV implícita.
4. Implementar admisión compartida, cuotas y límites temporales antes de publicar
   rutas. Restringir un presupuesto global no sustituye políticas por identidad/IP.
5. Resolver defectos FE de generaciones/401, almacenamiento y errores anidados;
   evaluar XSS/sessionStorage y medidas CSP. No se modificó frontend.
6. Probar integración real en entorno aislado y Preview autorizado, con evidencia
   de SHA, entorno y configuración efectiva. No inferir Production/Preview por nombre.

Recomendación: lista para **auditoría final local BE-09.2C** y revisión del diff.
No autoriza publicación, montaje default ni autenticación productiva. BE-09 permanece
parcial y no se inicia BE-10. Git conserva HEAD, main y origin/dev; cambios sin stage.

## Resultado posterior de BE-09.2C — 18/11/2026

C-F01 (media): SDK imponía retry=true sobre defaults; corregido con interceptor
posterior al merge y retryConfig.retry=0. C-F02 (media): touch exacto no toleraba
max concurrente y una asignación tardía podía reducir idle; contrato y control
actualizados a extensión monótona acotada. Ambos se reprodujeron con tests fallidos
antes y aprobados después. Los hallazgos altos previos B siguen corregidos.

La suite final C aprobó **220/220** con 14 casos nuevos y conserva los 13/13 HTTP.
Rotación/caché SDK se ejercitan ahora offline con reloj y fetch controlados, sin
afirmar acceso o configuración Google reales. Audit completo, incluido desarrollo,
sin avisos conocidos; no hubo cambios de dependencias ni publicación.

Se confirma que un abort HTTP puede dejar una fila huérfana hasta expiración; no
hay token entregado/reemisión. Una operación ya admitida puede finalizar tras
logout; no se promete cancelación de snapshots/operaciones en curso. Validaciones
internas dentro de un puerto pueden ser normalizadas por BE-09.1 a 503: no se
garantiza 500 para toda salida malformada profunda. Los errores siguen sanitizados.

Sin hallazgos altos/críticos locales abiertos identificados. Recomendación actual:
revisión e integración de infraestructura inactiva, con gates externos aún abiertos;
no habilitar auth productiva. Véanse [auditoría C](INFORME_BE09_2C_AUDITORIA_FINAL.md)
y [matriz C](MATRIZ_BE09_2C_TRAZABILIDAD.md). El contenido B anterior se conserva como
evidencia histórica de su ronda, no como resultado del estado C.
