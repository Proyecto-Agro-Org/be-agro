# BE-09.2A — Matriz de decisiones, amenazas y pruebas

17/11/2026. Base BE dev `efb79c21e792e71fa14915325ed84189bd119afc`.
[Diseño y flujo completo](INFORME_BE09_2A_DISENO_AUTENTICACION_REAL.md).
**Matriz de diseño, no aprobación ni suite de autenticación productiva ejecutada.**

Estados cerrados de clasificación: **Confirmado**, **Decisión técnica propuesta**,
**Pendiente de aprobación**, **Bloqueado por evidencia**, **No aplicable**.
Confirmado significa evidencia acotada indicada en la fila, no aprobación de una
solución futura. No aplicable a cookies se entiende condicionado a elegir C.

## A. Decisiones y evidencia

| ID | Punto | Clasificación | Evidencia / decisión propuesta | Condición para BE-09.2B |
|---|---|---|---|---|
| C01 | Rama/base/estado inicial BE | Confirmado | Worktree dev indicado, HEAD/origin dev efb79c2, limpio tras fetch | Conservar base y no publicar en A |
| C02 | API real actual | Confirmado | src/app.ts monta solo health y BE-08; no login real | No presentar propuestas como endpoints existentes |
| C03 | Infraestructura BE-09.1 | Confirmado | Puertos, capacidades privadas, lease, scope, tests; no wiring en app | Reutilizar sin duplicar contexto global |
| C04 | FE observado | Confirmado | daa72a8 limpio; Bearer/sessionStorage, Google MSW, identidad demo | No confundir token/guard UI con autenticación servidor |
| C05 | F09-01 | Confirmado | Microcaso hoy: 401 A borra B | Corregir snapshot/generación FE antes de rollout |
| C06 | F09-02 | Confirmado | Microcaso hoy: storage denegado elimina credencial del transporte | Memoria primaria y persistencia auxiliar coherente |
| C07 | F09-03 | Confirmado | Microcaso hoy: error anidado produce [object Object] | Parser dual FE + DTO aprobado |
| C08 | Recuperación/logout FE | Confirmado | Recuperación solo mock y logout solo local; fetch JSON obligatorio | GET session y revocación/204 reales |
| C09 | Fuente de campos | Confirmado | CampoProvider depende de MSW y /auth/demo/campos | No ampliar auth con endpoints de dominio ficticios |
| C10 | Catálogo usuario-cliente/BSON | Bloqueado por evidencia | BE-02 es propuesta, sin Atlas comprobado | Responsable DB confirma catálogo, escritores, IDs y vínculos |
| C11 | Sistema existente en agro | Bloqueado por evidencia | Conector no accede, web no obtuvo fuente, sin checkout local | Confirmar si hay IdP/sesión reutilizable antes de añadir otro |
| D01 | Proveedor GIS | Decisión técnica propuesta | Google para identidad; backend verifica ID token; no APIs Google | Ratificación equipo/proyecto OAuth |
| D02 | Transporte C, opaco Bearer | Pendiente de aprobación | Principal por compatibilidad; acepta riesgo XSS de secreto JS | Equipo acepta riesgo o elige cookie B antes de implementación |
| D03 | Sesión durable | Decisión técnica propuesta | Store compartido; digest, no raw token; sin memoria como autoridad | Aprobar store/entorno/configuración |
| D04 | Duraciones | Pendiente de aprobación | 8 h absoluta, 30 min idle, challenge 5 min, skew 60 s | Acordar UX y probar bordes; no asumir defaults SDK |
| D05 | Challenge con nonce | Decisión técnica propuesta | ID/nonce por intento, consume atómico; no cookie implícita | Contrato y store del intento aprobados |
| D06 | Cuatro rutas y DTOs | Pendiente de aprobación | Challenge, login, session, logout; no /me/verify/refresh duplicados | FE/BE y D03-01/10/11 |
| D07 | Envelope anidado solo nuevas rutas | Pendiente de aprobación | Categorías BE-08, parser FE compatible con legado | D03-04 y composición scoped; no cambio global |
| D08 | Sesión ligada a cliente/version | Decisión técnica propuesta | No cambiar tenant silenciosamente con sesión vieja | Lectura consistente y versión confiable; actualización administrativa |
| D09 | SessionReference en pertenencia | Decisión técnica propuesta | Conservar referencia privada y resolver usuario+sesión, resultado discriminado | Cambiar contrato interno/tests en B; no confiar en excepción que callPort vuelve 503 |
| D10 | Revocación para usuario desactivado | Decisión técnica propuesta | Logout por digest, independiente de requireClient/usuario activo | Revocar solo secreto presentado, idempotencia y fallos confirmables |
| D11 | Aprovisionamiento | Pendiente de aprobación | Preaprovisionado; sin alta JIT ni enlace por email | Responsable de usuarios/datos y unicidad issuer/sub |
| D12 | Esquema/índices de auth | Bloqueado por evidencia | auth_sessions/challenges son nombres candidatos, no colecciones reales | Aprobar modelo, BSON, índices/provisión y permisos |
| D13 | SDK concreto | Bloqueado por evidencia | Oficial google-auth-library propuesto; no instalado ni versión probada | Elegir/pinar y comprobar Node24/ESM, errores/timeout y fixtures |
| D14 | Orígenes/client IDs/topología | Bloqueado por evidencia | No hay inventario autorizado de entornos efectivos | Infra aporta configuración pública/alcance sin compartir secretos |
| D15 | CSRF/CORS de POST auth | Decisión técnica propuesta | Origin exacto obligatorio + JSON + nonce; no cookies de sesión paralelas | FE-browser-only y política aprobada; preflight real |
| D16 | Cookie HttpOnly de sesión | No aplicable | No se activa bajo C; si se elige B, cambiar transporte y habilitar pruebas CSRF/cookies | No considerar B descartada universalmente |
| D17 | JWT propios/passwords | No aplicable | No necesarios para el diseño propuesto; fuera de alcance | No agregarlos como atajo |
| D18 | Refresh/logout-all públicos | No aplicable | V1 propuesta sin refresh; current logout, revocación global administrativa | Ampliación exige necesidad y contrato nuevos |
| D19 | Memoria FE + sessionStorage | Pendiente de aprobación | Compatible con recarga; si falla storage, sesión solo hasta recarga | Corregir FE, probar modo/identidad y aceptar XSS residual |
| D20 | Observabilidad compartida | Decisión técnica propuesta | Un UUID/sink; handler seguro BE-08 solo en auth | Inyección/control de composición y regresión; no duplicar observadores |
| D21 | Revocación en vuelo | Pendiente de aprobación | Nuevas admisiones rechazan; requests ya admitidos pueden terminar | No prometer cancelación retroactiva o linealizabilidad de dominio |
| D22 | Límites y presupuesto I/O | Pendiente de aprobación | Deadline inicial 10 s; rate limit distribuido, dimensiones confiables | Infra/privacidad/capacidad, no contador por worker ni XFF libre |
| D23 | Configuración Vercel efectiva | Bloqueado por evidencia | main productiva según confirmación previa; settings no inspeccionados | Preview autorizado, dominios/variables/DB y humo real |
| D24 | Tests diseñados | Decisión técnica propuesta | T2A-01…60, deterministas offline antes de servicios reales | No declarar ejecución o cobertura real solo por esta tabla |
| D25 | Preparación de código A | Confirmado | Ninguna; interfaces base existen y extensiones dependen del diseño propuesto | Evita fijar proveedor/store prematuramente |
| D26 | Resultado previo 160/160 | Confirmado | Antecedente de dev validada; suite BE/FE no reejecutada en A | Volver a ejecutar al cambiar código en B |

