# BE13-04 — Matriz de pruebas

Archivo: `test/be13-04-trusted-event-builder.test.js` — **36/36**. Flujo real mapper BE13-02 → gate BE13-03 → builder BE13-04 con **dobles explícitos** de autoridades, revalidadores y políticas. No es evidencia productiva ni aprobación de políticas.

| # | Caso | Resultado esperado | Estado |
| --- | --- | --- | --- |
| 1 | Ready inválido (clone, spread, JSON, `{}`, `null`, ready de otro candidate) | `invalid-ready` | PROBADO |
| 2 | Candidate no emitido | `invalid-candidate` | PROBADO |
| 3 | Revisión de dispositivo cambió | `stale-device` | PROBADO |
| 4 | Fingerprint de dispositivo cambió (misma revisión; lifecycle hoy inactivo) | `stale-device` | PROBADO |
| 5 | Revisión de asociación cambió | `stale-association` | PROBADO |
| 6 | Fingerprint de asociación cambió (misma revisión) | `stale-association` | PROBADO |
| 7 | Temporal cambió (revisión; ahora no confiable) | `stale-temporal-policy` | PROBADO |
| 8 | Catálogo cambió (unidad; ahora desconocido) | `stale-catalog` | PROBADO |
| 9 | Hardware cambió (revisión; ahora no verificado) | `stale-hardware` | PROBADO |
| 10 | Realm incorrecto (builder, revalidador, política) | `realm-mismatch` | PROBADO |
| 11 | declaredAt no aprobado (default y `blocked`) | `unapproved-declared-at` | PROBADO |
| 12 | declaredAt sintético válido (dispositivo, broker, `none`) | valor exacto / `null` | PROBADO |
| 13 | `null` sin missingReason (default) | `missing-reason-required` | PROBADO |
| 14 | `null` con missingReason aprobado | `value:null`, `missingReason:'absent'` | PROBADO |
| 15 | `0` | `0`, `missingReason:null`, política no consultada | PROBADO |
| 16 | Valor positivo | literal, sin conversión | PROBADO |
| 17 | persistedAt nulo | `unresolved-persisted-at`, política no consultada | PROBADO |
| 18 | persistedAt aprobado | igual al del candidate | PROBADO |
| 19 | Clock no aprobado (default) | `unresolved-clock` | PROBADO |
| 20 | Clock aprobado (`received-at`, `declared-at-approved`) | coherente con evidencia BE13-03 | PROBADO |
| 21 | Schema BE-12 inválido (`assembleTrustedMeasurementEvent`) | `null` → `schema-mismatch` | PROBADO |
| 22 | Schema BE-12 válido + `resolve` BE-12 | `verified` con el mismo dueño | PROBADO |
| 23 | Dependencia lanza (5 revalidadores + 3 políticas) | `dependency-error` sin fuga | PROBADO |
| 24 | Respuesta malformada | `invalid-authority-response` / `invalid-missing-reason` | PROBADO |
| 25 | Proxy hostil (respuesta y ready) | `invalid-authority-response` / `invalid-ready` | PROBADO |
| 26 | Determinismo | `deepEqual` | PROBADO |
| 27 | Inmutabilidad, sin referencias compartidas, entradas intactas | congelado | PROBADO |
| 28 | Aislamiento `clientId` | solo de la asociación; nunca en evento ni consultas | PROBADO |
| 29 | A→B | ready previo → `stale-association`; reejecución → dueño histórico A | PROBADO |
| 30 | A→B→A | evento en ventana B → B | PROBADO |
| 31 | Cambio después de Ready | `stale-*` | PROBADO |
| 32 | Revisión igual + fingerprint distinto | `stale-*` | PROBADO |
| 33 | Cambio solo de revisión | cambia fingerprint → `stale-*`; colisión SHA-256 NO VERIFICABLE | PROBADO |
| 34 | Coincidencia exacta | `trusted-event`, revisiones y fingerprints iguales | PROBADO |
| 35 | Payload hostil con `clientId`/`physicalDeviceId` | sin efecto | PROBADO |
| 36 | Evento solo tras todas las políticas | orden verificado; cada política por defecto bloquea | PROBADO |

## Verificación de mutación (sobre `dist`, restaurado después)

| Mutación | Fallos detectados |
| --- | --- |
| Quitar comparación de fingerprint de asociación | 3 |
| Quitar verificación de procedencia del ready | 7 |
| Completar `persistedAt` nulo con `receivedAt` | 2 |

## Totales

| Suite | Resultado |
| --- | --- |
| BE13-04 funcional | 36/36 |
| BE13-04A adversarial | 18/18 |
| Previas (incluye BE13-02/03 tras refactor) | 556/556 |
| `npm test` | **610/610** |
| HTTP | 13/13 |
