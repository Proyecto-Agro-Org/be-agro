# BE-09.4 — Contrato propuesto de autenticación FE/BE

19/11/2026. Backend dev `07f15511f26d3fce664d892dba7c8ea7bf48cfe1`.
Frontend inspeccionado sin cambios: `daa72a828eb79aad0f09dcb7786a2c5a4adfd3bc`.
**D04/D05 pendientes de aprobación FE/BE/Seguridad. No es OpenAPI aprobado.**

El formato uniforme `{error:{code,message}}` ya está acordado en ESPECIFICACION.md y
docs/DECISIONES_BE03.md (D03-04). D05 trata su aplicación/transición desde legacy y los
status/códigos del flujo nuevo, junto con rutas/DTO; no vuelve a someter ese formato a aprobación.

## Estados

| Estado | Alcance |
| --- | --- |
| Implementado y verificado | Router/controller/DTO y pruebas locales históricas; FE inspeccionado por código ahora |
| Implementado sin prueba real | Adaptador Google y persistencia, sin GIS/MongoDB/Preview reales |
| Propuesto | Montaje `/api/v1/auth`, flujo GIS callback y adaptación FE descrita aquí |
| Pendiente de aprobación | Rutas, DTO obligatorios, Bearer/almacenamiento, TTL y errores D04/D05 |
| Bloqueado | Habilitación: catálogo, MongoDB, GIS, limiter y revisión FE incompletos |
| No aplicable | Password real, Google-demo productivo, cookies de sesión, refresh token y endpoints de negocio |

## Evidencia y diferencias con el frontend

Backend: [router](src/routes/session.routes.ts), [controller](src/controllers/session.controller.ts),
[DTO](src/dto/session.dto.ts), [servicio](src/services/session.service.ts),
[errores](src/errors/application.error.ts), [app default](src/app.ts).
El router es una factory aislada; **app.ts no lo monta**, solo publica health.
Las rutas siguientes tienen prueba local en composición explícita; no existen en la API default
por estar escritas en este contrato. Montaje completo propuesto: `/api/v1/auth`.

Archivos FE relativos a fe-agro, inspeccionados en lectura:
`src/api/login.ts`, `src/types/auth.ts`, `src/api/client.ts`, `src/api/sesion.ts`,
`src/app/AuthContext.tsx`, `src/app/RutasProtegidas.tsx`,
`src/pages/LoginPage/LoginPage.tsx`, `src/mocks/handlers/login.ts`, `vite.config.ts`.

| Hoy en FE | Contrato propuesto / acción posterior |
| --- | --- |
| POST /auth/login con email/password | Misma ruta relativa, body incompatible: provider/credential/challenge_id. No enviar password a BE |
| POST /auth/google-demo y /auth/demo/sesion en MSW | Solo mocks; no convertirlos en rutas productivas |
| LoginRespuesta requiere solo token, identidad opcional | Respuesta real propuesta exige identidad completa y tiempos de sesión |
| Google disponible solo con VITE_USE_MOCKS=true | Integración GIS real separada y gate de entorno; no cambiar mock=true para habilitar |
| Restore solo consulta demo en modo mocks | GET /auth/session antes de habilitar rutas protegidas en modo real |
| Logout borra estado local, sin llamada al BE | POST /auth/logout para revocar, más limpieza local y tratamiento de fallo no confirmado |
| Guard de navegación mira presencia de token | Estado recuperando/identidad validada; guard es UX, nunca autorización de datos |
| URL base VITE_API_BASE_URL o /api/v1 | Mantener relativo /auth/...; decidir origen API real; vite.config no tiene proxy de desarrollo configurado |

### Defectos FE comprobados por lectura, sin corrección en esta tarea

| ID | Evidencia | Cambio/prueba requerida |
| --- | --- | --- |
| F01 | client.ts avisa cualquier 401 y sesion.ts borra el token actual sin comparar con el usado en la petición | Capturar token+generación al enviar; solo invalidar si sigue vigente. Resolver 401 A después de login B y comprobar B intacta |
| F02 | guardarToken captura fallo de storage; AuthContext conserva token en memoria, pero apiFetch solo llama leerToken del storage | Fuente única de sesión en memoria inyectada al transporte; storage como persistencia opcional. get/set/remove lanzan y aun así Bearer de memoria se envía |
| F03 | leerMensajeError castea error a string; ErrorApi extiende Error. Un objeto `{error:{code,message}}` acaba como mensaje no útil, p.ej. [object Object] | Parsear unknown, validar code/message seguros; conservar estado y code; fallback para legacy durante transición aprobada |
| F04 | apiFetch siempre ejecuta respuesta.json() incluso con 204 | Retorno void para 204 sin parsear JSON; logout vacío debe resolver y limpiar UX sin falso fallo |

