# BE-09.2A — Diseño de autenticación real de Agro

17/11/2026, America/Buenos_Aires. **Diseño terminado para revisión; no aprobado ni
implementado como autenticación real.** Complemento:
[matriz de decisiones, amenazas y pruebas](MATRIZ_BE09_2A_DECISIONES_Y_PRUEBAS.md).

## 1. Resumen ejecutivo

Recomiendo **Google Identity Services (GIS), validación del ID token en backend y
sesión de aplicación opaca, revocable, transportada como Bearer**. No usar el ID
token Google como sesión permanente ni emitir JWT propios. El cliente autorizado
se obtiene de un catálogo servidor, jamás de un ID elegido por el navegador.

Es una **decisión técnica propuesta**, condicionada a aprobar proveedor, contratos,
riesgo XSS del almacenamiento JS y persistencia confiable. Conserva el header y
campo `token` actuales; exige sustituir el login demo/password, recuperar identidad
real y corregir tres defectos FE. Cookie HttpOnly reduce la extracción del secreto
por JS, pero requiere otro contrato y topología/orígenes aún no comprobados. No se
implementan dos modos simultáneos ni un fallback automático entre ellos.

Se proponen cuatro operaciones: challenge de login, establecimiento de sesión,
consulta de sesión/usuario actual y logout. El challenge tiene una función distinta
de sesión y permite nonce de un uso; no se duplican `/me` y `/verify`.

**Resultado local:** solo dos documentos nuevos. Sin dependencias, código, endpoints,
tokens, cookies, modelos, cuentas o cambios de configuración. Las 160 pruebas son
el antecedente validado de dev; no se reejecutó la suite funcional en esta tarea
documental. Sí se reprodujeron tres microcasos FE en memoria y se validaron los
documentos. BE-09.2B aún necesita las aprobaciones y evidencias enumeradas en §22.

## 2. Estado FE y evidencia

Snapshot local limpio: `fe-agro` dev, commit
`daa72a828eb79aad0f09dcb7786a2c5a4adfd3bc`, 184 archivos versionados; huella agregada
SHA-256 `84b2e319cd5fdb29a03f0d339e3e7591d1a2703624d0f2308b1fee482a53eaae`.
La consulta de ramas GitHub confirmó una rama dev, no aportó su SHA. No se afirma
haber actualizado el checkout FE ni que represente todo despliegue remoto.

| Código FE en ese snapshot | Comportamiento observado |
|---|---|
| src/pages/LoginPage/LoginPage.tsx:20–43 | Google habilitado solo si VITE_USE_MOCKS=true; bloqueo de doble envío, carga y errores; login tradicional envía email/password |
| src/api/login.ts:7–34 | POST /auth/login; Google llama /auth/google-demo y recuperación /auth/demo/sesion exclusivamente MSW |
| src/api/client.ts:24–54 | fetch, sin Axios/interceptor adicional; Bearer leído desde storage en cada llamada; sin credentials:include explícito; parsea JSON incluso en éxito vacío |
| src/api/sesion.ts:1–55 | agro_token/agro_modo_sesion en sessionStorage; errores de storage se capturan sin fuente de credencial en memoria compartida con transporte |
| src/app/AuthContext.tsx:10–71 | token/usuario/cliente en React; revision protege su propio async, pero no el 401 global; recuperación remota solo en mocks |
| src/app/RutasProtegidas.tsx | navegación exige token no vacío y fin de recuperando; no verifica por sí misma la sesión |
| src/types/auth.ts | LoginRespuesta exige solo token; identidad real puede faltar. LoginPedido es email/password, no una aserción GIS |
| src/types/dominio.ts | Usuario contiene usuario_id/nombre/email/cliente_id; Cliente contiene cliente_id/nombre |
| src/app/CampoProvider.tsx; src/api/campos.ts | campos disponibles solo con mocks; /auth/demo/campos no es una API productiva |

`cerrarSesion` borra estado/storage, no llama al servidor. El modo no mock tras
recarga conserva token pero no recupera identidad. Un 403 no dispara la misma
limpieza global que 401; algunas vistas lo presentan como recurso no disponible.
El texto «backend actual» de tipos FE no demuestra que exista dicho login en be-agro.

## 3. Estado BE y piezas reutilizables

Worktree indicado, rama **dev**, HEAD y origin/dev después de fetch:
`efb79c21e792e71fa14915325ed84189bd119afc`. Inicio limpio. main local/remota:
`1bb20f76b7a739f42c75b37b9a64315276560ec1`. El otro worktree conserva BE-09 histórica
en `63c7eb2`, con once untracked. Se comprobaron hashes de originales/copias y de
21 archivos de respaldo anteriores; no se escribieron en ellos.

Se inspeccionaron AGENTS, plan, especificación, DoD, README, informes BE-05…09,
BE-02/03 y fuentes/tests. Los snapshots JS de documentos BE-00/01 son históricos;
el código vigente es TS estricto/NodeNext, Express 5, Mongoose/Zod y node:test.
Solo health está montada. No hay verificador externo, catálogo de usuarios ni store
de sesiones productivo. La app no importa los módulos de autorización BE-09.1.