## B. Amenazas, controles y evidencia necesaria

Severidad indica impacto potencial del diseño futuro, no explotación constatada.
Los controles son propuestas pendientes salvo las guardas internas ya probadas de BE-09.1.

| Riesgo / escenario | Impacto potencial | Control propuesto | Prueba | Dependencia externa |
|---|---|---|---|---|
| R01 Suplantación por perfil/email JS | Acceso no autorizado, alto | Firma/claims servidor y principal issuer/sub, sin enlace por email | T2A-01/02/14/32 | Proveedor/config y catálogo |
| R02 Token manipulado/algoritmo/kid malicioso | Identidad falsa, alto | SDK mantenido, política cerrada, no URLs de claves del token | T2A-02/06/37 | SDK/metadata pública |
| R03 Audience/issuer incorrectos | Confusión de aplicación, alto | Valores estáticos por entorno; no seleccionados por request | T2A-04/05/08 | Client IDs reales |
| R04 Expiración/reloj mal controlado | Aceptación de credencial vieja, alto | Bordes exp/iat/nbf, skew explícito y nonce vigente | T2A-03/07/52 | Reloj/SDK |
| R05 Replay de ID token/intento | Emisiones repetidas, alto | Nonce ligado a intento y claim atómico único | T2A-07/09/10/55 | Store consistente |
| R06 Login CSRF/cambio de cuenta forzado | Víctima opera cuenta ajena, alto | Intento FE activo, Origin/JSON, nonce, sin callback arbitrario | T2A-08/42/59 | FE GIS/orígenes |
| R07 Session fixation | Sesión elegida por atacante, alto | Secreto nuevo servidor; no token/sid elegido por navegador; no reutilizar token previo | T2A-15/54 | Entropía/servicio de emisión |
| R08 Session hijacking y replay Bearer | Uso de sesión robada, alto | TLS, almacenamiento mínimo, vencimiento y revocación; reconocer que posesión permite replay | T2A-17/18/19/44 | FE/CSP/despliegue |
| R09 IDOR/escalada horizontal | Datos de otro cliente, alto | Binding servidor, IDs/padres persistidos y filtro scoped dentro de query | T2A-28/29/49 | BE-02/queries reales |
| R10 Cliente/rol en body/header | Alcance falso o escalada, alto | No usarlo como autoridad, no roles nuevos; cliente desde catálogo verificado | T2A-28/32/33 | Contrato FE/BE |
| R11 Cambio de pertenencia con sesión previa | Tenant incorrecto, alto | Binding clientId/securityVersion y resolución vinculada a SessionReference | T2A-30/31 | Administración confiable/DB |
| R12 Revocación en worker equivocado | Logout ineficaz, alto | Store compartido, sin caché positiva de sesión por worker | T2A-19/20/47/58 | Persistencia durable |
| R13 Logout solo local o DB caída | Falsa garantía de cierre, alto | 204 solo tras resultado confirmable; avisar 503/red, retry explícito | T2A-20/21/22/50 | FE/store |
| R14 XSS con sesión JS | Exfiltración/acciones autenticadas, alto | Aceptación consciente del riesgo C, CSP y prevención XSS; alternativa B antes del rollout | T2A-44 | FE/dependencias/topología |
| R15 CSRF por cookies futuras | Mutaciones ambientales, alto | No aceptar cookies en C; si B, CSRF + SameSite + Origin y credentials controlados | T2A-40/42/43 | Decisión B y dominios |
| R16 401 o éxito viejo contamina nueva identidad | Cierre erróneo/mezcla UI, medio-alto | Generación + snapshot de credencial, cancelación y limpieza de datos | T2A-24/27/59 | Cambios FE |
| R17 Storage denegado/recarga incompleta | Estado incoherente, medio | Fuente memoria única; bootstrap GET session; error de red no equivale a 401 | T2A-23/25/38 | FE/navegador |
| R18 Logs/errores con secretos | Robo de sesión/identidad, alto | DTO cerrado, sin headers/body/claims/raw error; mensajes catálogo | T2A-26/39/48 | Sinks/plataforma |
| R19 Proveedor/red/JWKS caídos | Denegación o bypass, alto | Timeout/fallo cerrado, distinción 401/503 y refresh de clave acotado | T2A-36/37/38/46 | Red/SDK/infra |
| R20 TTL/idle/update compiten con logout | Sesión revive, alto | Expirar por predicado; update condicional sin quitar revokedAt | T2A-18/57/58 | Operaciones atómicas DB |
| R21 Entornos/Preview mezclados | Tokens válidos donde no deben, alto | Audience/source/env/DB/orígenes separados, sin wildcard Preview | T2A-05/08/40/41 | Infra/Vercel |
| R22 Fallos parciales y respuestas perdidas | Sesiones huérfanas/reintentos duplicados, medio | Claim único y fallo cerrado; intento nuevo, no recuperar secretos viejos; TTL limita huérfana | T2A-11/55/56 | FE/store y deadline |

