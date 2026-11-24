# BE13-10A — Auditoría de seguridad del framework de políticas

## Alcance

`src/iot/operations-security-policy.contracts.ts`, `src/services/operations-security-policy.service.ts`, `createBlockingSecurityPolicies`. Pruebas: `test/be13-10a-adversarial.test.js` (10/10) y la suite funcional (39/39).

## Modelo de confianza

- Cada política se inyecta; la frontera de confianza es quien compone el bundle. `INJECTED_UNVERIFIED` hace visible una política no aprobada, no la impide.
- Las respuestas de las políticas pasan por timeout de 5 s y esquema estricto, y se copian. Cualquier falla produce el resultado conservador.
- La propiedad de un lease se prueba solo con la identidad autenticada por el proveedor.

## Vectores

| X | Vector | Resultado | Severidad |
| --- | --- | --- | --- |
| X1 | Rol inyectado por el llamador (credencial, request, atributos con forma de proveedor) | denegado | SIN HALLAZGO |
| X2 | Capacidad inyectada; capacidad pedida desconocida o no string | denegado; el proveedor ni se consulta | SIN HALLAZGO |
| X3 | Realm forjado (credencial, request, política de otro realm) | principal solo con el realm del bundle; si no, denegado | SIN HALLAZGO |
| X4 | Dueño falso del lease (`operatorId` en la credencial, principal fabricado, lease ajeno desde el store, store que falla) | `lease-active` / `unauthenticated` / `lease-not-found` | SIN HALLAZGO |
| X5 | Lease viejo (recuperación preparada contra un lease ya reemplazado) | `lease-mismatch` / `stale-version` | SIN HALLAZGO |
| X6 | Bypass del legal hold (respuesta de otro stream o realm, booleano falso como string/0, campos extra, `legalHold` en la entrada) | `RETAIN` | SIN HALLAZGO |
| X7 | Evidencia "verificada" falsa (declarada por el llamador, campos de prueba, eco de otra referencia) | `REJECTED` / `UNVERIFIED` | SIN HALLAZGO |
| X8 | Adapter permisivo por defecto | no existe default; los 8 placeholders son conservadores y `BLOCKED` | SIN HALLAZGO |
| X9 | Bypass por variables de entorno; reloj, aleatoriedad, timers o red en los módulos nuevos | ausentes; el entorno no cambia nada | SIN HALLAZGO (H3: comentario) |
| X10 | Políticas malformadas (getters hostiles, proxies, thenables, strings) | rechazadas o conservadoras | **H1 corregido** (readiness lanzaba) |

## Hallazgos

| ID | Severidad | Estado |
| --- | --- | --- |
| H1 readiness lanzaba ante un getter hostil | BAJO | CORREGIDO |
| H2 S7 de BE13-09 (liberar un lease sin propiedad) | MEDIO | Contrato listo; **abierto en runtime** hasta persistir el propietario y conectar el governor (requiere decidir la expiración) |
| H3 literal `Date.now` en un comentario | INFORMATIVO | CORREGIDO |

Sin hallazgos ALTOS ni CRÍTICOS.

## Criptografía

No se implementaron firmas, MACs, hashes como autenticación ni PKI. El único hash del repo en este dominio sigue siendo el identificador determinista del audit (BE13-09), que no autentica nada.

## Escaneo de secretos (manual)

Se buscó en `dev..HEAD` y en los archivos nuevos: `password`, `passwd`, `secret`, `client_secret`, `clientSecret`, `token`, `Bearer`, `mongodb://` con credenciales, `mongodb+srv`, `mongodb.net`, `x-emqx-key`, `AKIA`, `BEGIN PRIVATE KEY`. Solo aparecen tokens sintéticos de prueba (`tok-*`), referencias sintéticas (`SYNTHETIC-*`, `TICKET-*`) y menciones en la documentación. Ningún secreto.

## Runtime

`app.ts` sin cambios; sin endpoints (login, lease, replay, audit, metrics), sin workers, sin cron, sin consumer EMQX. HTTP 13/13 equivalente.
