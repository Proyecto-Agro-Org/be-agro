# BE13-09A — Auditoría de seguridad de la gobernanza operativa

## Alcance

Superficie nueva de BE13-09: autorización de operadores, evidencia, máquina de estados con lease/CAS, audit store, métricas/alertas, snapshot, bootstrap. Offline (`test/be13-09a-adversarial.test.js`, 8/8) y Mongo real (O15–O18). Vectores: `MATRIZ_BE13_09A_VECTORES.md`.

## Modelo de confianza

- Las autoridades se inyectan; el **bootstrap es la frontera de confianza real**. El registro de placeholders (WeakSet) da procedencia solo dentro del proceso.
- La credencial es opaca. Identidad, realms y capacidades salen únicamente del principal devuelto por el puerto, revalidado por el servicio.
- La evidencia es declarativa: se fija `verification: 'DECLARED_UNVERIFIED'` y el llamador no puede aportar `issuedBy` ni `verification`.

## Hallazgos

| ID | Severidad | Hallazgo | Estado |
| --- | --- | --- | --- |
| S1 | MEDIO | Recibos de audit no validados: un `append` que no lanza pero devuelve basura habilitaba acciones sin registro durable (V6) | CORREGIDO (`appendReceiptSchema`; mutante M3 detectado) |
| S2 | MEDIO | Carrera replay×discard sin lease | CORREGIDO por diseño (`REPLAYING`, O13 real) |
| S3 | INFORMATIVO | Bypass en proceso: código con acceso directo al store evita la autorización | ACEPTADO / documentado (frontera = bootstrap) |
| S4 | INFORMATIVO | Audit no WORM: privilegios de escritura en Mongo permiten alterarlo | ACEPTADO / documentado; requiere control de cuentas en la topología objetivo |
| S5 | BAJO | Audit de resultado best-effort | ACEPTADO; alerta `AUDIT_RESULT_MISSING`; la entrada previa obligatoria existe siempre |
| S6 | BAJO | Lease huérfano sin expiración | ACEPTADO; `releaseLease` autorizado. Política de expiración: decisión pendiente |
| S7 | MEDIO | `releaseLease` no exige propiedad ni expiración: liberar un lease en uso y luego descartar puede dejar una medición de una entrada `DISCARDED` | ABIERTO / documentado; requiere dos acciones autorizadas y auditadas. Se trata en BE13-10A (`ReplayLeasePolicy`) |

Sin hallazgos ALTOS ni CRÍTICOS abiertos. S7 (MEDIO) queda abierto hasta BE13-10A.

## Escaneo de secretos (manual)

Se buscó en el diff `dev..HEAD` y en los archivos nuevos: `token`, `password`, `passwd`, `secret`, `mongodb://` con credenciales, `mongodb+srv`, `mongodb.net`, `x-emqx-key`, `Bearer`, `AKIA`. Solo aparecen tokens sintéticos de prueba (`tok-admin`, `tok-viewer`, `tok-preview`), literales de esquema que **rechazan** `x-emqx-key`, y nombres de reglas. Ningún secreto real ni cadena de conexión con credenciales.

## Runtime

Sin cambios en `app.ts`; sin rutas `/quarantine`, `/replay`, `/audit`, `/metrics`; sin timers, polling, scheduler ni auto-replay; sin variables de entorno que habiliten modos permisivos (V8). HTTP 13/13 equivalente.