## C. Matriz de pruebas BE-09.2B (diseño)

**Todas las filas T2A siguientes están diseñadas, no ejecutadas en A.** Los casos
criptográficos requieren el adapter real/fixtures offline; un verifier fake solo
prueba orquestación. No hay credenciales reales ni llamadas Google/Atlas/Vercel en A.

| ID | Caso y expectativa | Nivel / doble determinista | Gate |
|---|---|---|---|
| T2A-01 | ID token de fixture válido, usuario/cliente preaprovisionados → sesión completa | Adapter offline + servicio, reloj fijo | D01/03/11 |
| T2A-02 | Firma alterada → 401, sin lookup/alta/sesión | Verificador real con fixture/key-fetch controlado | D13 |
| T2A-03 | exp exacto/vencido → rechazo según política, sin sesión | Verificador + reloj de borde | D04/13 |
| T2A-04 | Issuer ajeno/rechazo de normalización ambigua → 401 | Fixture de claims/verificador | D01/13 |
| T2A-05 | Audience otra app/entorno, array no aprobado o azp distinto → 401 | Fixtures por configuración | D01/14 |
| T2A-06 | alg inesperado, none, kid ausente/desconocido, jku remoto → no aceptación ni fetch arbitrario | Adapter/key-fetch simulado | D13 |
| T2A-07 | Nonce faltante/ajeno/vencido no emite sesión | Store de intento + verificador | D05 |
| T2A-08 | challenge_id de otro intento/entorno/cliente OAuth falla | Store/env fijos + FE generación | D05/14 |
| T2A-09 | Repetir mismo ID token+challenge consumido → sin segunda sesión | Store simulado con claim atómico | D05 |
| T2A-10 | Dos workers finalizan mismo challenge simultáneamente: solo un ganador | Barrera sin sleeps, store compartido | D03/05 |
| T2A-11 | Claim gana pero insert sesión falla: 503, intento consumido, no token entregado | Falla inyectada entre operaciones | D03/05 |
| T2A-12 | Principal verificado sin usuario conocido/inactivo → 403 genérico, sin alta JIT | Catálogo fake; luego DB aislada | D11 |
| T2A-13 | Usuario sin cliente/inactivo → 403, sin tenant default/token | Resolver de pertenencia | C10/D11 |
| T2A-14 | Email coincide con otra cuenta; issuer/sub distintos no enlazan | Dos identidades y un catálogo | D11 |
| T2A-15 | Emisión usa entropía servidor, solo digest persistido; no acepta sid/token públicos | Entropía fija exclusivamente test, store capturable | D03 |
| T2A-16 | Opaco vigente → identidad privada y scope cliente correctos | Servicio BE-09.1 adaptado + store | D08/09 |
| T2A-17 | Expiración absoluta en borde y lectura tardía → 401 | Reloj fijo y avance controlado | D04 |
| T2A-18 | Idle expirada no puede extenderse; actividad no supera absoluta | Operación condicional store | D04 |
| T2A-19 | Sesión revocada rechazada en un worker diferente | Dos instancias, store compartido | D03/21 |
| T2A-20 | Logout actual persiste revocación y devuelve 204; siguiente admisión falla | HTTP loopback + store | D06/10 |
| T2A-21 | Logout repetido/ausente/desconocido/expirado → 204, sin revocar otras sesiones | Tokens artificiales y store determinista | D06/10 |
| T2A-22 | Fallo/timeout de store al logout → 503/no garantía falsa de revocación | Falla inyectada; UI de cierre no confirmado | D10/22 |
| T2A-23 | Recarga válida hace GET session antes de habilitar rutas y obtiene identidad completa | Test FE con transporte fake | D06/19 |
| T2A-24 | 401 viejo de A no elimina sesión B ni muestra expiración de B | Regresión FE del microcaso F09-01 | C05 |
| T2A-25 | Storage denegado tras login: transporte usa memoria; recarga sin persistencia pide login | Regresión FE F09-02, storage que arroja | C06/D19 |
| T2A-26 | Errores string legado/objeto nuevo/malformado se muestran seguros | FE parser, F09-03; sin toString arbitrario | C07/D07 |
| T2A-27 | Sesiones A/B concurrentes no mezclan identidad, cliente ni caché | Barreras FE/BE, dos requests | D08/19 |
| T2A-28 | cliente_id/entityId/roles en body/query/header no amplían alcance | Inputs hostiles sintéticos | D08/11 |
| T2A-29 | IDs colisionantes y jerarquía campo/área/device/medición ajena → 404 | Puerto scoped; luego consultas DB aisladas | C10 |
| T2A-30 | Cambiar clientId/version invalida sesión vieja; no entra al nuevo tenant silenciosamente | Resolver vinculado a sesión, carrera controlada | D08/09 |
| T2A-31 | Desactivar/revocar globalmente invalida nuevas admisiones, sin prometer cancelar las ya iniciadas | Versiones/2 workers y punto de admisión | D08/21 |
| T2A-32 | Principal/source de app solo procede de fila de sesión válida, no IDs públicos | Adapter y namespaces fijos | D09 |
| T2A-33 | Objetos/copias/capacidad de otra instancia no autorizan | Regresiones BE-09.1 conservadas | C03 |
| T2A-34 | Cierre o generación obsoleta no revive identidad; next error no se propaga dos veces | Promesas/barreras BE-09.1 | C03 |
| T2A-35 | Vence o cierra mientras espera un lookup: no entrega recurso/contexto | Reloj y puerto diferido | C03/D04 |
| T2A-36 | Fetch de claves cae: 503 seguro, no fallback verified | Key-fetch tipado artificial | D13/22 |
| T2A-37 | Rotación de clave/kid nuevo: refresh acotado; fallo no produce bypass | Fixtures públicos + cache/contador controlado | D13 |
| T2A-38 | Store caído/red produce 503 y no se confunde con 401 ni borra sesión FE válida | Errores tipados, FE transporte | D03/19 |
| T2A-39 | Tokens/cookies/nonce/perfil/stack/URI no llegan a respuesta de error ni sink | Marcadores artificiales, sink capturable | D07/20 |
| T2A-40 | Origin exacto permitido y OPTIONS correctos; sin credentials/wildcard auth | HTTP loopback | D14/15 |
| T2A-41 | Origin denegado/null/ausente en POST no muta store; health sin Origin conserva contrato | HTTP y contador de escrituras fake | D15 |
| T2A-42 | Form/text/plain/callback ajeno no establece sesión ni cambia cuenta | Test FE/HTTP de login CSRF, sin navegador real en A | D05/15 |
| T2A-43 | Solo si se elige B: atributos cookie/CSRF/credentials/origen/borrado en logout | Suite alternativa condicional; no declarar ejecutada en C | D16 |
| T2A-44 | Modelo C reconoce secreto legible por JS; validar CSP y ausencia de almacenamiento extra | Inspección FE/headers, no certifica inmunidad XSS | D02/19 |
| T2A-45 | Body/credential sobredimensionados, JSON malformado/primitivo y tipo no admitido → 400/413/415 seguros | Parser scoped + límites de DTO aprobados | D06/20 |
| T2A-46 | Límite por dimensión confiable compartido entre workers → 429, sin error con input | Limiter fake/clock, sin XFF libre | D22 |
| T2A-47 | Cold starts/instancias no requieren memoria de usuario compartida ni pool por request | Dos factories y un store, imports sin I/O | D03 |
| T2A-48 | Errores auth mapean 401/403/503, UUID/sink único y health/legacy inalterados | Integración BE-08 scoped | D07/20 |
| T2A-49 | Inexistente y fuera de cliente misma respuesta 404, sin lectura fuera de scope | Puerto que registra filtros; DB posterior | C10/D08 |
| T2A-50 | apiFetch<void> maneja 204 sin parsear JSON; 200 inválido sigue siendo error de contrato | Test FE de transporte | C08/D06 |
| T2A-51 | App sin adapters/config no expone login demo ni acepta magic tokens; health sigue público | Regresión app/default y build | C02/03 |
| T2A-52 | Skew/iat futuro/nbf y tipos incorrectos siguen política explícita, no defaults asumidos | Verificador/clock de borde | D04/13 |
| T2A-53 | Access token Google o ID token enviado como sesión Agro no se acepta por confusión de tipos | Adapter opaco, longitudes/lookup deterministas | D01/03 |
| T2A-54 | Token viejo aportado al login no fija nueva sesión; Google credential no persiste ni se reutiliza | FE + emisor con snapshots | D03/19 |
| T2A-55 | Challenge reclamado con fallo posterior exige otro, nunca retry que reemite | Store/operación de un uso | D05 |
| T2A-56 | Respuesta login perdida no permite recuperar secreto anterior ni reutilizar intento | Transporte abortado sintético | D03/05 |
| T2A-57 | Fila expirada aún presente por TTL retrasado nunca autentica | Reloj/store sin borrado físico | D03/04 |
| T2A-58 | Idle update y logout compiten: no se quita revokedAt ni revive sesión | Operaciones atómicas y barreras | D03/10 |
| T2A-59 | Éxito/401/logout tardío no rellena usuario/cliente de otra generación | FE abort + revision; tests de orden inverso | C05/D19 |
| T2A-60 | Suite completa conserva 160 y regresión HTTP; Preview solo con SHA/entorno/autorización | Pipeline local y futura evidencia remota | D23/26 |