| Pieza existente | Reutilización propuesta / límite |
|---|---|
| src/auth/contracts.ts | UserId/ClientId, CredentialVerifier, IdentityResolver, SessionLifecycle y scope; no equivalen a ID tokens verificados o sesiones persistidas |
| authorization.service.ts | capacidades privadas, validación strict, separación autenticar/autorizar, expiración y lease; conservar lógica/test de procedencia |
| request-authorization.middleware.ts | lectura Bearer, rechazo de duplicados, WeakMap por request, generaciones y cierre; no hay setter público de identidad |
| client-scoped.repository.ts | contratos lógicos de propiedad y padres; faltan queries Mongo reales con filtro dentro de la consulta |
| validate-request.middleware.ts | safeParseAsync, accessor z.output y errores sanitizados; reutilizar para nuevos DTO aprobados |
| http/error-response.ts y application.error.ts | clasificación y categorías 400/401/403/404/409/413/415/429/500/503; no inventar otro catálogo |
| infraestructura BE-08 | UUID, proyección segura de logs, headers/parser optativos y fronteras terminales; no registrar credenciales para diagnosticar login |
| infrastructure/mongodb.ts | conexión explícita, pool reutilizable por instancia, apertura compartida; no store en memoria ni conexión al importar/health |

La URI Mongo existente se valida sin conectarse, con base explícita; el pool tiene
maxPoolSize=5, minPoolSize=0 y autoCreate/autoIndex/buffering deshabilitados. No se
alteraron esos valores. .env.example solo aporta placeholders y CORS local; no
configura Google ni un store de autenticación real.

## 4. Hallazgos y límites de investigación

Se cargaron en memoria los módulos FE reales sesion/client/comun, transpile local,
con fetch y sessionStorage artificiales; **cero HTTP real y cero archivos FE escritos**:

| Hallazgo | Resultado reproducido hoy | Efecto en integración real |
|---|---|---|
| F09-01 | 401 pendiente con token A elimina token B guardado después | Vincular expiración al snapshot de credencial y generación; no destruir sesión nueva |
| F09-02 | storage que arroja deja apiFetch sin Authorization | Unificar fuente de token en memoria y persistencia opcional; no prometer fallback inexistente |
| F09-03 | error anidado termina como [object Object] | Migrar parser FE y DTO de error coordinadamente |

No se corrigieron aquí. Además, FE no maneja 204, recuperación real, logout remoto
ni campos reales. BE-09.1 no tiene emisión ni challenge y descarta SessionReference
al crear la identidad: su MembershipResolver solo recibe userId. **Tal contrato no
basta para vincular membresía a la sesión concreta y su versión**; ver §10.

El handler legacy no es el handler correcto para nuevos errores de autenticación:
clasifica por statusCode y su texto 403 es de CORS. ApplicationError lleva code.
BE-08 optativo sí clasifica esas categorías; integrarlo requiere composición
explícita, no lanzar un error nuevo al handler legacy esperando un 401 correcto.

El conector no pudo acceder a `Proyecto-Agro-Org/agro`; la herramienta web tampoco
obtuvo su página y no existe checkout local en la ruta esperada. La revisión previa
de `422dc7aace5d1b6b3e895cb166f21ead4a7b52b8` es antecedente, **no evidencia actual**.
Debe confirmarse si hay un IdP/sesión ya operativa antes de agregar otra. No se
buscaron secretos ni se solicitó autenticación para completar esa lectura.

## 5. Solución recomendada: identidad federada

Elegir GIS para el botón de ingreso si el equipo ratifica Google y no aparece una
solución existente reutilizable. El backend validará el ID token con el SDK oficial
google-auth-library, detrás de un adapter; no se instala ni se elige versión ahora.
Compatibilidad concreta del SDK elegido con Node 24/ESM y su clasificación de errores
se verificará antes de fijarlo en BE-09.2B.

Google documenta verificación de firma, aud, iss y exp en servidor y uso de sub como
identificador estable. La clave federada de Agro será (issuer canónico, sub), no
email recibido ni un perfil JS. [Fuente oficial](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).

Propuesta de política de aceptación: audience única configurada por entorno;
issuer Google admitido por la librería normalizado a una identidad canónica; sub
no vacío; firma/algoritmo permitido del proveedor; exp e iat válidos; nbf si aparece;
nonce exactamente ligado al intento vigente; azp, si aparece, igual al cliente
esperado. No escoger claves, jku, audience o issuer desde body/headers del emisor.
Rechazar arrays aud inicialmente hasta aprobar ese caso. La política local propone
60 s de tolerancia temporal y duración acotada del intento, **sin asumir que sean
los defaults del SDK**: validación adicional y tests deben imponerla.

