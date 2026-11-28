# INFORME BE13-11M — API de reconciliación segura y cuarentena reconciliable

Estado: `LOCAL_LAB_EVIDENCE`. `productionReady=false`. Sin Atlas; Mongo local descartable. La API es una **router factory no compuesta en `app.ts`**.

## Qué se construyó
| Área | Resultado |
|---|---|
| Contrato HTTP | `GET /ingest-confirmations/:eventId?payloadSha256=<hex64>` → `{ eventId, status, confirmed, evidenceVersion, deliveries, durableAt }`. Códigos: 200 (incluye `conflict`/`not-found`), 400, 401, 403, 414, 429 (+`Retry-After`), 503. Ningún código distinto de 200 confirma |
| Scope | exclusivamente del principal autenticado (`scopeOf(principal)`); query/headers/cookies `sourceId`, `realm`, `x-forwarded-*`, etc. no tienen efecto (S5, M1) |
| Auth | puerto `ConfirmationPrincipalAuthority`. **Default productivo `BLOCKED`**: construir el router con él lanza `INGEST_CONFIRMATION_AUTH_BLOCKED`. Ninguna tecnología elegida |
| Rate limiting | abstracción `RateLimitPolicy`; default `BLOCKED` (el router no se construye); token bucket por principal + global + bucket único para no autenticados, memoria acotada. Los valores de 11K (10 req/s, ráfaga 50) existen solo como `PROPOSED_TEST_RATE_LIMIT` (`TEST_ONLY`), **no aprobados** |
| Enumeración | ajeno ≡ inexistente (mismo estado `not-found`, misma forma); `conflict` es respuesta de dominio 200 sin hash ni contenido esperado |
| Validación | `eventId` y `payloadSha256` estrictos (ASCII, longitudes, hex minúscula); parámetros repetidos/array/operadores (`$ne`, `[]`) ⇒ 400; unicode hostil, `%00`, CRLF, RTL, fullwidth, inyección ⇒ 400; URL > 1024 ⇒ 414 antes de autenticar; percent-encoding inválido ⇒ 400 JSON sin stack |
| Observabilidad mínima | `onEvent` con registros seguros (`ok`, `unauthenticated`, `forbidden`, `invalid-input`, `rate-limited`, `uri-too-long`, `error`) sin hash, principal ni payload; un observador que falla no cambia la respuesta. *Cross-tenant no es observable por diseño* (es indistinguible de `not-found`) |
| Cuarentena reconciliable | filas **nuevas** guardan `principalReference`, `payloadSha256` y `declaredEventId` tomados del contexto que el boundary ya probó (AsyncLocalStorage; nunca del payload). El `quarantineId` (dedupe) no cambia. Lookup por principal para filas sin `sourceId` (índice `quarantine_realm_principal_event`). **Legacy**: filas sin esos campos permanecen invisibles (fail-closed) |
| Upgrade local | `upgradeQuarantineScopeBe1311m` (collMod + índice, idempotente, rechaza si hay REPLAYING sin lease) |

## Evidencia
- Offline: 11 tests de la matriz de seguridad + control y 6 mutantes (M1 scope desde request, M2 sin rate limit, M3 hash sin validar, M4 authority BLOCKED componible, M5 cuarentena de principal visible a otro, M6 error por defecto filtrado): **6/6 muertos**, control limpio.
- Mongo real (campaña local única, `.local-evidence/be13-11m-quarantine-scope.json`): fila mapper-stage guarda principal+hash+eventId declarado; mismo entry sin scope golpea la **misma** fila; el dueño ve `quarantined` (no confirmante), otro principal y una fila legacy ven `not-found`; una fila sobre otros bytes no enmascara; la búsqueda por principal es **IXSCAN** (1 doc); el validador viejo rechaza los campos nuevos (el código no debe desplegarse antes del upgrade) y tras `upgradeQuarantineScopeBe1311m` se aceptan, las filas viejas siguen válidas y el upgrade es idempotente.
- Suite 1107/1107.

## Findings
| Sev. | Hallazgo |
|---|---|
| INFO | orden operativo obligatorio: **upgrade del validador de cuarentena antes de desplegar el código** (el validador viejo rechaza los campos nuevos) |
| INFO | no existe señal de "cross-tenant denied" por diseño; la observabilidad de abuso depende de `rate-limited`/`invalid-input` |
| LOW | las cuarentenas escritas antes de 11M sin `sourceId` siguen sin ser reconciliables (no hay forma segura de atribuirlas) |

## Decisiones humanas (sin tomar)
Tecnología de autenticación del publisher, valores aprobados de rate limit, aprobación de componer el endpoint, ejecución real del upgrade del validador.