## D. Ejecución real de esta tarea A

| Comprobación | Clasificación | Resultado real |
|---|---|---|
| Git dev/HEAD/origin tras fetch | Confirmado | efb79c2; sin cambio de rama; estado inicial limpio |
| FE leído/huella | Confirmado | daa72a8; 184 archivos; huella 84b2e319…; sin modificaciones |
| Microverificación F09-01 | Confirmado | Reproducida con módulos FE y fetch/storage artificiales en memoria |
| Microverificación F09-02 | Confirmado | Reproducida; no fallback compartido de token |
| Microverificación F09-03 | Confirmado | Reproducida; mensaje [object Object] |
| HTTP real/proveedor/Atlas/Vercel | No aplicable | Cero solicitudes funcionales a servicios reales; solo lectura de documentación técnica pública |
| npm ci/typecheck/build/npm test BE/FE | No aplicable | No reejecutados: solo documentación; 160/160 es antecedente, no nuevo resultado |
| Pruebas T2A-01…60 | Pendiente de aprobación | Diseñadas, no ejecutadas; requieren trabajo B y sus gates |
| Código/SDK/configurados en A | Confirmado | Ninguno nuevo; no instalar SDK ni duplicar infraestructura existente |
| Whitespace/enlaces/IDs/consistencia documental | Confirmado | Verificación local al cierre; no validación especializada OpenAPI ni tests runtime |
| Originales/respaldos | Confirmado | Once originales/copias y 21 archivos de respaldo verificados por hash |