El nonce se solicita al servidor y se pasa a GIS; no se acepta una respuesta de
otro intento. GIS documenta nonce en su configuración.
[Referencia GIS](https://developers.google.com/identity/gsi/web/reference/js-reference#nonce).
No se adopta el ejemplo de logging raw de una guía como política de logs de Agro.

Las claves públicas se obtienen por el mecanismo mantenido del SDK, con caché
según metadata, timeout y refresh acotado por rotación; no descargar claves desde
URLs del token ni reintentar indefinidamente un kid desconocido. Clasificar prueba
inválida como 401, indisponibilidad de claves/proveedor como 503 cuando pueda
distinguirse de forma tipada; nunca inspeccionar mensajes sensibles para responder.
email_verified se exige si se entrega email como atributo verificado; email/nombre
son presentación, no autorización. hd solo si se acuerda restricción Workspace.

## 6. Alternativas evaluadas

| Alternativa | Evaluación para Agro |
|---|---|
| GIS + sesión opaca propia | Recomendada: conserva contrato Bearer y permite revocación/TTL de aplicación; exige store y controles de este diseño |
| Google ID token en cada request | No preferida: no da por sí sola logout/revocación de sesión Agro, política propia de pertenencia ni duración independiente |
| Cookie HttpOnly con sesión opaca | Mejor resistencia a lectura del secreto desde JS; candidata si se aprueba topología propia/same-site y migración FE, CORS credentials y CSRF |
| Firebase Authentication | Alternativa real si ya existe proyecto/acuerdo: SDK/gestión de usuarios y verificación específica Firebase, nuevas configuraciones y dependencia; no suponer que valida igual un ID token Google |
| OIDC Authorization Code + PKCE en backend | Válida si se necesita flujo redirect o APIs Google; agrega callback/estado y configuración que no requiere el alcance actual |
| JWT firmado por Agro | No recomendado: gestión de claves/refresh y estado extra para revocar; no elimina necesidad de catálogo ni controles por cliente |
| Password local o perfil Google sin validar | Fuera de alcance / inseguro; no implementar para imitar el formulario mock |

Un access token habilita una API Google; el ID token acredita identidad. Agro no
necesita acceso a Drive/Gmail ni offline access para este alcance.
[Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect).
Firebase distingue verificar ID tokens y comprobar revocación, que debe pedirse
explícitamente según el flujo; no se agrega ese sistema sin necesidad demostrada.
[Verificación Firebase](https://firebase.google.com/docs/auth/admin/verify-id-tokens),
[sesiones Firebase](https://firebase.google.com/docs/auth/admin/manage-sessions).
Si se adopta code flow, aplicar PKCE/redirect exacto/state/nonce según su protocolo;
no confundir el callback GIS de credenciales con un grant OAuth de contraseña.
[OAuth Security BCP](https://www.rfc-editor.org/rfc/rfc9700.html).

## 7. Flujo completo propuesto

1. FE inicia una nueva generación de login y pide challenge por JSON desde un
   Origin autorizado. BE devuelve nonce e ID aleatorios de intento, TTL 5 min;
   los persiste como hashes/contexto mínimo en un store compartido.
2. FE guarda el intento solo en memoria, configura GIS con ese nonce y renderiza
   su botón oficial. No acepta credenciales por URL, postMessage arbitrario o storage.
3. Callback de la generación vigente entrega credential (ID token). FE lo envía
   con challenge_id a `/auth/login`; nunca lo persiste como agro_token.
4. BE valida DTO/tamaño/Origin/intento y verifica criptografía/claims/nonce con el
   adapter. Resuelve el usuario preaprovisionado y su cliente activo desde el servidor.
   Identidad desconocida o sin cliente no produce sesión ni alta automática.
5. BE reclama atómicamente el challenge todavía pendiente/no vencido. Solo un
   request gana; luego inserta una nueva sesión. Si falla insertar, el challenge
   queda consumido y se exige otro intento; no hace falta asumir transacciones
   multidocumento para evitar doble emisión. Una respuesta perdida puede dejar
   una sesión inaccesible que expira; no reutilizar el intento para recuperarla.
6. Devuelve token opaco, usuario/cliente completos y vencimientos. FE sustituye
   credencial/identidad de forma conjunta, invalida requests/cachés anteriores y
   borra el ID token/nonce del intento. La respuesta obsoleta se descarta.
7. Cada request privado lleva Bearer Agro; backend verifica sesión persistida,
   usuario activo, binding/version de pertenencia y finalmente el recurso scoped.
   Google no se consulta en cada operación de negocio.
8. Recarga: FE lee credencial opcionalmente persistida, queda en recuperando y
   llama GET session; no habilita navegación por token no vacío solamente.
9. Logout: FE invalida generación/requests y solicita revocación de esa sesión;
   solo 204 acredita cierre remoto completado/idempotente. Si falla la red, puede
   limpiar localmente, avisando que la revocación remota no quedó confirmada.

## 8. Estrategia de sesión de aplicación

| Aspecto | A: Bearer Google | B: cookie HttpOnly | C: opaco Bearer recomendado |
|---|---|---|---|
| Verificación | Firma/claims + catálogo | Lookup de sesión + catálogo | Lookup de sesión + catálogo |
| Revocación/logout Agro | Requiere estado adicional | Revocar store y expirar cookie | Revocar store; borrar token FE no basta |
| Expiración | Atada al token externo | Política servidor propia | Política servidor propia |
| XSS | Extrae token JS | No lee HttpOnly, pero puede actuar desde la página | Puede extraer el token JS; riesgo residual alto |
| CSRF | No credencial automática si solo header | Requiere protección por ser ambiental | Header manual; login aún necesita protección de origen/intento |
| CORS/FE | Parecido al header actual, nuevo ciclo GIS | credentials/include y cookies nuevas | Conserva header; corrige estado/storage y login |
| Serverless | Claves/catálogo compartidos | Store durable compartido | Store durable compartido |
| Complejidad/test | Revocación no resuelta por la firma | Topología/cookies/CSRF y store | Store, nonce, expiración y revocación deterministas |

Propuesta C: secreto de sesión aleatorio de 32 bytes CSPRNG, base64url sin padding,
43 caracteres. **No generado en esta tarea.** Guardar SHA-256 del secreto aleatorio,
nunca el valor reutilizable, no un hash de contraseña; no hacen falta KDF de passwords
ni un JWT. sessionId interno distinto del secreto. Solo el adapter de credenciales
recibe raw token; no propagar ese valor por puertos/logs/DTOs de usuario.

FE tendrá una fuente única en memoria; sessionStorage será persistencia auxiliar
por pestaña para recuperación, nunca fuente exclusiva del transporte. Si falla
escribir storage, seguirá funcionando hasta recargar, y deberá comunicar ese límite.
No localStorage, URL o cookie duplicada del token. Esto **no elimina XSS**: aceptar
el almacenamiento JS es un gate de aprobación; si no se acepta, elegir B antes
de implementar transporte, no añadir ambos perfiles por defecto.

La guía de sesiones sustenta IDs impredecibles y controles de ciclo servidor;
los tamaños/tiempos concretos aquí son propuestas de Agro, no valores ya aprobados.
[OWASP sesiones](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

## 9. Identificación y aprovisionamiento

Resolver (issuer, subject) verificados → userId interno. No vincular automáticamente
cuentas por coincidencia de email, nombre, sufijo de correo o dominio enviado por FE.
No just-in-time signup en el MVP propuesto. Alta y asociación inicial deberán venir
de un proceso administrativo confiable aprobado, sin crear endpoints de roles/CRUD.

BE-02 solo propone usuarios/clientes, BSON y referencias. No se sabe si existe una
tabla confiable que pueda reutilizarse. Proyección lógica candidata, **no schema
Atlas existente**: userId, identidad federada, active, clientId y securityVersion.
Preferir extender/mapear el catálogo real si existe, en lugar de crear otro usuario.
Uniquidad de (issuer, subject), tipo BSON y administración se aprueban con BE-02.
El email verificado puede mostrarse; no concede cliente ni enlaza identidades solo.

## 10. Pertenencia y adaptación de BE-09.1

Un usuario → un cliente en esta etapa. Usuario desconocido/inactivo o sin cliente
activo: 403 FORBIDDEN genérico al login, sin sesión, sin tenant default. Aceptar
identidad Google no equivale a autorización Agro. Un recurso fuera de cliente se
devuelve 404 igual que uno inexistente, con filtro en repository y padres persistidos.

La sesión propuesta conserva binding a clientId y securityVersion del catálogo.
Un cambio de cliente/desactivación/revocación global incrementa esa versión mediante
una operación administrativa confiable; no aplicar silenciosamente un nuevo tenant
a una sesión vieja. Cambio de binding invalida la sesión (401); sin asignación al
nuevo login sigue siendo 403. FE borra caché de dominios y vuelve a autenticar.

**Adaptación obligatoria antes de usar BE-09.1 en producción:**

- Conservar el SessionReference que ya devuelve CredentialVerifier en el registro
  privado de cada identidad; no exponerlo en DTO ni tomarlo del navegador.
- Extender el puerto MembershipResolver para recibir obligatoriamente userId y
  esa referencia. Su adapter debe comprobar sesión, binding, versión y pertenencia
  actual conjuntamente con una lectura consistente. Un userId aislado no basta.
- Mantener la separación: rechazo de sesión inválida → 401; identidad válida sin
  acceso → 403; backend/store no disponible → 503. Actualizar los schemas strict y
  tests de contratos internos de forma explícita; esto todavía no está implementado.
- Reutilizar capacidades/leases/getters y control de generaciones; no añadir un
  contexto global mutable para comunicar información entre los adapters.

El verifier de aplicación trata solo el opaco Agro: consulta su digest, devuelve
subject=userId interno de la fila confiable, source estático `agro-session:<entorno>`
y SessionReference interno. IdentityResolver acepta ese namespace de aplicación y
resuelve usuario activo. El adapter federado separado resuelve issuer/sub **solo al
login**; no debe inventar un SessionReference para un ID token Google antes de emitir
sesión. Así se reutiliza infraestructura sin confundir dos clases de credenciales.
SessionLifecycle.inspect debe contrastar el estado/binding/version persistidos antes
de aceptar una sesión; el resolver de pertenencia vuelve a validar el binding al
autorizar. En una carrera posterior, otro control puede observar primero la falta
de acceso y devolver 403: no prometer un orden global de esos eventos; nunca conceder
acceso por ignorar el cambio. `AuthenticatedIdentity.authenticatedAt` hoy es la hora
de comprobación de ese request, no auth_time de Google ni creación de sesión; no
usarla para afirmar reautenticación reciente o step-up.

Contrato documental concreto de la extensión, no código incorporado. Sustituiría
el puerto actual dentro de AuthorizationPorts; no exige un segundo sistema paralelo:

```ts
type SessionMembershipResolution =
  | { status: 'authorized'; membership: ResolvedMembership }
  | { status: 'invalid-session' }
  | { status: 'no-membership' };
interface SessionBoundMembershipResolver {
  resolve(userId: UserId, session: SessionReference): Promise<SessionMembershipResolution>;
}
```

El service mapeará invalid-session a 401 y no-membership a 403; authorized exige
membership activa y salida estrictamente válida. Fallos de I/O siguen siendo rechazo
de Promise sanitizado a 503; output malformado es 500. **Hoy callPort transforma
cualquier excepción en 503**: no lanzar UNAUTHENTICATED desde el adapter esperando
que se conserve, ni relajar la sanitización de errores desconocidos.

Antes de la primera sesión, LoginService consulta el catálogo de aprovisionamiento
mediante sus repositories; no invoca authenticate con el ID token Google ni fabrica
una SessionReference. Al emitir captura clientId/securityVersion comprobados;
si cambia el catálogo durante el intento, no debe convertir el binding en acceso
válido por omisión: la primera admisión vuelve a contrastarlo y rechaza el obsoleto.

## 11. Contratos HTTP mínimos propuestos

Todas las rutas nuevas son **pendientes de aprobación FE/BE y BE-03**, bajo
`/api/v1`; no se añaden a OpenAPI ni se montan aquí. Health y contratos activos
se conservan. Éxitos de sesión tendrán Cache-Control:no-store. JSON estricto y
campos extra rechazados según el DTO que se apruebe.

| Operación | Auth / entrada | Éxito | Errores previstos | Integración FE |
|---|---|---|---|---|
| POST /auth/google/challenge | Pública; Origin autorizado, JSON {} | 200 {challenge_id, nonce, expires_at}; IDs opacos de intento, UTC | 400 DTO, 403 origen, 413/415 cuerpo, 429 límite, 503 store | Nuevo paso antes de GIS; intento en memoria, nunca storage |
| POST /auth/login | Pública; sin Bearer anterior; JSON {provider:"google", credential, challenge_id} | 200 LoginSessionResponse | 400 DTO; 401 aserción/intento inválido; 403 acceso Agro no habilitado; 413/415/429; 503 proveedor/store; 500 inesperado | Reutiliza path, cambia LoginPedido; retirar password/demo del modo real |
| GET /auth/session | Bearer opaco; sin body/query | 200 SessionResponse con identidad, cliente y expiraciones | 401 sesión; 403 política de acceso; 503 store; 500 inesperado | Una sola operación para usuario actual, verificación y recarga; sin /me ni /verify duplicados |
| POST /auth/logout | Credencial presentada identifica solo la sesión a revocar; sin requireClient; sin body | 204 sin JSON, también ausente/desconocida/vencida/revocada | 400 request/header ambiguo; 403 origen; 503 si no puede confirmarse revocación; 500 inesperado | Añadir manejo explícito de 204 y advertencia si cierre solo local |

Tipos documentales propuestos (instantes ISO8601 UTC con milisegundos; política
de tiempo de autenticación separada de telemetría submilisegundo BE-04):

```ts
type CreateGoogleChallengeRequest = Record<string, never>;
type CreateGoogleChallengeResponse = {
  challenge_id: string; nonce: string; expires_at: string;
};
type GoogleLoginRequest = {
  provider: 'google'; credential: string; challenge_id: string;
};
type SessionResponse = {
  usuario: { usuario_id: string; nombre: string; email: string; cliente_id: string };
  cliente: { cliente_id: string; nombre: string };
  sesion: { expira_en: string; expira_por_inactividad_en: string };
};
type LoginSessionResponse = SessionResponse & { token: string; token_type: 'Bearer' };
```

GetSessionRequest no aplica: sin params/query/body. LogoutRequest tampoco recibe
body/params/query; su credencial es el header de transporte, y LogoutResponse es
void/204. Proponer body máximo 16 KiB, credential entre 1 y 8192 caracteres y los
IDs/nonce aleatorios de 32 bytes base64url (43 caracteres). Estos límites requieren
schema/runtime y pruebas, no se obtienen solo de las interfaces. El JSON challenge
acepta exactamente {}; login exactamente sus tres campos. Ningún response repite
el ID token Google; el secreto Agro solo se devuelve al establecer la sesión.

`expira_en` es el vencimiento absoluto y `expira_por_inactividad_en` el límite idle;
la validez efectiva usa el mínimo. No son fechas de última actividad. Aprobar los
nombres con FE antes de implementar; esos campos no existen en el contrato actual.
No hay sesión exitosa con identidad parcial/null: sin cliente se expresa por 403.
El token solo aparece en el éxito login. GET session no lo refleja ni lo renueva.
Ejemplo sintético de usuario/cliente: u_demo/c_demo y display@example.invalid;
no son registros existentes, cuentas a crear ni un token aceptado por el runtime.

Errores candidatos: `{ "error": { "code": "UNAUTHENTICATED", "message":
"Authentication required" } }`, usando exclusivamente categorías/mensajes BE-08.
No responder con razón detallada de email/cliente/firma. El parser FE deberá
aceptar string legado y objeto nuevo durante migración; no activar el envelope
global por instalar este router. D03-01/04/10/11 necesitan aprobación/actualización.

Composición BE-09.2B: reutilizar clasificador/adaptador/handler seguro BE-08 con
contexto de observabilidad compartido, parser y boundaries en alcance auth. Hoy
createHttpInfrastructure crea su propio contexto; hará falta inyección controlada
para un UUID/sink único al compartirlo con app/legacy. No instanciar observadores
competidores ni cambiar globalmente health/CORS/404 para conseguir login. Cubrir
esa composición con regresión; no duplicar clasificadores ni enviar errores al
legacy esperando otra semántica. 404 de recurso ajeno sigue perteneciendo a rutas
de negocio, todavía no implementadas en esta etapa.

Logout requiere un servicio de revocación por digest independiente del middleware
que exige usuario/cliente activos: de otro modo un usuario desasignado no podría
revocar su credencial. Solo puede revocar la fila vinculada al secreto presentado;
no admite sessionId/userId/clientId arbitrarios como selector público.

## 12. Modelo de amenazas

La matriz complementaria detalla 22 escenarios con impacto, control, prueba y
dependencia externa. Prioridades de salida: firma/claims/nonce; binding de sesión;
aislamiento A/B; revocación persistida; generación FE; secretos fuera de logs.
Un Bearer robado puede reproducirse hasta revocación/expiración: TLS, CSP, higiene
de dependencias y menor persistencia reducen exposición, no prueban posesión legítima.
No se promete detectar al atacante solo por IP/UA ni se implementan roles nuevos.

## 13. CORS, CSRF y topología

Propuesta C usa solo Authorization manual como autenticación: ninguna cookie de
sesión aceptada en paralelo. No requiere cookie/CSRF token para requests privados
como si hubiera credencial ambiental, pero **sí proteger login y sus transacciones**.
Para los tres POST auth de navegador: Origin exacto autorizado obligatorio (rechazar
null/ausente), JSON y rechazo de tipos simples/form, más nonce/attempt/generación.
GET session exige Bearer; health y política global sin Origin no cambian. No confiar
en Origin para validar identidades de clientes no navegador: se puede falsificar
desde un cliente HTTP, que aun así necesita la credencial.

Proponer preflight solo para orígenes configurados del entorno, métodos GET/POST
y headers Content-Type/Authorization. Sin wildcard en auth ni credentials:true.
Los orígenes de Preview se autorizan individualmente, no *.vercel.app ni regex de
cualquier subdominio. No interpretar CORS como aislamiento de clientes.
[CSRF en APIs y login](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

Si se aprueba B: sesión opaca servidor sigue siendo necesaria, cookie Secure/
HttpOnly/__Host- con Path=/ y sin Domain; SameSite según topología y CSRF explícito
para mutaciones, incluido login. credentials:include y allow-origin exacto si hay
cross-origin; same-origin preferible si hay routing propio autorizado. Same-site
no equivale a same-origin; cookies cross-site y restricciones de navegador no se
resuelven con CORS solamente. Eso **no es el transporte elegido para implementar
en paralelo**. [Atributos de cookies](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).
Google g_csrf_token del flujo POST propio no aparece mágicamente en un callback
JS→JSON; no afirmar que se valida un cookie que Agro no emitió o recibió.

## 14. Expiración, concurrencia y revocación

Propuesta, pendiente de aprobación: challenge 5 min y un uso; sesión absoluta 8 h,
inactividad 30 min, tolerancia temporal federada 60 s. No refresh en primera versión:
al vencer se repite GIS. Expiración de ID token se verifica al login; no se confunde
con la de la sesión Agro emitida. Cambiar estos números exige tests de bordes.

Store de sesiones durable compartido, nunca Map del proceso. Campos lógicos
candidatos: sessionId, digest, environment, userId, clientId, securityVersion,
createdAt, absoluteExpiresAt, idleExpiresAt, revokedAt. No guardar credencial Google,
raw token Agro, password, perfil completo, IP/UA por defecto o token en logs.
Colección candidata auth_sessions e índice único digest; son propuestas, no Atlas
comprobado. Challenge candidato auth_login_challenges: digest del ID/nonce, entorno,
audience/fuente esperados, expiresAt y consumedAt. Índices y BSON quedan para BE-02.

Cada admisión comprueba expiración y revocación en el store. Actividad autenticada
puede extender idle hasta min(now+30min, absolute), solo con actualización condicional
de fila aún activa; nunca guardar un snapshot que quite revokedAt o resucite la
sesión. Polling cuenta como actividad HTTP, no demuestra presencia humana. Health
no mantiene viva una sesión. TTL sobre expiración absoluta/challenge solo limpia;
la autorización no espera al borrado físico.
[Mongo TTL](https://www.mongodb.com/docs/manual/core/index-ttl/).

Logout revoca la sesión actual de forma idempotente, con escritura confirmada;
no desloguea Google ni elimina su consentimiento. Se pueden mantener sesiones
distintas en pestañas/dispositivos; borrar una no revoca las demás. Un duplicado
de pestaña puede compartir token: su revocación afecta a todos sus portadores.
Revocación global/cambio de cliente usa securityVersion por proceso administrativo
aprobado, sin otro endpoint público en este alcance.

Definir consistencia de lecturas/escrituras del store para nuevas admisiones,
sin caché positiva de autenticación compartida entre requests. Proponer lecturas
primarias y confirmación durable de revocación, a comprobar con el responsable DB.
Solicitudes ya admitidas pueden terminar tras logout/cambio; el lease solo invalida
el request local y su expiración, no cancela un I/O remoto arbitrario. No se promete
revocación retroactiva linealizable de operaciones en vuelo ni cero ventana de carrera
sin una política/transacción de recursos adicional. Debe aprobarse ese límite.

## 15. Estrategia de pruebas

La matriz define T2A-01…T2A-60, **diseñadas, no ejecutadas como endpoints reales**.
Conservar las 160 existentes. Dobles con reloj, entropía fija solo en test, key-fetch
controlado, store simulado con operaciones atómicas/barreras y dos usuarios/clientes.
Para criptografía futura usar fixtures offline del verificador/proveedor y claves
de prueba controladas; un fake que retorna verified no prueba firma/JWKS.
No generar tokens productivos propios ni usar credenciales reales para completar QA.

En B: unitarios de dominio/DTO/adapters, integración HTTP loopback, simulación de
store multiworker y carreras; después integración en DB aislada/autorizada y Preview
identificado. En A solo se ejecutó diagnóstico sintético FE y validación documental.

## 16. Cambios FE requeridos

Antes de un rollout: botón GIS real, nuevo LoginPedido/challenge, eliminación del
password/demo en modo real sin tocar MSW de tests como autenticación; estado inicial
recuperando y GET session; identidad completa y reset de campos/cache por generación.
Agregar store de credencial con memoria primaria y persistencia auxiliar coherente;
401 solo limpia si coincide generación/credencial de origen. Abort no sustituye
el chequeo de generación; también descartar éxitos antiguos, incluso logout/login.

403 no se trata como expiración universal: si procede de acceso Agro/sesión, mostrar
estado sin acceso y limpiar datos de cliente; si es recurso, vista no disponible.
No mantener la UI de otro cliente al desasignar. Implementar parser de errores
dual con validación runtime y mensajes seguros, 204 sin JSON y no borrar sesión
válida por 503/red. Logout local inmediato puede proteger UI, pero debe distinguir
revocación confirmada de fallo. No reintentar automáticamente un login/challenge
consumido o una mutación con efectos desconocidos.

CampoProvider necesita fuente real aprobada en otra operación de negocio; iniciar
sesión no vuelve real /auth/demo/campos ni habilita un listado inexistente. No se
agrega /campos a este contrato de autenticación. Hasta resolverlo, un login real
solo acredita sesión, no integración completa del dashboard/sensores.

## 17. Dependencias BE-02/03

BE-02: existencia/propiedad del catálogo usuario-cliente, BSON y mappers, significado
de lotes y correlación de recursos, asignaciones históricas, escrituras confiables
y modelo/índices de sesión. No bloquear verificación criptográfica offline por
unidades o calibración: no son dependencias de esa pieza.

BE-03: D03-01 proveedor/sesión, D03-04 envelope, D03-10 validación, D03-11 identidad
completa; aprobar cuatro operaciones, errores, headers y DTOs/OpenAPI coordinadamente.
No modificar contratos de negocio/telemetría para acomodar hipótesis de auth.

## 18. Dependencias Atlas/persistencia

No se accedió a Atlas. Antes de activar auth: evidencia del catálogo y store elegido,
entorno aislado, permisos mínimos, índices/provisionamiento revisados, TLS/red,
read/write concern, presupuesto de conexiones y recuperación ante fallo. Mongoose
actual no crea automáticamente colecciones/índices: incorporarlos exige tarea y
autorización propias; el schema en código no los vuelve existentes.
Si Mongo no se aprueba para sesiones, sustituir por store durable equivalente detrás
del puerto sin combinar dos autoridades de sesión. No usar memoria local como fallback.

## 19. Dependencias Vercel y configuración

Node 24/ESM/Express default export se conservan. Caché de claves/pool por instancia
puede reutilizarse; no usuario/token/scope global ni cierre del pool por request.
Instancias y concurrencia multiplican el presupuesto de conexiones: el límite de
cinco de BE-07 no es un límite global. La documentación de pooling de Vercel es
referencia operativa, no prueba de nuestro despliegue ni autorización para instalar
su helper o aplicarlo sin comprobar compatibilidad con Mongoose.
[Vercel pooling](https://vercel.com/kb/guide/connection-pooling-with-functions).

Config propuesta, **no añadida a .env.example**: GOOGLE_CLIENT_ID por entorno;
AUTH_SESSION_SOURCE/ENV; AUTH_SESSION_ABSOLUTE_MS/IDLE_MS; AUTH_LOGIN_CHALLENGE_MS;
AUTH_ALLOWED_ORIGINS exactos; timeouts de verificador/store. URI/secretos solo en
configuración autorizada, no en VITE_* salvo client ID público; nunca client secret
o URI DB en FE. Audience no proviene del request. Fail-closed al activar auth con
config faltante; health/import/tests no requieren configuración de Google/Atlas.

Proponer presupuesto total inicial de 10 s para login (clave pública hasta 3 s,
conexión hasta 5 s, resto dentro del deadline), revisable tras medir; no asumir que
Promise.race cancela una escritura ni que maxDuration remoto lo permite. Límite y
política de rate limiting distribuido son gates operativos, no un contador por
worker. Valores iniciales a evaluar: 5 intentos login/minuto por dimensión de abuso
permitida y 20 challenges/minuto, sin persistir IP por defecto ni confiar en XFF
no validado; acordar extracción confiable, privacidad y protección en la plataforma.

Production Branch=main viene de confirmación del usuario en la consolidación;
orígenes/dominios/variables y automatizaciones internas no se consultaron aquí.
Preview autorizado con SHA/entorno comprobados y humo HTTP/CORS sigue necesario.
No se hacen despliegues, cambios de settings o pruebas contra servicios reales.

## 20. Riesgos residuales

Bearer en JS y robo por XSS; indisponibilidad o consistencia insuficiente del store;
revocación del IdP no sincronizada instantáneamente con sesión Agro; sesión ya
admitida en vuelo; configuración/orígenes reales desconocidos; catálogo físico sin
evidencia; fuente agro no accesible; ausencia de pruebas reales Google/Atlas/Vercel.
Logout Agro no revoca consentimiento Google. Un eventual canal de notificaciones
de seguridad del proveedor es una decisión posterior, no requisito ya implementado.
No presentar mocks ni cumplimiento de tipos como prueba de autenticación productiva.

## 21. Decisiones técnicas propuestas y preparación local

Se selecciona una recomendación principal (GIS+C), cuatro operaciones, catálogo
preaprovisionado, sesión opaca con binding/version, no refresh/JWT propios, no signup,
no duplicar /me/verify, no cookie paralela ni estado de sesión en worker. Es diseño,
no aprobación del equipo. Parámetros y comportamiento público requieren ratificación.

**No se implementa código preparatorio adicional:** las capacidades, estados,
schemas y puertos genéricos ya existen. Issuer/challenge y la extensión de pertenencia
dependen del contrato de sesión propuesto; implementarlos antes de decidirlo fijaría
prematuramente protocolo y persistencia. Se preparan DTOs/puertos documentales,
matrices, criterios y tareas concretas; no duplicar helpers solo para producir código.

## 22. Decisiones externas y puertas de aprobación

1. Responsable FE/BE ratifica Google y confirma si agro u otro sistema tiene IdP
   existente reutilizable; acceso/evidencia de ese repo pendiente.
2. Equipo acepta C y riesgo de sesión JS o elige B **antes** de desarrollar transporte;
   acuerda persistencia/UX de recarga y cookies/topología si cambia la elección.
3. Responsable de datos demuestra catálogo y propiedad, tipos e índices; aprueba
   provisión de usuarios/cliente, store de sesión y consistencia/revocación/versionado.
4. FE/BE aprueba cuatro DTOs/rutas/errores, nombres de tiempos, logout 204 y correcciones
   F09-01/02/03; valida la extensión interna de SessionReference y handler compartido.
5. Infra confirma proyectos/client IDs, orígenes, entorno aislado, claves públicas
   accesibles, límites/deadlines/rate limiting y Preview autorizado, sin revelar secretos.
6. Equipo aprueba tiempos, semántica de solicitudes en vuelo y operación ante fallos.

Sin esas puertas no activar login productivo ni declarar BE-09.2B aprobado. Se puede
revisar/estimar y preparar pruebas offline de contratos acordados; eso no sustituye
las decisiones externas ni autoriza instalación/implementación en esta tarea.

## 23. Plan concreto BE-09.2B y cierre de A

| Orden | Trabajo propuesto | Archivos/capa candidatos | Salida verificable / gate |
|---|---|---|---|
| B0 | Aprobar decisiones y contrato | BE-03/OpenAPI/decisiones + FE coordinado | Evidencia responsable/fecha; sin suplantar propuestas por aprobaciones |
| B1 | Precisar puertos de aserción/emisión/challenge y pertenencia con sesión | auth/contracts; service; schemas internos | Sin Express en service; tests de discriminantes y sanitización |
| B2 | Aprobar SDK y adapter GIS | adapters/google-identity; config/auth | Firma/claims/nonce, errores tipados, fetch acotado, fixtures offline; Node24/ESM comprobados |
| B3 | Store y catálogo aprobados | repositories/models con mappers explícitos | Digest, unique/TTL revisados, claim atómico, revocación/binding consistentes en DB aislada |
| B4 | Servicios de login/session/logout | services, sin SDK directo ni DTO Mongoose público | Un uso de challenge, no JIT signup ni restauración de sesión revocada |
| B5 | DTO/Zod/controllers/routes auth y observabilidad compartida | dto/middlewares/controllers/routes/http | Cuatro operaciones; handler BE-08 scoped, UUID único, health/CORS conservados |
| B6 | Cambio FE aprobado en su repositorio | GIS, store, apiFetch, AuthProvider, guards | Recarga/logout, generación, 204 y parser dual; sin Google demo productivo |
| B7 | Validación completa y dos clientes | pruebas unit/integración + regresión 160 | Matriz T2A; resultados reales, sin mocks confundidos con criptografía o DB |
| B8 | Preview e integración autorizados | configuración operativa y PR | SHA/entorno reales, humo HTTP, sin Production ni Atlas no autorizado |

Validación A: revisión estática de fuentes, tres microcasos FE en memoria, enlaces,
consistencia de rutas/DTO/estados/pruebas y whitespace. Suites BE/FE, npm ci,
typecheck/build no se reejecutan al no modificar código. Sin nuevas ramas, commit,
push, PR, despliegue o datos. Solo este informe y su matriz se crean en dev; main,
FE, IoT, trabajo BE-09 original y respaldos permanecen preservados.
