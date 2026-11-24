# BE13-03 — Matriz de pruebas

Archivo: `test/be13-03-trust-gate.test.js` — **39 pruebas, 39 OK**.

Todos los casos positivos usan **dobles explícitos** de las cinco autoridades. No son evidencia productiva de registro de dispositivos, política temporal, catálogo BE-04 ni atestación de hardware. Los candidates se obtienen ejecutando el mapper BE13-02 real sobre fixtures sintéticos BE13-01 (F01, F02, F11, F12, F13).

## Casos requeridos

| # | Caso | Prueba | Resultado esperado | Estado |
| --- | --- | --- | --- | --- |
| 1 | Candidate inválido | `#1`, `#1b`, `#1c` | `invalid-candidate` (null, primitivos, `{}`, `structuredClone`, JSON, spread, spread congelado, legacy F13, documento protegido sin mapear, device-status F02); ninguna autoridad consultada | PROBADO |
| 2 | Dispositivo no encontrado | `#2` | `unresolved-device` | PROBADO |
| 3 | Dispositivo ambiguo | `#3` | `ambiguous-device` | PROBADO |
| 4 | Dispositivo no verificado | `#4` | `unverified-device` | PROBADO |
| 5 | Dispositivo inactivo | `#5` | `inactive-device` (inactive y decommissioned) | PROBADO |
| 6 | Hardware no autenticado | `#6` | `unverified-hardware`; adapter por defecto bloquea | PROBADO |
| 7 | Tiempo no confiable | `#7` | `untrusted-clock`, `unresolved-time`; adapter por defecto bloquea | PROBADO |
| 8 | Asociación inexistente | `#8` | `missing-association` | PROBADO |
| 9 | Asociación superpuesta | `#9` | `overlapping-association` | PROBADO |
| 10 | Asociación histórica correcta | `#10` | Usa ventana cerrada vigente en el instante, no la actual; consulta con `at` autorizado | PROBADO |
| 11 | Reasignación A→B | `#11` | A antes del borde, B desde el borde | PROBADO |
| 12 | Reasignación A→B→A | `#12` | A1, B, A2 según instante | PROBADO |
| 13 | Magnitud desconocida | `#13` | `unapproved-magnitude` (F12 y catálogo por defecto) | PROBADO |
| 14 | Unidad incompatible | `#14` | `incompatible-unit` | PROBADO |
| 15 | `null` válido | `#15` | `value: null`, sin `missingReason` inferido, `valueKind:'null'` | PROBADO |
| 16 | Cero válido | `#16` | `value: 0` (`Object.is`) | PROBADO |
| 17 | Dependencia que lanza | `#17` | `dependency-error` para las 5 autoridades (throw síncrono, rechazo, timeout); sin fuga de mensaje | PROBADO |
| 18 | Realm incorrecto | `#18` | `realm-mismatch` para las 5; realm fuera del enum → `invalid-authority-response` | PROBADO |
| 19 | `clientId` no derivado del payload | `#19` | `clientId` de la asociación aunque payload y `clientid` MQTT digan otra cosa; ninguna consulta lleva `clientId` | PROBADO |
| 20 | Determinismo | `#20` | Dos evaluaciones idénticas → `deepEqual` | PROBADO |
| 21 | Inmutabilidad | `#21` | Resultado y consultas profundamente congelados; mutar objetos de la autoridad no altera el resultado | PROBADO |
| 22 | Revalidación necesaria | `#22` | `revisions` completas, `revalidation:'required'`; cambios entre lecturas → `stale-association` / `stale-resolution` (5 autoridades) | PROBADO |
| 23 | Borde `validFrom` | `#23` | Inclusivo; un ms antes → `missing-association` | PROBADO |
| 24 | Borde `validTo` | `#24` | Exclusivo; dentro y después probados | PROBADO |
| 25 | Evento tardío | `#25` | F11 (deep sleep): reloj de adquisición aprobado → dueño A; reloj de recepción → dueño B; reloj incierto → `untrusted-clock` sin fallback | PROBADO |

## Casos adicionales de auditoría

| Caso | Resultado | Estado |
| --- | --- | --- |
| Selección: campo inexistente, heredado (`toString`), string, boolean, objeto, claves extra, `null` | `absent-field` / `invalid-value` / `invalid-candidate` | PROBADO |
| Autoridad de dispositivo devuelve otra clave, otro tipo de clave u otra fuente | `contradictory-authority` | PROBADO |
| Hardware para otro dispositivo; origen físico vs declarado simulado y viceversa | `contradictory-authority` | PROBADO |
| Autoridad temporal inventa instante, reloj declarado no numérico, adquisición posterior a recepción | `contradictory-authority` | PROBADO |
| Asociación de otro dispositivo, ventana que no contiene el instante (incl. `at === validTo`), página incompleta, `active` con `validTo` | `contradictory-authority` / `invalid-authority-response` | PROBADO |
| Catálogo aprueba otro campo | `contradictory-authority` | PROBADO |
| Respuestas `null`, campos extra (`clientId`, `tolerance`), >2 dispositivos, tipos erróneos, Proxy hostil, getter hostil | `invalid-authority-response` | PROBADO |
| Thenable con `then` hostil | `dependency-error` | PROBADO |
| Ventanas adyacentes | Borde pertenece solo a la ventana posterior | PROBADO |
| `physicalDeviceId` no implica cliente actual | Dueño histórico | PROBADO |
| Puertos mutados tras construcción | Sin efecto | PROBADO |
| Gate solo con adapters por defecto | Nunca `ready-for-attribution` | PROBADO |
| Composición inválida | `TypeError` en construcción | PROBADO |
| Forma exacta del resultado | Sin `payload`, `missingReason`, `attributedAt` | PROBADO |

## Totales

| Suite | Resultado |
| --- | --- |
| BE13-03 nueva | 39/39 |
| BE13-02 mapper + auditoría adversarial | 64/64 (sin regresión tras registrar candidates emitidos) |
| Suite completa `npm test` | 528/528 (489 previas + 39 nuevas) |

Nota BE13-03A: tras la auditoría se agregaron 26 regresiones en `test/be13-03a-adversarial.test.js` (suite completa 554/554) y la prueba de forma exacta incluye `fingerprints`. Ver `MATRIZ_BE13_03A_VECTORES.md`.
| Regresión HTTP `scripts/verify-be10-http.mjs` | 13/13 |