No se declara BE-09 Done ni BE-09.2B implementada/aprobada. B puede estimarse/revisarse,
pero su activación real depende de C10/C11 y D01…D23 según cada componente. La parte
offline acordada puede planificarse sin Atlas; los endpoints productivos no deben
habilitarse con puertos mock, configuración desconocida o contratos no aprobados.

## E. Ejecución local BE-09.2B — 18/11/2026

Este anexo actualiza el estado actual sin reescribir la evidencia de la tarea A.
No transforma decisiones propuestas en aprobaciones. Se implementó el alcance
offline autorizado, con 206/206 pruebas (160 previas + 46 nuevas) y 13/13 escenarios
HTTP conservados contra efb79c2. Ver [implementación B](INFORME_BE09_2B_IMPLEMENTACION_SESIONES.md)
y [auditoría B](INFORME_BE09_2B_AUDITORIA_SEGURIDAD.md).

Leyenda: **Local** = caso backend ejercitado con puertos/fixtures controlados;
**Parcial** = solo un componente del caso, con pendiente explícito;
**Pendiente** = no ejecutado; **No aplica** = alternativa no seleccionada.
No existe una suite de 60 tests con esos nombres: esta tabla traza la evidencia de
las suites reales, incluidas las regresiones BE-08/09.1 conservadas.
G = `test/google-identity.test.js`; S = `test/sessions.test.js`.