F04 es una incompatibilidad adicional demostrable para el logout propuesto; no un endpoint ya
activo que se haya roto. No se ejecutaron tests FE ni se afirma cobertura automática nueva.

## Reglas comunes propuestas, concordantes con la factory aislada

- HTTPS fuera de desarrollo/test local. Accept application/json. POST con Origin exacto de
  allowlist; ausente, null o ajeno se rechaza 403. GET de sesión permite cliente sin Origin con Bearer.
- Para POST con cuerpo JSON, Content-Type application/json (parser también admite application/*+json).
  Challenge exige `{}`. Login exige sus tres campos. GET sesión y POST logout **sin body**, params ni query.
- Sin cookies/credentials include. Bearer opaco Agro, no ID token Google, solo en Authorization.
  No aceptar token/cliente en query, body alternativo ni headers públicos de ámbito.
- Cache-Control no-store en router. No devolver token en GET sesión. No exponer hashes,
  nonceDigest, subject Google, versión, IDs internos de sesión ni documentos MongoDB.
- Envelope propuesto con adaptador explícito BE-08: `{ "error": { "code": "...", "message": "..." } }`.
  Mensajes constantes seguros del catálogo; no mensajes originales del SDK/Zod/Mongo.
  Los tests de sesiones inyectan ese adaptador; createHttpInfrastructure sin opción usa error
  string legacy. La app default también conserva legacy; aprobar transición BE-03 antes de montarlo.
- Parser BE-08: límite por defecto 16 KiB, JSON estricto y sin inflate. El límite de credential
  es adicional (8192 caracteres). No asumir que límites HTTP y de token son el mismo límite.
- Port obligatorio de admisión compartida por operación: falta implementación distribuida.
  Un limiter por proceso no prueba control entre instancias Vercel; cuotas, ventana y clave
  de confianza se aprobarán en D08. No confiar en X-Forwarded-For sin política de proxy.
- Request ID/logging seguro y headers BE-08 en composición futura. No registrar Authorization,
  credential, challenge_id, nonce, email o cuerpos. Sin x-powered-by. CORS no reemplaza autenticación.
- Preflight OPTIONS de navegador debe superar CORS sin sesión; verificar Origin/headers/methods
  reales. El middleware CORS existente puede anunciar métodos adicionales, no implica rutas nuevas.

## Operación 1 — Challenge

**POST /api/v1/auth/google/challenge**. Header Origin permitido y Content-Type JSON.
Authorization no requerido; FE usa sinSesion. Request exacto `{}`; campos extra/query/params 400.

Respuesta **200**, forma:

```json
{"challenge_id":"<opaco-base64url-43>","nonce":"<opaco-base64url-43>","expires_at":"2030-01-01T00:05:00.000Z"}
```

Ejemplo de forma, no fixture válido ni valores reales. Ambos secretos son aleatorios de 32 bytes;
base64url canónico de 43 caracteres. Persistencia solo SHA-256; expiración ISO UTC con milisegundos.
FE mantiene intento en memoria, pasa nonce a GIS y asocia el callback al challenge correspondiente.
No guardar nonce/challenge en URL, analytics ni storage duradero. Renovar intento si vence.
Errores: 400 validación/JSON; 403 Origin; 413/415 parser; 429 admisión; 503 dependencia;
500 inesperado sanitizado. No requiere cuenta ni email ni devuelve datos de usuario.

## Operación 2 — Login Google

**POST /api/v1/auth/login**. Origin permitido, Content-Type JSON; sin Bearer previo.

```json
{"provider":"google","credential":"<ID-token-Google>","challenge_id":"<opaco-base64url-43>"}
```

Body estricto: provider literal google, credential string 1..8192 y challenge canónico;
no email/password/cliente_id/nonce adicional. GIS callback recibe credential y FE lo remite por TLS
con challenge_id; nonce viene firmado dentro del ID token y se compara contra digest persistido.
BE verifica firma/issuer/audience/tiempos/nonce y consulta catálogo confiable. Challenge se consume
condicionalmente antes de insertar sesión; replay no crea segunda sesión.

Respuesta **200**:

```json
{
  "token":"<Bearer-opaco-Agro-43>",
  "token_type":"Bearer",
  "usuario":{"usuario_id":"sim-user-a","nombre":"Persona ficticia","email":"persona@example.invalid","cliente_id":"sim-client-a"},
  "cliente":{"cliente_id":"sim-client-a","nombre":"Cliente ficticio"},
  "sesion":{"expira_en":"2030-01-01T08:00:00.000Z","expira_por_inactividad_en":"2030-01-01T00:30:00.000Z"}
}
```

Todos los campos mostrados son obligatorios y no null; IDs lógicos string, fechas ISO UTC.
usuario.cliente_id = cliente.cliente_id. Son datos sintéticos, no prueba de contrato físico.
FE valida respuesta en runtime antes de instalar sesión, descarta credential Google, usa únicamente
token Agro para API y no permite que respuesta tardía sustituya otro intento/sesión.

Errores específicos: **401 UNAUTHENTICATED** token inválido/expirado, nonce incorrecto,
challenge ausente/consumido/vencido; **403 FORBIDDEN** usuario desconocido/inactivo, pertenencia
ausente/inactiva o cliente inactivo. No distinguir públicamente las causas de catálogo.
Comunes 400/413/415/429/500/503. Fallo al buscar certificados Google es 503, token no verificable 401.
No hay garantía de reintentar login con mismo challenge tras fallo parcial: si el consume ya
ocurrió, se quema el intento. FE solicita nuevo challenge y nueva credencial con ese nonce;
no replay automático ciego. Si insertó sesión y se perdió respuesta, puede quedar sesión huérfana
hasta expiración/revocación; no hay recuperación de su token ni endpoint de idempotencia.

## Operación 3 — Recuperar sesión actual

**GET /api/v1/auth/session**. Authorization: Bearer <token Agro>; Accept JSON;
sin body, params ni query. Sin Origin permitido para clientes no navegador; si se envía debe
ser permitido. Header ausente o token canónico desconocido/expirado/revocado → **401**.
Header duplicado/combinado o formato de transporte malformado → **401** en el middleware
de autenticación actual. No uniformarlo silenciosamente con logout, que usa parser opcional y 400.

**200** con exactamente usuario, cliente y sesion del ejemplo de login, **sin token/token_type**.
Revalida usuario/cliente/versión y puede extender idle dentro del límite absoluto. No es una
operación puramente observacional de persistencia: el GET de sesión puede hacer touch de actividad.
No confundir esta ruta propuesta con GET /health, que sigue público e independiente de MongoDB.

FE al recargar espera esta respuesta antes de dar por recuperada identidad. 401 de generación
vigente limpia sesión; 403 CORS/config no debe diagnosticarse como password erróneo;
429/503/error de red muestran reintento controlado, sin sustituir identidad desde storage.
Se mantienen 400/403/429/500/503 posibles y body inexistente exigido. Nunca almacenar cliente
elegido por UI como fuente de autorización.

## Operación 4 — Logout revocable

**POST /api/v1/auth/logout**. Origin exacto permitido. Sin body, query ni params;
Authorization Bearer Agro si existe. Sin Content-Type necesario al no enviar cuerpo.
**204 sin cuerpo** tras revocación confirmada; también sin token o con token canónico desconocido.
No exigir usuario activo para revocar. Un Bearer sintácticamente válido pero no canónico
también es no-op en el servicio. Header malformado/duplicado →400, Origin inválido→403,
admisión→429, dependencia fallida→503, inesperado→500. No responder 204 si el store rechazó revocar.

FE captura token/generación que pretende cerrar, evita borrar login posterior y limpia credenciales
locales aunque la red falle por decisión UX propuesta. Si falta ACK de revocación, informar cierre
local y revocación remota **no confirmada**; no afirmar que un token robado dejó de servir.
Reintentar revocación solo con estrategia acotada aprobada, sin persistir bearer en logs/colas.
Logout Agro no cierra cuenta Google ni equivale a revocar consentimiento Google.

## D04 — Política de sesión y transporte a aprobar

Recomendación inicial: Bearer opaco por coherencia con FE y factory; fuente de verdad en memoria,
sessionStorage opcional para restaurar pestaña. XSS puede robarlo: hashes en DB no lo previenen.
Cookies HttpOnly requerirían contrato diferente, CSRF/credentials/SameSite/CORS y revisión;
no declarar que esa alternativa ya está implementada. Aprobar riesgo residual antes de Preview.

Defaults implementados: challenge 5 min, absoluto 8 h, idle 30 min. Rangos: challenge 1 s..10 min,
absoluto 1 s..24 h, idle 1 s..1 h y no mayor al absoluto. Son valores de infraestructura,
no política de producto aprobada. Config explícita por realm; no fallback por NODE_ENV.
Múltiples sesiones permitidas hoy; logout cierra solo la presentada. Sin refresh token,
listado de dispositivos, logout-all ni selección multicliente.

## Cierre del acuerdo

FE/BE/Seguridad deben aprobar D04/D05 y pruebas F01–F04, elegir política de logout no confirmado,
restauración, TTL y riesgo de Bearer; luego actualizar tipos FE, OpenAPI/BE-03 y contratos en un
cambio coordinado. No editar silenciosamente las propuestas BE-03 para tratarlas como aprobación.
Siguientes gates: [plan A–I](PLAN_BE09_4_IMPLEMENTACION_Y_APROBACIONES.md),
[22 escenarios y MongoDB](MATRIZ_BE09_4_E2E_Y_DEPENDENCIAS.md),
[configuración GIS](INFORME_BE09_4_PREPARACION_INTEGRACION_REAL.md).
