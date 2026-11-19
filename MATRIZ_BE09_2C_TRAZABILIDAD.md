# BE-09.2C — Matriz de trazabilidad y evidencia local

18/11/2026. Base efb79c2. Evidencia de ejecución: suite completa 220/220 y
comparación HTTP 13/13, descritas en el
[informe final](INFORME_BE09_2C_AUDITORIA_FINAL.md).

**Local** significa comprobado con tests/código local, no en producto real.
**Parcial** tiene control local pero mantiene gates externos. **Pendiente** no se
ejecutó. G = `test/google-identity.test.js`, S = `test/sessions.test.js`;
A = `test/authorization.test.js`. Los nombres C01…C14 son prefijos exactos de tests.

| Requisito | Amenaza | Control | Test | Evidencia | Estado | Riesgo residual |
|---|---|---|---|---|---|---|
| Firma Google | Perfil falso/firma manipulada | SDK verifica RS256; header cerrado | G official Google SDK / invalid signature | Fixtures RSA verificadas por SDK; 220/220 | Local | No GIS/cuentas reales |
| Issuer/audience/sub | Suplantación entre apps | Issuer admitido, aud fija, sub estable, azp | G issuer audience authorized party | Rechazos offline y proyección mínima | Local | Configuración real pendiente |
| Tiempo de ID token | Proof vencida o futura | exp/iat/nbf y skew acotado | G expiration/future issued-at | Bordes con reloj controlado | Local | Reloj sincronizado, política de skew aprobada |
| Nonce GIS | Replay/cambio de cuenta | Nonce firmado ligado al digest de intento | G nonce / S wrong nonce | Sin emisión por nonce ajeno | Parcial | Callback FE/GIS real pendiente |
| Tipos de credencial | Access token/perfil tratado como sesión | JWS estricto en proveedor; opaco en store | G malformed / S malformed credentials | No verified por objeto ni token arbitrario | Local | Bearer robado válido sigue siendo reproducible |
| Budget de claves | Amplificación por retries | Interceptor posterior al merge y retry=0 | G C01/C03 | C01 falló antes; 503 hace un solo fetch después | Local | Deadline total login y puertos aún pendientes |
| Rotación/caché | Clave obsoleta/fetch por kid arbitrario | Caché SDK por max-age; no URL desde JWT | G C04 | SDK/Gaxios reales, reloj simulado, dos fetch | Parcial | Red/cache headers reales y operación pendiente |
| Fallo de proveedor | Bypass al caer Google | Error 503, sin fallback verified | G key retrieval failure / C03 | Recovery posterior y diagnóstico descartado | Local | SLO de proveedor no medido |
| Entropía/hash | Predicción/filtración en DB | crypto32 y SHA256; solo digest | S opaque / C09 | IDs y tokens distintos, store sin secretos originales | Local | Auditoría del almacén real pendiente |
| TTL challenge | Intento vencido aceptado | Recheck antes/después de claim | S delayed challenge consumption | Regresión B conservada | Local | Operación DB debe cumplir predicado |
| Unicidad del claim | Login simultáneo duplicado | Consumo atómico condicional | S two service instances / challenge replay | Un ganador con barreras | Parcial | Atomicidad distribuida aún no demostrada |
| Fallo parcial | Retry reemite sesión | Claim no se revierte; intento nuevo | S failed insertion / C05 | Lost ack produce 503 y retry rechazado | Local | Puede quedar sesión huérfana por pérdida de respuesta |
| Snapshot de emisión | Usuario/cliente sustituido | Binding completo tras insert | S persistence cannot substitute | Regresión B conservada | Local | Store y catálogo son fronteras confiables |
| Idle concurrente | Renovación vieja acorta/rechaza nueva | Max atómico, bounds y binding inmutable | S C02 | Falló antes; dos admisiones válidas después | Parcial | Adaptador persistente debe implementar max real |
| Expiración sesión | Fila vencida aún autoriza | Absoluta/idle revisadas en admisión | S idle expired / C08 | Expiración durante await invalida permanentemente capacidad | Local | Reloj de workers confiable |
| Revocación | Reutilización tras logout | Durable por digest/realm; lookup en admisión | S separate worker / C13 | Nueva autenticación/autorización rechazada | Parcial | Consistencia real pendiente; no cancela I/O iniciado |
| Touch vs logout | Resurrección de fila | Condicional activo; no borrar revokedAt | S revocation racing with touch | Barreras, rechazo tras revoke | Parcial | Atomicidad real pendiente |
| Contexto request | Async viejo o cerrado revive identidad | WeakMaps, generación y lease BE-09.1 | S C06/C07; A regresiones previas | Request cerrado rechazado; B no sustituido por A tardío | Local | No cancela cómputo remoto por sí mismo |
| Requests abortados | Respuesta tardía/token expuesto | Guardia de response y claim consumido | S C14 | HTTP abort observado, sin token entregado/reemisión | Local | Fila huérfana hasta limpieza/expiry |
| Pertenencia | Usuario desconocido o sin cliente | Catálogo issuer/sub, sin JIT/default | S unknown inactive / C10 | Email igual no mezcla principales/clientes | Parcial | Catálogo real BE-02 pendiente |
| Cambio de cliente | Transferencia silenciosa/estado obsoleto | Binding clientId + securityVersion revalidado | S membership version change | Vieja sesión rechazada | Parcial | Versionado real de cambios confiable |
| Aislamiento recursos | IDOR/escalada horizontal | Scope por cliente en cada repository | S scoped resource reads; A jerarquía | 404 ajeno y filtros registrados | Parcial | Consultas BSON/DB no implementadas |
| A/B simultáneos | Fuga de contexto entre clientes | Capacidad privada por request | S simultaneous HTTP / C09 | Requests/sesiones concurrentes con scope propio | Local | Cachés/generaciones FE pendientes |
| Credenciales múltiples | Parser ambiguo/reemplazo de sesión | Rechazo headers duplicados/combinados | S real duplicate Authorization | HTTP crudo con Host y duplicación →401 | Local | Topología proxy real debe preservar/rechazar ambigüedad |
| IDs públicos/body/cookie | Scope seleccionado por atacante | Solo Authorization y catálogo confiable | S C11 | Headers B/cookie B no alteran cliente A; body token 400 | Local | Endpoints futuros deben usar el mismo mecanismo |
| Origin/CSRF | Login no solicitado | POST Origin exacto, JSON y nonce | S Origin/JSON/DTO | 403/415 sin escribir; preflight sin credentials | Parcial | Flujo browser GIS y contrato FE pendientes |
| Recursos por request | DoS/cuerpos excesivos | Parser 16 KiB y admisión explícita | S admission / oversized | 429/413/503 comprobados | Parcial | Limiter distribuido, dimensiones y deadlines pendientes |
| Errores/logs | Secretos/stack/otro cliente al sink | Frontera callPort + DTO cerrado BE-08 | S C12 / complete isolated HTTP | String/objeto/cause/Proxy →503 seguro, no-store | Local | Sanitización no reemplaza seguridad del sink desplegado |
| Config fail-closed | Defaults inseguros/mocks activos | Config explícita obligatoria; router no montado | S config/default app; AST grafo | Health público, auth/demo 404, SDK no alcanzable | Local | Montaje futuro requiere revisión de composición |
| Reproducibilidad/deps | Dependencia vulnerable/no reproducible | Lock fijo, npm ci, auditoría y revisión efectiva SDK | C01/C03/C04; npm audit | Dos rondas ci; audit completo cero avisos conocidos | Local | Ausencia de avisos no certifica seguridad |
| Compatibilidad existente | Regresión health/CORS/error | Comparación de 13 módulos y 13 casos HTTP | Comparador contra efb79c2 + suite | 13/13 iguales; 206 anteriores preservadas | Local | No prueba plataforma remota |
| Frontend y XSS | Robo de Bearer/401 viejo/storage | Gates y riesgos explicitados, sin cambio FE | Análisis A/B, C11/C12 solo backend | No se ejecutan tests navegador/FE de aceptación | Pendiente | Tres defectos FE y sessionStorage siguen abiertos |
| Atlas/Vercel/E2E | Declarar producto seguro sin integración | Mantener rutas default desactivadas y gates | S default app / revisión de código | Sin acceso Atlas ni despliegues | Pendiente | Persistencia/GIS/Preview reales faltan |

No hay requisitos externos marcados completos. Los controles de store son
contratos probados con dobles: no modelos físicos ni garantía de una DB aún no
implementada. La revocación se aplica a nuevas admisiones y snapshots, sin
cancelación instantánea de requests ya admitidos.