| Caso | Estado B | Evidencia / límite |
|---|---|---|
| T2A-01 | Local | G SDK con firma RSA offline; S creación y catálogo fixture; flujo Google real pendiente |
| T2A-02 | Local | G invalid signature: nunca verified ni diagnóstico con token |
| T2A-03 | Local | G expiration con skew 0; política configurable documentada |
| T2A-04 | Local | G issuer ajeno rechazado, dos issuers Google admitidos normalizados |
| T2A-05 | Local | G audience/azp/array rechazados |
| T2A-06 | Local | G malformed/non-RS256/jku y unknown key; sin URL arbitraria |
| T2A-07 | Local | G nonce y S wrong nonce/expired attempt; no emisión |
| T2A-08 | Parcial | S unknown challenge y realm aislado; core verifica audience del intento; flujo FE y IDs reales pendiente |
| T2A-09 | Local | S challenge replay: una única sesión |
| T2A-10 | Local | S two service instances, barrera y un ganador; no certifica atomicidad DB real |
| T2A-11 | Local | S failed insertion burns attempt; falla 503 y exige otro challenge |
| T2A-12 | Local | S unknown/inactive sin alta automática |
| T2A-13 | Local | S unassigned/inactive client sin default |
| T2A-14 | Parcial | Código consulta solo issuer/sub, sin email; G devuelve identidad sin email y S principal desconocido; no fixture específico de colisión email |
| T2A-15 | Local | S opaque/hash-only/canónico y schema estricto; entropía real de Node, sin cuantificar distribución estadística |
| T2A-16 | Local | S creación, contexto privado y mapper DTO |
| T2A-17 | Local | S idle bounded absolute y expiry while lookup pending |
| T2A-18 | Local | S idle expired no revive; extensión limitada por absoluta |
| T2A-19 | Local | S separate worker sharing persistent port; store solo fixture |
| T2A-20 | Local | S complete HTTP: logout 204 y siguiente admisión 401 |
| T2A-21 | Parcial | S logout ausente/repetido/desconocido y otras sesiones intactas; token ya expirado sin caso HTTP dedicado |
| T2A-22 | Parcial | S HTTP storage failures: 503 sin éxito falso; timeout real y UI pendientes |
| T2A-23 | Pendiente | Recuperación FE no implementada; S comprueba GET session backend aislado |
| T2A-24 | Pendiente | Defecto FE F09-01 preservado, no corregido en B |
| T2A-25 | Pendiente | Defecto FE F09-02 preservado, sin modificar storage FE |
| T2A-26 | Pendiente | Defecto FE F09-03/parser de errores sin corregir |
| T2A-27 | Parcial | S doce requests HTTP A/B y contexto por request; caché/generaciones FE pendientes |
| T2A-28 | Parcial | S DTO rechaza clientId extra y query token; BE-09.1 scoped ignora IDs externos para autorización; matriz completa de headers públicos pendiente |
| T2A-29 | Parcial | BE-09.1 conserva IDs colisionantes/jerarquía y S integra scope A/B; consultas DB reales pendientes |
| T2A-30 | Local | S membership version change invalida sesión anterior |
| T2A-31 | Local | S user deactivation/version y semántica explícita de operación ya admitida |
| T2A-32 | Local | S source agro-session por realm, lookup de fila y separación de entornos |
| T2A-33 | Local | S copied capabilities y regresiones BE-09.1 de objetos/instancias ajenas |
| T2A-34 | Local | Regresiones previas BE-09.1 de cierres/generación y errores preservadas |
| T2A-35 | Local | S expiry while lookup y regresiones previas de lease/cierre |
| T2A-36 | Local | G key retrieval failure seguro, recuperación sin cachear rechazo |
| T2A-37 | Parcial | G unknown/rotated kid con proveedor controlado; refresco de caché SDK real no ejercitado |
| T2A-38 | Parcial | S puertos fallidos 503 seguros; red real y reacción FE pendientes |
| T2A-39 | Local | S complete HTTP/log sink y metadata; G invalid signature/SDK error sin token |
| T2A-40 | Local | S Origin/JSON/preflight, sin credentials/wildcard en auth |
| T2A-41 | Local | S Origin ausente/null/slash no llega al store; app default health conservada |
| T2A-42 | Parcial | S POST sin Origin y text/plain rechazados; flujo navegador/GIS y callback FE pendiente |
| T2A-43 | No aplica | Cookie/CSRF alternativo no seleccionado; Bearer propuesto |
| T2A-44 | Parcial | Riesgo JS/sessionStorage reconocido; headers BE-08 conservados; no auditoría XSS de frontend |
| T2A-45 | Local | S oversized HTTP/credential; parser BE-08 previo cubre JSON malformado/primitivo y media type |
| T2A-46 | Parcial | S admisión 429/503 obligatoria, sin default; limiter distribuido/dimensiones reales pendientes |
| T2A-47 | Parcial | S dos factories/store compartido y default sin I/O auth; cold start/pool real Vercel pendiente |
| T2A-48 | Local | S HTTP 401/403/503, observabilidad única, default health; regresión HTTP 13/13 |
| T2A-49 | Parcial | BE-09.1/scoped S devuelve 404 ajeno; implementación de consulta DB pendiente |
| T2A-50 | Pendiente | S comprueba 204 vacío backend, no apiFetch<void> frontend |
| T2A-51 | Local | S app default health y auth/demo 404, grafo sin import de SDK/servicio de sesiones |
| T2A-52 | Local | G exp/iat/nbf/tipos con reloj controlado, límites de skew |
| T2A-53 | Parcial | G rechaza access-token no JWT; adapter de sesión solo opacos canónicos; sin caso dedicado de todos los tipos Google→Agro |
| T2A-54 | Parcial | S generación nueva, DTO sin token de entrada y persistencia hash-only; FE no integrado |
| T2A-55 | Local | S failed insertion y replay: fallo después de claim requiere nuevo intento |
| T2A-56 | Parcial | Se documenta huérfana/secretos irrecuperables y replay impide reemisión; no test de abort HTTP tras insert |
| T2A-57 | Local | S expired row todavía presente no autentica, sin dependencia del TTL físico |
| T2A-58 | Local | S logout/touch con barrera no resucita revocación |
| T2A-59 | Pendiente | Generaciones FE/éxitos y errores tardíos fuera de alcance B |
| T2A-60 | Parcial | npm ci/typecheck/build/test: 206/206; 13/13 HTTP; Preview y E2E real pendientes |

