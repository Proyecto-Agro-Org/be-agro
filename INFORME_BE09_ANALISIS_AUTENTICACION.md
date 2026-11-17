# BE-09.0 — Análisis de autenticación, sesión y aislamiento por cliente

Fecha: 17/11/2026. Estado: **investigación BE-09.0 completa e infraestructura interna
BE-09.1 implementada localmente**; autenticación real aún pendiente, no Done.
El diagnóstico de fuentes de este informe corresponde a la base BE-08 inspeccionada,
no afirma que los módulos internos añadidos después sigan ausentes. No se creó un
mecanismo ficticio de producción ni un endpoint. Este informe no aprueba BE-03.
Estado vigente de implementación/pruebas:
[infraestructura BE-09.1](INFORME_BE09_1_INFRAESTRUCTURA_AUTORIZACION.md) y
[auditoría BE-09.1](INFORME_BE09_1_AUDITORIA_SEGURIDAD.md).

## 1. Resumen ejecutivo

El frontend observado tiene login email/password y manejo de un token Bearer en
sessionStorage. Google es **solo demo MSW**: no hay SDK/flujo OAuth/OIDC operativo
en las fuentes inspeccionadas y su botón queda deshabilitado sin mocks. El backend
actual implementa health e infraestructura, pero no autentica usuarios, emite
sesiones ni filtra recursos de negocio por cliente. El repo de integración contiene
documentación, no otro servidor de autenticación en el commit revisado.

**No está demostrada autenticación segura de extremo a extremo.** No se infiere
la existencia ni ausencia de otro servicio desplegado fuera de estas fuentes:
VITE_API_BASE_URL podría apuntar a un servicio distinto cuya configuración efectiva
no se consultó. Los mocks y la navegación privada no prueban seguridad del backend.

Recomendación condicionada: confirmar el proveedor único previsto por el equipo
(Google es objetivo documental, no implementación existente), verificar identidad
en servidor y resolver su pertenencia desde un catálogo confiable. Si se confirma
Google, evaluar su intercambio por una sesión opaca revocable de aplicación,
conservando inicialmente transporte Bearer para reducir cambios; valorar cookie
HttpOnly como alternativa de navegador cuando se acuerden dominios/CSRF/CORS.
Ningún transporte/proveedor nuevo queda aprobado por esta recomendación.

## 2. Repositorios, referencias y límites de acceso

| Fuente | Referencia inspeccionada | Forma / conclusión |
|---|---|---|
| be-agro | `63c7eb20882e1e63e9ed03e2b6afa0a91e124afc` | Local, BE-08 remoto verificado con fetch; base de esta rama |
| fe-agro | `daa72a828eb79aad0f09dcb7786a2c5a4adfd3bc`, rama local dev | Árbol limpio, lectura de fuentes/config/tests/docs; no se hizo fetch ni modificación allí |
| agro | main `422dc7aace5d1b6b3e895cb166f21ead4a7b52b8` | Git/API GitHub de lectura; árbol recursivo completo, sin truncamiento |
| BE-02 / PR #2 | `28556ff485f2a9f2f2239c0a612ac623dc33fdef` | git show de rama remota: informe/modelo como propuesta, Atlas pendiente |
| BE-03 / PR #3 | `c2a4b3175eef12b91e0d1e554082b4d281cdbe55` | Decisiones, DTO/OpenAPI de propuesta; no se cambió su rama ni se presume aprobación |
| Plan/DoD/especificación/AGENTS | Archivos de la base BE-08 | Jerarquía, una entidad por usuario, 404 ajeno y responsabilidades vigentes |

Se creó `feature/be-09-autenticacion-analisis` desde el SHA esperado, preservando
el único archivo previo sin seguimiento, INFORME_BE05_VERCEL_DEPLOYMENT.md.
Su SHA256 continúa siendo
`6445DC2925627E49F9C8EEE03BAD3DF67362761DC155DD4E9DF422A6280A5E5D`.

Git rechazó inicialmente el ownership de fe-agro en el sandbox; se usó safe.directory
solo como opción de esa invocación y --no-optional-locks para status, sin cambiar
configuración global ni refrescar su índice. Se inspeccionaron 184 archivos
versionados para huella de integridad; no se leyeron .env privados.

El conector devolvió 404 para agro, pero el acceso Git universitario existente
permitió resolverlo y leerlo. No es un bloqueo vigente ni prueba de inexistencia.
Se consultaron README, DoD y únicamente nombres de variables del ejemplo. Su árbol
tiene documentación/configuración e imágenes/PDF; no contiene los directorios de
implementación frontend/backend anunciados en el README. Los binarios se
inventariaron, no se tomaron como evidencia de una implementación ejecutable.

