# BE13-04A — Matriz de vectores adversariales

Archivo: `test/be13-04a-adversarial.test.js` — **18/18**. Dobles explícitos, incluidos dobles deliberadamente mentirosos.

| V | Vector | Resultado | Severidad |
| --- | --- | --- | --- |
| V1 | Ready fabricado / clone / spread / Proxy / `Object.create` / `setPrototypeOf` / descriptores / JSON; sin export de registro | `invalid-ready` | SIN HALLAZGO |
| V2 | Revisiones o fingerprints falsos | ready congelado (`TypeError`); copia forjada → `invalid-ready` | SIN HALLAZGO |
| V3 | Ready de otra instancia del módulo del gate | `invalid-ready` (fail-closed) | SIN HALLAZGO |
| V4 | Ready genuino + otro candidate genuino de igual contenido | `invalid-ready` | SIN HALLAZGO |
| V5 | Revalidadores contradictorios (2 dispositivos, ninguno, otro id, 2 asociaciones, ninguna, otro dispositivo, temporal no resuelto, origen hardware cambiado) | `stale-*` | SIN HALLAZGO |
| V6 | Omitir revalidador, sin revalidadores, `skipRevalidation`, política `null` | `TypeError` en construcción | SIN HALLAZGO |
| V7 | Las relecturas usan exactamente las consultas BE13-03 y cubren las 5 autoridades | consultas idénticas | SIN HALLAZGO |
| V8 | declaredAt inventado o reetiquetado (dispositivo±1, sentAt como dispositivo, receivedAt/persistedAt como broker); reloj ISO | `contradictory-authority` / `missing-declared-at` | SIN HALLAZGO |
| V9 | Clock contradictorio con evidencia BE13-03 (4 variantes) | `contradictory-authority` | SIN HALLAZGO |
| V10 | persistedAt sustituido (receivedAt, sentAt, ±1); nulo con política que aprueba | `contradictory-authority` / `unresolved-persisted-at` | SIN HALLAZGO |
| V11 | missingReason forzado sobre número | ignorado; política no consultada | SIN HALLAZGO |
| V12 | Payload con `clientId`, `physicalDeviceId`, `realm`, `tenant` | sin efecto; claves del evento exactas | SIN HALLAZGO |
| V13 | Realm cruzado en 5 revalidadores y 3 políticas | `realm-mismatch` | SIN HALLAZGO |
| V14 | Spoofing temporal vía revalidador | `stale-temporal-policy` | SIN HALLAZGO |
| V15 | Dispositivo hoy inactivo (L1) | `stale-device` (conservador) | LIMITACIÓN — `DEVICE_STATUS_HISTORY_REQUIRED` |
| V16 | Throws hostiles, thenable hostil, timeout, mutación tardía | `dependency-error`; sin efecto | SIN HALLAZGO |
| V17 | Diagnósticos en cuarentena | solo `status`/`reason`/`eventId` | SIN HALLAZGO |
| V18 | Cuarentena del gate usada como ready | `invalid-ready` | SIN HALLAZGO |

## Fuera de prueba automatizada

| Vector | Estado |
| --- | --- |
| Código hostil en el proceso instanciando gate/políticas falsas | NO VERIFICABLE — trust boundary en la composición |
| Colisión SHA-256 (fingerprint igual, revisión distinta) | NO VERIFICABLE — no se asume |
| ABA entre relecturas / cambios posteriores | RESIDUAL (A2) |
| BE-12 sin versión/fingerprint | PENDIENTE (A1) |
| Aislamiento de realm en almacenamiento | NO VERIFICABLE offline |
