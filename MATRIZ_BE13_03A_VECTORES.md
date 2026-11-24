# BE13-03A — Matriz de vectores adversariales

Archivo de regresiones: `test/be13-03a-adversarial.test.js` (26 pruebas). Casos positivos con **dobles explícitos**; no son evidencia productiva.

Leyenda de resultado sobre el código original (`1994efe`): **DEMOSTRADO** (defecto reproducido), **RESISTIDO** (fail-closed ya correcto), **LIMITACIÓN**.

| # | Vector | Resultado original | Resultado tras BE13-03A | Prueba | Severidad |
| --- | --- | --- | --- | --- | --- |
| 1 | Candidate copiado (spread, assign, copia profunda, símbolos, descriptores, prototipo) | RESISTIDO | `invalid-candidate`, ninguna autoridad consultada | `#1` | SIN HALLAZGO |
| 2 | Candidate clonado (`structuredClone`, JSON) | RESISTIDO | `invalid-candidate` | `#2` | SIN HALLAZGO |
| 3 | Proxy sobre candidate genuino | RESISTIDO | `invalid-candidate`, 0 traps invocadas | `#3` | SIN HALLAZGO |
| 3b | Clon registrado con `registerIssuedCandidate` exportado | **DEMOSTRADO** → `ready-for-attribution` | Función inexistente; clon → `invalid-candidate` | `#4` | MEDIO (H1) |
| 4 | Candidate de otra instancia del módulo (import con otra URL) | Aceptado (registry compartido por import relativo) | `invalid-candidate` (WeakSet por instancia) | `#4b` | BAJO (efecto de H1) |
| 5 | Reutilización de candidate | RESISTIDO | Determinista, candidate intacto y congelado | `#5` | SIN HALLAZGO |
| 6 | Cambio de autoridad entre lecturas (incl. misma revisión) | RESISTIDO | `stale-association` / `stale-resolution` | `#6` | SIN HALLAZGO |
| 7 | Cambio posterior a la segunda lectura | LIMITACIÓN | `ready` con dato anterior; `revalidation:'required'`; huella detecta el cambio al releer | `#7` | LIMITACIÓN documentada |
| 8 | Revisión igual con contenido distinto (entre evaluaciones) | **DEMOSTRADO** (indistinguible por `revisions`) | `fingerprints` distintas | `#8`, recomputación | MEDIO (H2) |
| 8b | Revisión vacía/negativa/fraccionaria/string | RESISTIDO | `invalid-authority-response` | revisiones | SIN HALLAZGO |
| 9 | Realm cruzado (asociación, catálogo, realm por registro) | RESISTIDO | `realm-mismatch` / `invalid-authority-response` | `#9` | SIN HALLAZGO |
| 9b | Spoofing en payload (`clientId`, `tenant`, `realm`, `fieldId`, `areaId`, `sensorId`, `physicalDeviceId`) | RESISTIDO | Atribución solo de autoridades | spoofing | SIN HALLAZGO |
| 10 | A→B→A histórico, bordes exactos, dispositivo hoy de B | RESISTIDO | Dueño histórico correcto | `#10` | SIN HALLAZGO |
| 11 | Dispositivo hoy inactivo con evento histórico válido | LIMITACIÓN | `inactive-device` sin consultar asociaciones | `#11` | MEDIO (disponibilidad), BLOQUEADO |
| 12 | Timestamp exacto válido (3 relojes; relojes con igual valor) | RESISTIDO | `ready` con el reloj nombrado | `#12` | SIN HALLAZGO |
| 13 | Timestamp semánticamente similar (ISO, segundos, fraccionario, `persistedAt`, broker adelantado, ausente) | RESISTIDO | `contradictory-authority` | `#13` | SIN HALLAZGO |
| 14 | `persistedAt` nulo | RESISTIDO | Conservado `null`, no normalizado | `#14` | SIN HALLAZGO |
| 15 | Hardware no verificado con procedencia BE13-02 válida | RESISTIDO | `unverified-hardware` | `#15` | SIN HALLAZGO |
| 16 | Procedencia válida + hardware contradictorio | RESISTIDO | `contradictory-authority` | `#16` | SIN HALLAZGO |
| 17 | Catálogo contradictorio / unidad inválida / sin conversión | RESISTIDO | `contradictory-authority` / `invalid-authority-response` / valor intacto | `#17` | SIN HALLAZGO |
| 18 | `null` / `0` / ausente / `missingReason` en payload | RESISTIDO | Preservados; ausencia `absent-field`; `missingReason` no inferido | `#18` | SIN HALLAZGO |
| 19 | Adapter hostil (throw string/objeto/null/Proxy, rechazo, mutación tardía) | RESISTIDO | `dependency-error`; mutación sin efecto | `#19` | SIN HALLAZGO |
| 20 | Timeout, resolución y rechazo tardíos | RESISTIDO | `dependency-error`; sin `unhandledRejection` | `#20` | BAJO (L2, provisional) |
| 21 | Inmutabilidad profunda y referencias compartidas | **DEMOSTRADO** (`result.device` compartido con consultas) | Congelado y sin objetos compartidos | `#21` | BAJO (H3) |
| 22 | Confusión con `TrustedMeasurementEvent` | RESISTIDO en runtime; sin guarda de compilación | Schema y servicio BE-12 rechazan; `tsc` falla si se vuelve asignable | `#22`, `trust-gate.type-assertions.ts` | BAJO preventivo (H4) |

## Vectores sin prueba automatizada

| Vector | Estado | Motivo |
| --- | --- | --- |
| Código hostil dentro del proceso creando authority + mapper propios | NO VERIFICABLE como defecto | Mismo dominio de confianza; documentado como límite del registry |
| Retención de memoria del registry | VERIFICADO manualmente | Script con `--expose-gc` fuera del repo: 64,1 MB → 9,9 MB tras GC (50 000 candidates) |
| Monotonía de revisiones de autoridades | NO VERIFICABLE | Propiedad del adapter productivo inexistente |
| Registros BE-11 de otro realm bajo sobre correcto | NO VERIFICABLE | BE-11 no incluye realm por registro |

## Totales

| Suite | Resultado |
| --- | --- |
| BE13-03A nueva | 26/26 |
| BE13-03 | 39/39 |
| BE13-02 + BE13-02A | 64/64 |
| `npm test` | 554/554 |
| HTTP | 13/13 |