El acceso autorizado a GitHub se utilizó exclusivamente para el repositorio, no
como identidad de Agro. No se inició sesión con Google, se usaron credenciales
reales de usuarios de Agro ni se accedió a Atlas/Vercel/servicios desplegados.

## 3. Evidencia principal trazable

| ID | Fuente de código/documento | Qué demuestra |
|---|---|---|
| E01 | [LoginPage](https://github.com/Proyecto-Agro-Org/fe-agro/blob/daa72a828eb79aad0f09dcb7786a2c5a4adfd3bc/src/pages/LoginPage/LoginPage.tsx) | Formulario y Google condicionado a mocks |
| E02 | [AuthContext](https://github.com/Proyecto-Agro-Org/fe-agro/blob/daa72a828eb79aad0f09dcb7786a2c5a4adfd3bc/src/app/AuthContext.tsx) | Inicio/limpieza, recuperación solo demo y revisión contra respuestas tardías de identidad |
| E03 | [sesion.ts](https://github.com/Proyecto-Agro-Org/fe-agro/blob/daa72a828eb79aad0f09dcb7786a2c5a4adfd3bc/src/api/sesion.ts) | Claves sessionStorage y evento global de expiración |
| E04 | [client.ts](https://github.com/Proyecto-Agro-Org/fe-agro/blob/daa72a828eb79aad0f09dcb7786a2c5a4adfd3bc/src/api/client.ts) | Bearer desde storage, sinSesion, 401 y error:string |
| E05 | [login.ts](https://github.com/Proyecto-Agro-Org/fe-agro/blob/daa72a828eb79aad0f09dcb7786a2c5a4adfd3bc/src/api/login.ts) | Login observado, Google/recuperación exclusivamente demo |
| E06 | [RutasProtegidas](https://github.com/Proyecto-Agro-Org/fe-agro/blob/daa72a828eb79aad0f09dcb7786a2c5a4adfd3bc/src/app/RutasProtegidas.tsx) | Guard de UI por presencia de token |
| E07 | [CampoProvider](https://github.com/Proyecto-Agro-Org/fe-agro/blob/daa72a828eb79aad0f09dcb7786a2c5a4adfd3bc/src/app/CampoProvider.tsx) y api/campos.ts | Campos disponibles solo con mocks; preferencia no es permiso |
| E08 | [mocks de login](https://github.com/Proyecto-Agro-Org/fe-agro/blob/daa72a828eb79aad0f09dcb7786a2c5a4adfd3bc/src/mocks/handlers/login.ts) y data/identidades.ts | Tokens fijos públicos, sin proveedor externo |
| E09 | [alcance mock](https://github.com/Proyecto-Agro-Org/fe-agro/blob/daa72a828eb79aad0f09dcb7786a2c5a4adfd3bc/src/mocks/data/alcance.ts) | Resolución por token y campo/recurso ajeno 404 en MSW |
| E10 | [tipos dominio](https://github.com/Proyecto-Agro-Org/fe-agro/blob/daa72a828eb79aad0f09dcb7786a2c5a4adfd3bc/src/types/dominio.ts) y types/auth.ts | IDs públicos string e identidad opcional en LoginRespuesta |
| E11 | [app backend](https://github.com/Proyecto-Agro-Org/be-agro/blob/63c7eb20882e1e63e9ed03e2b6afa0a91e124afc/src/app.ts) y routes/health.routes.ts | Solo health, sin middleware de sesión |
| E12 | [árbol de integración](https://github.com/Proyecto-Agro-Org/agro/tree/422dc7aace5d1b6b3e895cb166f21ead4a7b52b8) | No código de autenticación de otro servidor en esa referencia |
| E13 | [BE-02](https://github.com/Proyecto-Agro-Org/be-agro/blob/28556ff485f2a9f2f2239c0a612ac623dc33fdef/INFORME_BE02_MODELO_DATOS.md) | Modelo lógico, identidad/tenant y correlación física pendientes |
| E14 | [decisiones BE-03](https://github.com/Proyecto-Agro-Org/be-agro/blob/c2a4b3175eef12b91e0d1e554082b4d281cdbe55/docs/DECISIONES_BE03.md) | D03-01/02/04/08/11 sin cerrar |

Se leyeron también main/App/router, layout/logout, useApi, mocks/browser y registro,
API de los ocho recursos de consulta, pruebas de AuthContext/rutas/client/login y
alcance multicliente; docs LOGIN/SESION-MULTICLIENTE/SELECTOR-CAMPOS/FILTRO-CAMPO.
No se ejecutó la suite frontend. Los docs A05/A06 describen etapas anteriores:
sus frases sobre datos globales no reemplazan el aislamiento mock posterior que
sí está presente en E09 y las consultas por campo actuales.

## 4. Flujo de login observado

```text
LoginPage → login(email,password) → apiFetch(sinSesion=true)
         → POST {base}/auth/login → MSW si está habilitado, o destino configurado
         → LoginRespuesta.token → AuthProvider.iniciarSesion
         → [solo mock] POST /auth/demo/sesion → identidad de tabla demo
         → guardar token/modo → RutaSoloPublica → Dashboard
```

La base por defecto es /api/v1; la URL efectiva proviene de VITE_API_BASE_URL.
No se inspeccionó la configuración de un despliegue. No hay interceptor OAuth:
apiFetch es el cliente fetch común. El formulario recorta email, mantiene password
en estado React y lo vacía ante 401; no se observó almacenamiento persistente de
password. El ref de solicitudEnCurso evita dobles envíos entre métodos.

Google llama a /auth/google-demo solo con VITE_USE_MOCKS exactamente true. No abre
un proveedor, no obtiene ID token/access token y no usa GIS/Firebase/Auth0 ni otra
biblioteca de identidad en package/source/index inspeccionados. La respuesta es
una sesión demo predefinida. Sin mocks, botón deshabilitado y helper rechaza antes
de fetch. El token real del contrato es solo string: no demuestra JWT, firma,
issuer, access token de Google ni validación criptográfica.

## 5. Persistencia, recarga, expiración y logout

| Operación | Modo mock | Modo sin mocks |
|---|---|---|
| Persistir | agro_token y agro_modo_sesion en sessionStorage | Igual, marcado real |
| Identidad tras login | Resuelta por token en tabla MSW, no por cliente elegido | Solo si respuesta incluye usuario/cliente completos y coherentes |
| Recarga | Recupera identidad contra /auth/demo/sesion; spinner mientras tanto | Recupera token, no valida sesión ni recupera identidad real |
| Expiración | Evento ante 401 de API fuera de sinSesion; no TTL real demostrado | Mismo evento; no refresh ni validación previa implementada |
| Logout | Limpia memoria/storage, invalida recuperación tardía | Mismo efecto local; no revocación en servidor |
| Ruta privada | Presencia de token y fin de recuperación | Token no vacío basta para navegación, no prueba de validez |

Una marca de modo incompatible provoca limpieza. Tokens antiguos sin marca conservan
compatibilidad; esa marca es dato manipulable del navegador, no garantía de seguridad.
localStorage guarda tema y preferencia de campo separada por cliente, no una fuente
de autorización. Cambiar de identidad remonta CampoProvider y cancela carga anterior.
Sin mocks no se consulta el endpoint demo de campos: el selector no está disponible
y Dashboard evita pedir datos globales cuando no tiene campo seleccionado.

No hay temporizador de exp ni renovación observados. Los tokens demo son constantes
reutilizables. Cerrar pestaña no es revocación backend; sessionStorage puede sobrevivir
recargas/restauraciones según el navegador ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage)).

## 6. Qué viaja al backend

apiFetch envía Accept, Content-Type JSON solo con body y Authorization: Bearer del
storage salvo sinSesion. Login no envía un Bearer anterior. No configura
credentials:include ni una cookie de sesión propia. Esto no significa que fetch
jamás envíe cookies: su comportamiento por defecto puede incluir las del mismo
origen; el transporte cross-origin con cookies no está preparado expresamente.

Las consultas actuales envían campo_id y IDs de ruta de área/dispositivo, no un
cliente_id como permiso. Esos IDs son selecciones de recurso y deben validarse en
servidor, nunca inferir autorización por provenir del selector o haber pasado UI.

## 7. Backend base BE-08 inspeccionado y reutilización

No existen login, sesión, logout, middleware autenticador, UserRepository ni
repositorios privados. UNAUTHENTICATED/FORBIDDEN son categorías disponibles de
BE-08, no prueba de autenticación implementada. Solo GET/HEAD health es funcional.

Reutilizables: factory Express/default export y listener separado; capas health;
config CORS exacta; Mongoose explícito con apertura compartida y cierre controlado;
Zod safeParseAsync/accessor privado; errores tipados/adaptador; UUID/logs proyectados;
404 seguro y protección de errores tardíos. No conectar DB por import ni por health.

El perfil HTTP completo sigue optativo. Un futuro router auth necesita parser y
traducción segura de errores en su composición aprobada; no basta lanzar un error
tipado contra el handler legacy para obtener el DTO público final esperado.

## 8. Usuario, identidad externa y cliente

| Identificador | Evidencia actual | Límite / propuesta |
|---|---|---|
| token FE | String de respuesta; tablas demo en MSW | Naturaleza de token real no confirmada |
| usuario_id | ID público string de Usuario en FE | No prueba _id BSON ni usuario persistido |
| Identidad externa | Ninguna implementada | Si se confirma Google: identidad verificada por issuer/sub, no email editable |
| cliente_id | String en Usuario/Cliente/Campo mock | La pertenencia real debe venir de catálogo confiable del servidor |
| entityId | Convención interna propuesta por BE-02 | No campo físico confirmado en Atlas |
| campo_id / area_id | IDs públicos de recurso, referencias FE | Resolver dentro de la entidad autorizada |
| device_id | Identificador público de sensor | No equiparar a _id Mongo ni alias MQTT |
| clientid MQTT | Alias de dispositivo en la ingesta documentada | No identifica al cliente empresarial |

La identidad GitHub del desarrollador no es identidad del usuario de Agro. En
mock el token busca usuario_id y desde él cliente_id; en producción esa tabla
pública no es reutilizable como verificador. Cliente → Campo → Área → Dispositivo
→ Medición es jerarquía acordada; los tipos BSON, catálogos/relaciones, lotes y
correlación telemetría siguen pendientes. No hay roles implementados; no se propone
RBAC por endpoint en esta etapa ni confiar en un role enviado por el navegador.

## 9. Hallazgos concretos adicionales del frontend

Se hicieron tres microverificaciones sobre tres módulos reales (sesion/client/comun),
transpilados en memoria con TypeScript instalado. fetch/storage se sustituyeron por
dobles, import.meta.env por configuración sintética. Cero peticiones externas,
cuentas reales o escrituras frontend. No equivalen a tests de navegador ni al suite
frontend completo. No se añadió código ni archivos de prueba al proyecto.

| ID | Resultado comprobado | Riesgo y acción fuera de esta implementación |
|---|---|---|
| F09-01 | Solicitud con token A pendiente; se guarda token B; llega 401 de A; B se borra | Medio: cierre incorrecto de la sesión nueva. Vincular expiración al token/generación que originó la solicitud; AuthContext.revision no cubre este evento global |
| F09-02 | Storage denegado: guardarToken no deja token disponible y apiFetch no envía Authorization | Medio de disponibilidad/coherencia: el contexto todavía puede conservar token en memoria por su código. Acordar fuente única de transporte o fallar el login; la promesa documental de fallback solo en memoria no está completa |
| F09-03 | Respuesta 403 con error:{code,message} termina en mensaje [object Object] | Incompatibilidad demostrada con propuesta BE-03; hoy BE-08 mantiene error:string. Migrar lector/frontend de forma coordinada |

No se corrigieron en fe-agro por la restricción explícita de lectura. No se demuestra
exposición cruzada de datos por estos tres casos; no se los presenta como ataques
reales. Las pruebas ya escritas de FE cubren varios flujos demo, pero no se
ejecutaron ni se atribuye a esta tarea su resultado previo.

## 10. Modelo de amenazas y controles propuestos

| Amenaza | Riesgo al habilitar negocio | Control necesario |
|---|---|---|
| Sin credencial / token arbitrario | Alto | Middleware deny-by-default en toda ruta privada; health explícitamente público |
| Token alterado, issuer/audience incorrectos o expirado | Alto | Verificador servidor, política cerrada de credenciales y reloj/exp; 401 genérico |
| Token robado de otro usuario / replay | Alto | TLS, exposición mínima, vencimiento y revocación; Bearer robado sigue siendo reutilizable, no se promete distinguir al ladrón |
| Usuario válido sin alta/cliente activo | Alto | Catálogo interno confiable, denegación sin tenant default ni alta automática por email |
| Cliente/campo/área/device manipulados, IDOR | Alto | Repositories ligados a scope verificado, validar cadena y responder 404 ajeno |
| NoSQL/operator injection | Alto | Validar IDs/duplicados/forma con Zod y construir filtros explícitos, no copiar query/body en Mongo |
| Privilegios/roles enviados por cliente | Alto | Ignorarlos como autoridad; sin RBAC adicional en esta fase |
| Logout solo local o JWT revocado que sigue válido | Alto | Revocación aplicación y validación server de estado; definir logout según mecanismo elegido |
| Cookies mal configuradas / CSRF | Alto si se eligen | HttpOnly/Secure/SameSite adecuado, protección CSRF y orígenes de confianza; no activar credentials:* |
| Credenciales en storage/URLs/logs | Alto | No incluir tokens en URL ni logs; minimizar almacenamiento JS y mantener allowlist BE-08 |
| Caché con clave solo deviceId / tenant ausente | Alto | Cachear con scope y parámetros; sin fallback global si falta pertenencia |
| Historial de dispositivo reasignado | Alto | Correlación/propiedad temporal aprobada; no asignar lecturas antiguas al dueño actual por inferencia |
| 401 tardío / respuestas tras logout | Medio | Generación por sesión, cancelación y descarte de respuestas obsoletas |
| Proveedor o DB no disponibles | Disponibilidad | Falla cerrada; no convertir fallo técnico en sesión válida ni confundirlo con token inválido |

Los riesgos altos son amenazas de una implementación futura sin controles, no
explotaciones observadas de endpoints privados existentes: esta API aún no expone
esos datos. Evitar guardar credenciales accesibles a JavaScript y tratar CORS como
control diferente de autenticación sigue [OWASP HTML5](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html).

## 11. Alternativas comparadas

| Alternativa | Compatibilidad FE | Seguridad/ciclo | Complejidad, Vercel y configuración | Evaluación |
|---|---|---|---|---|
| Reutilizar IdP/sesión real ya existente | Ideal si aparece evidencia | Depende de verificador/contrato existente | Investigar antes de agregar SDK | No se encontró en estos repos; no inventarlo |
| Google ID token en cada request | Requiere FE obtenerlo; Bearer conocido | Valida identidad pero no resuelve revocación/logout propio ni pertenencia | Verificador/JWKS y catálogo; rotación/exp deben verificarse | No preferido como sesión de aplicación por sí solo |
| Google verificado → sesión opaca con Bearer | Reutiliza header/token string, no el login Google actual | Revocable y expiración propia; storage JS conserva riesgo de robo | Store compartido, verificador y catálogo; compatible con workers si se diseña así | Candidata de transición si se confirma proveedor/flujo |
| Sesión opaca con cookie HttpOnly | Necesita ajustar FE/recuperación; puede usar proxy mismo origen | Reduce lectura de token por JS, no elimina XSS; requiere CSRF | Orígenes/cookies/routing y store compartido; Preview entre dominios complica | Candidata de navegador a decidir con topología real |
| JWT firmado por backend | Header/token compatibles, login aún pendiente | Verificación local; logout inmediato exige estado adicional o aceptar ventana | Claves/rotación/algoritmos/refresh amplían alcance | No elegir solo por evitar una consulta DB |
| Password local paralelo | Formulario compatible visualmente | Exige hashing, altas, recuperación, controles de intentos y ciclo de secretos | Otro sistema de credenciales sin evidencia ni aprobación | No recomendado ahora |

Sesión opaca de aplicación después de un único IdP no significa un segundo proveedor
de contraseñas: separa identidad externa del ciclo de acceso de Agro. No instalar
OAuth/JWT por anticipado. Si se necesita acceso a APIs de Google, es otro permiso:
un access token de Google no sustituye automáticamente un ID token ni la sesión.

## 12. Verificación externa: propuesta condicionada a Google

Si el equipo confirma Google, usar verificador servidor mantenido, validar firma,
issuer, audience configurada y expiración; identificar por sub dentro del issuer
permitido. No aceptar email/clientId del navegador como pertenencia ni enlazar
cuentas solo por coincidencia de email. Nonce/CSRF/state y, si se elige flujo de
código, PKCE/redirects exactos se diseñan según el flujo aprobado. No usar un simple
decode JWT como validación. La política de dominio Workspace, si se requiere,
usa el claim correspondiente verificado, no el texto del email.
Fuentes: [Google, validación ID token](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
y [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html).

El SDK Node sugerido por Google es un candidato a evaluar después del acuerdo;
no está instalado ni se verificó configuración OAuth real. No se crearon client
IDs, secrets, consentimientos, usuarios ni sesiones. La propuesta JWT alternativa
requeriría política cerrada de algoritmos/claims/tipos y claves, conforme a
[RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html); no se implementó.

## 13. Ciclo propuesto de sesión

Validar proveedor → buscar usuario interno activo → resolver cliente activo y
asignación única → emitir sesión de aplicación → validar sesión/estado por request
→ construir scope → consultar repositorios → revocar al salir/vencer.

Para una sesión opaca, proponer identificador aleatorio, guardar solo representación
no reutilizable del secreto en el store, referencias internas/expiración/revocación
y validar vencimiento en servidor. Store y nombres físicos quedan sin aprobar.
No usar Map de proceso como store productivo: los workers Vercel no son un único
proceso. Definir duración absoluta/inactividad, renovación y efecto de desactivar
usuario/reasignar cliente antes de implementar. Logout debe revocar estado y limpiar
cliente; no garantiza deshacer una respuesta ya enviada. Referencia de ciclo:
[OWASP sesiones](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

Si se elige Mongo para sesiones, su TTL es limpieza, no validación de autorización:
puede retrasarse; comprobar expiresAt/revocación en cada uso. No se creó un índice
ni colección. Fuente: [MongoDB TTL](https://www.mongodb.com/docs/manual/core/index-ttl/).

## 14. Diseño del contexto confiable

Proponer un contexto interno inmutable con identificador de usuario, entidad
autorizada y referencia/expiración de sesión; identidad externa solo cuando sea
necesaria internamente. Son conceptos, no nombres/tipos BSON aprobados.
Solo AuthMiddleware puede obtenerlo de SessionService/IdentityAdapter verificados.
Un accessor privado por request falla si falta contexto; no basta una interfaz TS
ni aceptar req.auth del body. Sin contexto no se construye un repository privado.

No usar estado global de usuario actual ni credenciales demo como bypass. No
transportar un tenant arbitrario desde middleware a repositorios por un cast.
El binding debe comprobarse en runtime y quedar respaldado por tests de contexto.

## 15. Autorización obligatoria en repositories

Recomendar una factory de repositorios privados ligada a VerifiedScope, con scope
obligatorio e inaccesible desde JSON público. Los services reciben operaciones
ya acotadas, no una API pública de findById sin entidad. No exportar modelos crudos
a controllers/services ni permitir filtros Mongo arbitrarios desde HTTP.

El repository resuelve campo dentro del cliente, área dentro de ese campo y
dispositivo dentro del área; consulta mediciones solo mediante correlación confiable
del dispositivo autorizado y contexto histórico acordado. Listas, count, agregados,
lookups/populate, paginación y cachés deben mantener el mismo scope. No recuperar
datos de todos los clientes para filtrarlos luego en JavaScript.

Si una colección no tiene tenant, no se inventa el campo: resolver por catálogo y
relaciones aprobadas dentro de la capa de persistencia, o no habilitar la operación
si la correlación es ambigua. IDs no adivinables no reemplazan permisos. Ver
[OWASP IDOR](https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html).
El principio de denegar por defecto y validar cada request está alineado con
[OWASP autorización](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).

## 16. Casos de acceso y status propuestos

| Caso | Propuesta | Observación |
|---|---|---|
| Input/body/ID de forma inválida | 400 | Zod antes de usar el dato; sin incluir el valor en errores |
| Credencial ausente, inválida, expirada o sesión revocada | 401 | Mensaje genérico; acordar challenge y códigos BE-03 |
| Identidad externa válida sin alta autorizada/cliente activo | 403 | Denegar sin tenant default; evitar enumerar usuarios/clientes |
| Usuario con cliente y recurso válido | 200 según contrato | Repository scoped; no aceptar pertenencia declarada por FE |
| Recurso inexistente o ajeno, incluida cadena inconsistente | 404 | Respuesta indistinguible y sin consulta fuera de scope |
| Fallo inesperado/configuración interna | 500 | BE-08, sin causa pública |
| Proveedor/store temporalmente indisponible | 503 candidato | BE-08 dispone categoría; confirmar BE-03, no fingir 401 ni éxito |

La política de usuario desconocido en login debe ser uniforme con el método elegido:
si se mantuviera password, no revelar existencia de email. Los códigos de esta
tabla son diseño para nuevas rutas, no cambios a health/CORS ni contratos aprobados.

## 17. Operaciones HTTP necesarias y contratos pendientes

| Operación | Evidencia / necesidad | Ruta y forma |
|---|---|---|
| Login actual | POST /auth/login con email/password, token requerido | Observado en FE; no implementado por BE ni aprobado como login Google |
| Intercambio de identidad verificada por sesión | Necesario si se confirma la alternativa federada | Path/body por acordar; no copiar google-demo |
| Consultar identidad/sesión vigente y restaurar tras recarga | Falta real; demo tiene /auth/demo/sesion | Acordar una única operación, sin duplicar me y validate sin necesidad |
| Logout/revocación | FE hoy solo limpia localmente | Path/método/DTO por acordar; efecto servidor idempotente definido |
| Renovación | No existe, necesidad depende de duración | No crear refresh endpoint por anticipado |
| Catálogo de campos | Hoy solo GET /auth/demo/campos | Ruta real, p.ej. la propuesta de BE-03, pendiente; corresponde también a BE-10 |

La base por defecto /api/v1 no aprueba todos los paths futuros. LoginRespuesta
permite solo token; eso no alcanza para resolver identidad/campos reales tras recarga.
Completar respuesta de login no sustituye el endpoint de restauración. El lector
apiFetch consume JSON en todo éxito: un futuro 204 logout requiere adaptar el cliente
o acordar un 200 JSON. No se implementa ninguna de esas alternativas aquí.

## 18. Encaje en capas

| Pieza propuesta | Responsabilidad | Reutilización / límite |
|---|---|---|
| Auth router/controller | DTO/HTTP y llamada de aplicación | Zod/errores BE-08; sin Mongo ni SDK |
| IdentityProviderAdapter | Verificar credencial externa | SDK solo tras confirmar proveedor; no expone su excepción original |
| SessionService | Sesión/expiración/revocación | Sin Request/Response; store por interfaz |
| UserRepository | Identidad externa → usuario interno activo | Esquema/índice de identidad sujeto a BE-02; no email como FK |
| Client authorization service | Usuario → pertenencia activa y consistente | Sin roles adicionales ni cliente seleccionado por FE |
| AuthMiddleware + accessor | Recuperar/verificar sesión y fijar contexto | Composición explícita de rutas privadas; health público |
| Repositories scoped | Consultas/joins/cachés dentro de pertenencia | Obligatorio, sin modelos expuestos al service |

No se requieren una jerarquía genérica de providers o buses de eventos para este
alcance. Separar adapter y store permite doubles deterministas sin implementar
un segundo sistema ni abrir una vía demo en producción.

## 19. Estrategia de pruebas BE-09

La matriz detallada está en
[MATRIZ_BE09_AUTENTICACION_AUTORIZACION.md](MATRIZ_BE09_AUTENTICACION_AUTORIZACION.md).
Usar reloj inyectado, verificador/store/repositories simulados y dos usuarios/clientes
con IDs que provoquen colisiones intencionales. No requerir Atlas/Google real.
Validar que la capa de datos recibió el filtro, no solo que el controller devolvió 404.

Casos mínimos: sesión válida/inválida/expirada/revocada/ausente; firma/issuer/aud
incorrectos; usuario o cliente desconocido/inactivo; recursos ajenos por cada nivel;
dos tenants concurrentes; manipulación de IDs y operadores; exp en borde; logout
repetido/replay después de logout; recuperación/401/respuestas tardías; fallos de
proveedor/DB; logs y callbacks sin datos sensibles; health sin credenciales ni DB.
Los stubs no deben poder activarse en la composición de producción con un flag demo.

## 20. Decisiones y bloqueos BE-02/BE-03/Atlas

Decidido para este análisis: no confundir Google demo con OAuth, mantener un
proveedor lógico único, identidad/tenant resueltos por servidor, una entidad por
usuario, repositories obligatoriamente scoped y no ampliar roles. La arquitectura
se basa en acuerdos existentes; el mecanismo concreto sigue siendo propuesta.

| Gate | Evidencia externa necesaria | Qué bloquea / qué no |
|---|---|---|
| G01 Proveedor/flujo | Equipo confirma si Google, GIS/código u otro sistema ya existente, y su propietario | Bloquea verifier/login productivos; no diseño de tests/contratos internos |
| G02 Transporte/ciclo | FE/BE acuerdan Bearer/cookie, expiración, renovación, logout y almacenamiento | Bloquea endpoints/sesión definitivos; no análisis de amenazas |
| G03 Catálogo confiable | Fuente autorizada usuario-cliente, alta/baja/asignación y unicidad externa | Bloquea acceso privado; nunca suplir con email del navegador |
| G04 Persistencia/IDs | BE-02: BSON, campos/áreas/dispositivos/mediciones, lotes, correlación y reasignación | Bloquea repositories reales y modelos; no tests con doubles |
| G05 Contrato | BE-03 D03-01/02/04/08/11, errores/identidad/campos/paths | Bloquea API final y cambios coordinados FE |
| G06 Configuración y despliegue | Orígenes/audience públicos aprobados, manejo de secretos servidor, topología Vercel y store | Bloquea integración real/Preview, no suite local |

Si el equipo afirma que ya existe autenticación fuera de estos repositorios,
solicitar su referencia de código/contrato y tipo de credencial antes de elegir
otro proveedor. No hace falta una contraseña personal ni un token pegado en chat.

Atlas necesita acceso de lectura explícitamente autorizado para confirmar el modelo;
esta tarea no lo solicitó ni lo usó. No es una razón para detener todo trabajo
independiente ni para declarar toda BE-09 lista. Configurar cliente OAuth no requiere
pegar secretos en chat: gestionar configuración por el proceso seguro del equipo.

## 21. Plan de implementación BE-09.1

1. Resolver G01/G02/G03/G05: evidencia del proveedor, sesión, contratos mínimos y
   política de asignación. Coordinar correcciones FE F09-01/02 y transición F09-03.
2. Implementar contratos internos mínimos de identidad/contexto y tests de acceso
   sin sesión con doubles; ninguna credencial mágica válida en producción.
3. Implementar un adapter real del proveedor confirmado y SessionService/store
   aprobado. Verificar audience/exp/estado, sin instalar JWT/OAuth antes del gate.
4. Resolver G04 e implementar User/ClientRepository y factories scoped probando
   filtros/joins/cachés con dos clientes. No montar negocio si falta pertenencia.
5. Componer únicamente endpoints auth aprobados, middleware y error adapter del
   perfil HTTP adecuado; conservar health/CORS y las 120 regresiones de BE-08.
6. Alinear recuperación/logout/campos FE y luego realizar integración/Preview
   autorizados. La prueba real sin mocks es criterio posterior de aceptación.

**Lista para iniciar implementación definitiva de autenticación: NO.** Hay diseño
y matriz listos para trabajo aislado con doubles; los gates anteriores impiden
elegir/verificar credenciales y autorizar datos reales sin inventar hechos.

## 22. Validaciones y estado al cierre BE-09.0 (registro histórico)

Entregables únicamente documentales: este informe y su matriz. No se modificó
código, tipos, pruebas persistentes, package/lock, .env ni configuraciones. No se
ejecutaron npm ci/typecheck/build/suite BE en esta tarea porque no hubo implementación;
las 120 pruebas aprobadas de BE-08 son antecedente verificado en su publicación,
no un resultado nuevo inventado para BE-09. Se preservan sus fuentes sin cambios.

Sí se ejecutaron tres microverificaciones en memoria con resultados descritos
en §9, revisión de consistencia/enlaces/estados y git diff --check. Se verificó
que la huella de los 184 archivos FE y su HEAD/status no cambió durante el trabajo.
No se ejecutó la suite FE ni se usaron cuentas reales o ataques a servicios.

HEAD continúa en la base esperada, índice vacío y rama BE-09 local sin upstream
nuevo. main/dev/BE-08 y ramas anteriores no se modificaron. El informe local BE-05
sigue intacto y excluido; documentacion-referencia sigue ignorada. No hay commit,
push, PR, merge, despliegue, producción, Atlas ni cambios de frontend/IoT.

### Actualización BE-09.1

Se implementaron contratos de verificación/identidad/sesión/pertenencia, capacidades
runtime por instancia, contexto por request con liveness y reader de propiedad
ligado al cliente. No se implementó un proveedor, store ni login real; los gates
G01…G06 siguen vigentes para esa integración. Los fakes están solo en pruebas.

Resultados actuales: **160/160 pruebas**, conservando 120 anteriores y añadiendo
40; npm ci, typecheck, build y diff --check aprobados. Diferencial contra esta base
BE-08: **13/13 equivalentes**. El código de app/default, BE-08, Mongoose y Zod previo
no cambió. No hubo modificación del frontend ni corrección de F09-01/02/03 allí.

La infraestructura está lista para revisión/auditoría y futuro Draft de ese alcance;
esto no contradice que la autenticación definitiva siga bloqueada por proveedor,
política de sesión, catálogo confiable y contratos. No se inició BE-09.2 ni se
publicó. La cobertura real de los 30 escenarios aparece en la sección D de la matriz.