### Decisiones y gates después de B

Implementación técnica local: SDK oficial 11.3.4, firma/claims/nonce; opacos de 256
bits con SHA256; puertos de catálogo/store; claim de un uso; expiración absoluta e
idle; revocación y pertenencia ligada a sesión; composiciones HTTP aisladas con
admisión explícita, Zod y errores/logs BE-08. Son decisiones de implementación de
esta entrega, no aprobación productiva de D01…D26 ni cierre de C10/C11.

Siguen pendientes: catálogo/BSON/almacenamiento durable BE-02; aprobación BE-03 y
FE/BE de rutas/DTO/errores/skew/TTL; GIS real/Client IDs/origins; limiter compartido
y deadlines de los puertos; retención/índices/consistencia; bugs FE; E2E y Preview
autorizado. Las cuatro rutas propuestas no se montan en app.ts.

Hallazgos B-F01 (vencimiento durante claim) y B-F02 (sustitución de binding al
releer) se reprodujeron con pruebas fallidas antes del arreglo y aprobadas después.
No se encontraron nuevos bypasses HTTP productivos en el alcance revisado; no se
garantiza seguridad absoluta ni se declara autenticación real habilitada.
Estado: listo para auditoría local BE-09.2C, BE-09 parcial, sin commit/push/PR/deploy.

