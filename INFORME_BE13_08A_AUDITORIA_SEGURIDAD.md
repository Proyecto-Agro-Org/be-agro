# BE13-08A — Auditoría de seguridad de reintentos, cuarentena y replay

## Método

Revisión de código, 10 vectores adversariales offline, campaña real (25/25 × 2) y 4 pruebas de mutación (3 offline y 1 contra Mongo real), todas detectadas.

## Vectores

| Vector | Resultado |
| --- | --- |
| Amplificación de reintentos | Techo duro de 10 aunque la política diga siempre `retry`; respuestas raras o excepciones → `stop` |
| Abuso de replay | Solo `RETRYABLE`; documento original + evidencia de procedencia; identidad y fingerprint exactos; cada intento auditado |
| Replay entre realms | El realm forma parte del `quarantineId` y de cada filtro; `get` de otro realm → `null` (Q14; mutación detectada) |
| Envenenamiento de la cuarentena | `$jsonSchema` estricto: sin payload, stack, mensajes ni campos tipo secreto; estado y contadores acotados; auditoría acotada con texto restringido |
| Fuga de payload | No se almacena; los documentos sin `eventId` se identifican por digest SHA-256 |
| Fuga de errores | Solo códigos cerrados; mensajes y URIs descartados (A8) |
| Manipulación de estado | Máquina de estados con actualización condicionada a `from`; desbloquear exige evidencia y nunca aplica a seguridad, validación, conflicto ni consistencia |
| Bypass de idempotencia vía retry | Mismo candidate, misma clave y mismo fingerprint en cada intento (A9, R1-02) |
| Flag `retryable` en el payload o en la selección | Ignorado: la clasificación es código cerrado (A1) |
| BLOCKED forzado a replay | `replay-not-allowed`; transiciones ilegales rechazadas (A2) |
| `quarantineId` forjado o malformado | `quarantine-not-found` / `invalid-replay-input` (A3) |
| Respuestas maliciosas de recovery o del store | Validadas; otro realm → `security`; fingerprint ajeno → conflicto; basura → incertidumbre (A4, A5) |
| Claim o medición malformados en Mongo | Recovery → `malformed-*` → cuarentena de consistencia |
| Replays concurrentes | Como máximo 1 medición (offline y Q21 real) |

## Hallazgos

Ver `INFORME_BE13_08_RETRY_RECOVERY.md` (H1 MEDIO corregido, con evidencia real en Q05; H2 y H3 BAJOS corregidos). No hay hallazgos CRÍTICOS ni ALTOS.

## Límites que no se pueden proteger aquí

- Código hostil dentro del proceso puede llamar `transition` con evidencia inventada o inyectar stores falsos: la autorización real de operadores y el bootstrap siguen pendientes.
- `evidence` es una referencia textual, no una prueba verificable; su verificación corresponde al proceso humano o administrativo que la produzca.

## Validaciones

`npm.cmd ci --offline` OK · typecheck OK · build OK · `npm test` **752/752** · HTTP 13/13 · `git diff --check` OK · Mongo multi-nodo 25/25 × 2.