## F. Auditoría BE-09.2C — 18/11/2026

Resultado actual: **220/220 pruebas**, 14 nuevas sobre las 206 de B, 13/13 HTTP
equivalentes; npm ci/typecheck/build/diff-check correctos. Se preservan los anexos
anteriores como evidencia histórica. No se convierte ningún gate externo en aprobado.
Véanse [informe C](INFORME_BE09_2C_AUDITORIA_FINAL.md) y la
[matriz requisito/amenaza/control/test/evidencia/estado/riesgo](MATRIZ_BE09_2C_TRAZABILIDAD.md).

| Caso A / garantía | Actualización verificable C |
|---|---|
| T2A-10/11/55, fallos de claim | C05 prueba pérdida de confirmación después del consumo: 503, retry rechazado, nuevo intento recupera |
| T2A-14, colisión de email | C10 ejercita perfiles con mismo email: issuer/sub distintos conservan usuario/cliente; desconocido no se enlaza |
| T2A-18/58, idle concurrente | C02 reproduce rechazo de max correcto; corregido a max atómico monótono con bounds y sin cambiar binding |
| T2A-27/28, contexto y datos públicos | C07/C09/C11: resultado A obsoleto no sustituye B; sesiones independientes; body/cookie/headers de B no cambian cliente A |
| T2A-31/34/35, revocación y async | C06/C08/C13: cierre durante verificación, expiración durante pertenencia y logout antes de authorize no reviven capacidades |
| T2A-36/37, proveedor/caché | C01/C03/C04: SDK/Gaxios efectivos offline, no retries, caché max-age y rotación; integración Google real permanece pendiente |
| T2A-39, errores y logging | C12: strings, objetos, causas y Proxy hostil no llegan al sink ni respuesta; no-store |
| T2A-56, abort después del claim | C14: HTTP abortado no entrega token, intento consumido y fila huérfana expirable; no se promete rollback |
| T2A-60, regresión | 220/220, sin omisiones; 13/13 HTTP iguales contra efb79c2; Preview no ejecutado |

Hallazgos C-F01 y C-F02 medios corregidos; sin hallazgos altos/críticos locales
abiertos identificados. Los límites de store/consistencia/namespace por despliegue,
catálogo BE-02, contratos BE-03, configuración GIS, FE/XSS/bugs, limiter/deadlines,
Atlas y Vercel siguen abiertos. La app default no monta auth. Lista para revisión
e integración como infraestructura deshabilitada; BE-09 no Done. No se realizó
commit, push, PR, merge o deploy ni se inició BE-10.
