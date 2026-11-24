# BE13-03A — Auditoría adversarial del Trust Gate

## Alcance y método

- Rama `feature/be13-03-trust-gate`, worktree `.local-consolidacion/be13-03`.
- SHA auditado: `1994efe37fb0a677f4e3b181f3e451c2fb165c6b`. Base `origin/dev` `d14e955…`; `origin/main` `1bb20f7…` sin cambios.
- Archivos: gate, contratos, schemas, adapters bloqueantes, registry, mapper BE13-02, pruebas BE13-03. Contratos BE-11/BE-12 y documentación BE13-03 contrastados contra el código.
- Método: (1) script de sondeo contra el `dist` original para **demostrar** cada vector antes de tocar código; (2) corrección mínima solo de lo demostrado; (3) el mismo sondeo y 26 regresiones nuevas tras la corrección.
- Sin Docker, MongoDB, Atlas, EMQX ni Vercel.

## Hallazgos

| ID | Severidad | Archivo:línea (original) | Escenario | Impacto | Evidencia | Corrección | Regresión | Riesgo residual |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H1 | **MEDIO** | `src/iot/protected-candidate.registry.ts:11` | `registerIssuedCandidate` era un export público. Cualquier módulo del proceso podía hacer `registerIssuedCandidate(Object.freeze(structuredClone(c)))` con contenido arbitrario. | El gate devolvía `ready-for-attribution` sobre un candidate fabricado: la garantía "solo candidates emitidos por BE13-02" documentada en BE13-03 era falsa. No es explotable desde HTTP/MQTT (requiere código dentro del proceso). | Sondeo P1 sobre `1994efe`: `forged via exported registerIssuedCandidate: ready-for-attribution` | Archivo eliminado. WeakSet privado dentro de `protected-ingest.mapper.ts:18`; solo se exporta la consulta `isIssuedProtectedCandidate` (`:20`). La única vía de alta es `map()` exitoso con authority emitida. | `#4`, `#4b` | Código con ejecución arbitraria puede crear su propia authority + mapper y producir candidates "genuinos" (ver respuesta obligatoria). |
| H2 | **MEDIO** | `src/services/attribution-trust-gate.service.ts:216` | Dos resoluciones con las mismas revisiones y distinto contenido (p. ej. `clientId` cambiado sin incrementar `revision`). | El resultado prometía "revisiones suficientes para revalidar", pero una etapa posterior que compara solo revisiones aceptaría contenido cambiado. Dentro del gate la doble lectura sí lo detectaba (comparación de contenido). | Sondeo P8: revisiones idénticas, `client-A` vs `client-Z` | Nuevo campo `fingerprints` (SHA-256 del contenido canónico Zod de cada respuesta) y helper `fingerprintAuthorityResponse` en `src/iot/trust-gate.fingerprint.ts` para recalcular. | `#7`, `#8`, `fingerprints recomputables` | La huella detecta cambio de contenido, no autentica a la autoridad. Si la autoridad miente de forma consistente, nada lo detecta. |
| H3 | BAJO | `src/services/attribution-trust-gate.service.ts:195` | `result.device` era el mismo objeto congelado entregado a las autoridades en las consultas. | Sin impacto práctico (congelado), pero viola "sin referencias compartidas" y permite a un adapter identificar/correlacionar el objeto de salida. | Sondeo P2: `result.device === query.device: true` | Copia fresca congelada (`:197`). | `#21` (ningún objeto del resultado aparece en consultas ni en el candidate) | Ninguno. |
| H4 | BAJO (preventivo) | `src/iot/trust-gate.contracts.ts` | Riesgo de que un cambio futuro haga `ReadyForAttribution` asignable a `TrustedMeasurementEvent`. | Hoy no es asignable (verificado), pero nada lo impedía en compilación. | Verificación de `tsc` con aserción invertida → `TS2322` | `src/iot/trust-gate.type-assertions.ts` (falla `npm run typecheck` si se vuelve asignable). | `#22` (runtime: schema BE-12 rechaza y `resolve` BE-12 lanza `VALIDATION_ERROR`) | Ninguno. |
| L1 | Limitación arquitectónica (MEDIO, disponibilidad) | `attribution-trust-gate.service.ts:137` | Dispositivo hoy `inactive`/`decommissioned` con evento histórico válido. | Bloqueo conservador: `inactive-device`, sin consultar asociaciones. Pérdida de eventos históricos legítimos, no fuga de datos. | `#11` | **Ninguna**: BE-11 no tiene historial de lifecycle; inventarlo sería peor. | `#11` | Ver sección dedicada. |
| L2 | BAJO | `attribution-trust-gate.service.ts:31` | Timeout operativo 5 s por llamada, 10 llamadas por evaluación. | Peor caso ~50 s por evaluación; la operación del adapter no se cancela (no hay `AbortSignal`). | `#17`, `#20` | Ninguna (no hay defecto de corrección). Documentado como salvaguarda provisional. | `#20` | Valor no aprobado como SLO. |

No hubo hallazgos CRÍTICO ni ALTO. Todos los vectores de bypass de autoridades, spoofing multicliente, temporalidad, catálogo, hardware, dependencias hostiles e inmutabilidad terminaron en cuarentena fail-closed (ver `MATRIZ_BE13_03A_VECTORES.md`).

## Registry de candidates — respuesta obligatoria

**Qué garantiza la autenticidad:** identidad de objeto dentro de un `WeakSet` privado del módulo `protected-ingest.mapper.ts`. No hay símbolo privado, closure secreta compartida, firma ni capacidad transferible. `WeakSet.has` no invoca traps de Proxy ni getters (probado: 0 accesos).

**Qué se rechaza (probado):** spread, `Object.assign`, copia profunda manual congelada, copia con símbolos (`Reflect.ownKeys`), objeto con los mismos descriptores y prototipo, `Object.create(candidate)`, `setPrototypeOf`, `structuredClone`, JSON, Proxy sobre un candidate genuino, candidate emitido por otra instancia del módulo (import con otra URL), clon registrado mediante la antigua función exportada (ya no existe).

**Mutación posterior / contenido divergente:** imposible; el candidate está congelado en profundidad (incluido el payload). Probado con `TypeError` en modo estricto.

**Reutilización:** permitida y determinista; el gate no es una frontera de idempotencia (eso sigue siendo `iot-ingest` / BE13-04).

**¿Resuelve un problema de seguridad?** Solo parcialmente. Impone **procedencia dentro del mismo proceso**: el objeto pasó por `map()` con una authority emitida y por todas sus validaciones. Protege contra callers accidentales o descuidados que construyan "algo parecido a un candidate" (adapters, tests mal escritos, futuras rutas). **No** protege contra código hostil dentro del runtime: ese código puede crear una authority con un verifier que acepte todo, un mapper y candidates válidos. No hay autenticidad criptográfica ni autenticación de hardware. Debe documentarse y tratarse como frontera de corrección, no como control de seguridad productivo.

## Memoria del registry

- `WeakSet` no retiene referencias fuertes; no se exponen iteradores ni tamaño.
- Medición ejecutada (Node 24, `--expose-gc`, script local fuera del repo): 50 000 candidates con payload de ~2 KB → heap 64,1 MB retenidos; tras soltar referencias y GC → 9,9 MB (base 7,3 MB). Los callbacks de `FinalizationRegistry` no se observaron en la ventana medida (su momento está fuera de especificación), por lo que la evidencia es la caída de heap, no el conteo.
- Cada proceso/instancia de módulo tiene su propio registry: candidates no viajan entre procesos (consistente con no persistir).
- Sin benchmarks de rendimiento: no se ejecutaron y no se afirman.

## TOCTOU y doble lectura

- **Garantiza:** que las cinco respuestas canonicalizadas fueron idénticas en dos lecturas secuenciales dentro de una evaluación. Probado para cambios con revisión distinta y con **revisión igual** (dispositivo, asociación, temporal, catálogo, hardware).
- **No garantiza:** atomicidad entre autoridades (las lecturas no son una transacción), ni estabilidad después de la segunda lectura. Probado: un cambio que ocurre después devuelve `ready-for-attribution` con el `clientId` anterior (`#7`).
- Por eso el resultado conserva `revalidation:'required'`, `revisions` y ahora `fingerprints`. La documentación BE13-03 se corrigió para no presentar la doble lectura como solución de TOCTOU.

## Revisiones

| Propiedad | Estado |
| --- | --- |
| Específicas por autoridad | IMPLEMENTADO |
| No controladas por payload | PROBADO (provienen solo de respuestas de autoridades) |
| Rechazo de vacías, negativas, no enteras, string | PROBADO (`invalid-authority-response`) |
| Vinculadas al objeto resuelto | IMPLEMENTADO vía `fingerprints` (H2) |
| Monotonía / no reutilización de revisiones | NO VERIFICABLE desde el gate; depende de la autoridad |
| Misma revisión con contenido distinto | Detectable solo por `fingerprints`; PROBADO |

## Aislamiento multicliente

PROBADO: `clientId`, `clientid`, `tenant`, `realm`, `fieldId`, `areaId`, `sensorId`, `physicalDeviceId` en el payload no influyen; ninguna consulta los transporta; A→B, A→B→A, bordes exactos, evento histórico de A con dispositivo hoy de B. Realm cruzado en sobre → `realm-mismatch`; realm por registro → rechazado por schema.

NO VERIFICABLE: que un adapter devuelva registros BE-11 de otro realm con sobre correcto (los registros BE-11 no llevan realm). El adapter productivo debe filtrar por realm en almacenamiento.

## Estado histórico del dispositivo (L1)

Comportamiento exacto: si la autoridad A devuelve `lifecycle !== 'active'` el gate devuelve `inactive-device` **antes** de consultar hardware, tiempo o asociaciones. Un evento cuyo instante cae en una ventana válida del pasado se bloquea igual.

Evaluación de alternativas:
- *Bloquear conservadoramente* (actual): correcto bajo fail-closed; costo de disponibilidad.
- *Código específico* (p. ej. `device-inactive-now`): no aporta información verificable adicional; `inactive-device` ya es específico.
- *Diferir*: requeriría un historial de lifecycle con contrato BE-11 que no existe.

Decisión: sin cambio. Clasificado como **limitación arquitectónica BLOQUEADA** hasta que BE-11 exponga lifecycle histórico o se apruebe que una ventana de asociación vigente implica dispositivo operativo. Observación: BE-11 exige dispositivo verificado al crear asociaciones, lo que sugiere (no prueba) la inversa.

## Temporalidad

Igualdad exacta: **intencional como placeholder conservador**. Sin política aprobada, cualquier comparación no exacta (parseo ISO, zonas, segundos vs milisegundos, redondeo) sería una política temporal implícita. Probado: cada reloj por igualdad exacta; dos relojes con el mismo valor (se reporta el que nombra la autoridad); ISO equivalente, segundos, fraccionario → `contradictory-authority`; `persistedAt` nunca es reloj de atribución; reloj del broker adelantado a recepción → rechazado; reloj de dispositivo ausente → rechazado; `persistedAt` nulo se conserva nulo.

## Catálogo, valores, hardware

- Catálogo: campo distinto → `contradictory-authority`; unidad vacía → `invalid-authority-response`; `incompatible-unit`; unidad distinta a la "esperada" se informa tal cual sin convertir el valor; revisión cambiante → `stale-resolution`; otro realm → `realm-mismatch`.
- Valores: `0` se conserva; `null` se conserva; ausencia → `absent-field`; un `missingReason` presente en el payload no se interpreta ni se traslada.
- Hardware: procedencia BE13-02 válida + autoridad negativa → `unverified-hardware`; veredicto para otro dispositivo u origen contradictorio → `contradictory-authority`; el candidate no participa en su propia atestación (la consulta solo lleva identificadores y origen declarado).

## Dependencias hostiles y timeout

Throw de `Error`, string, objeto con getters hostiles, `null`, `undefined`, número, Proxy; promesas rechazadas; thenable hostil → `dependency-error`. Respuestas Proxy/getter hostil/malformadas → `invalid-authority-response`. Mutación de la respuesta después de devolverla → sin efecto (copia Zod). Timeout: definido en `attribution-trust-gate.service.ts:31` (`DEFAULT_AUTHORITY_TIMEOUT_MS`), configurable 1–60000 ms con `authorityTimeoutMs`; al vencer → `dependency-error`; la operación del adapter no se cancela pero su resolución/rechazo tardío queda manejado (sin `unhandledRejection`, probado) y no altera el resultado. Es una **salvaguarda técnica provisional**, no un SLO aprobado.

## Códigos de cuarentena

Los 21 códigos se revisaron contra los escenarios. `stale-association` (asociación) y `stale-resolution` (resto) solo aparecen en la doble lectura; `realm-mismatch` solo con respuesta válida de otro realm del enum; `contradictory-authority` con respuestas bien formadas inconsistentes; `invalid-authority-response` con forma inválida; `internal-error` solo para excepciones no previstas (no se alcanzó en ninguna prueba adversarial). Ningún resultado incluye mensajes, stacks ni payload.

## Validaciones

| Comando | Resultado |
| --- | --- |
| `npm.cmd ci --offline` | OK, 0 vulnerabilidades |
| `npm run typecheck` | OK |
| `npm run build` | OK |
| `npm test` | **554/554** (528 + 26) |
| `node scripts/verify-be10-http.mjs` | 13/13 |
| `git diff --check` | OK |

## Estado por categoría

| Categoría | Elementos |
| --- | --- |
| IMPLEMENTADO | Registry privado en el mapper; `fingerprints` + `fingerprintAuthorityResponse`; copia fresca de `device`; aserciones de tipo BE-12 |
| PROBADO | 26 regresiones BE13-03A; 39 BE13-03; 64 BE13-02; suite 554/554; HTTP 13/13 |
| PENDIENTE | Conversión a `TrustedMeasurementEvent` (BE13-04); uso de `fingerprints` en la revalidación posterior; cancelación de adapters |
| BLOQUEADO | Lifecycle histórico de dispositivos; política temporal; catálogo BE-04; atestación de hardware; adapters reales |
| NO VERIFICABLE | Autenticidad frente a código hostil en el proceso; monotonía de revisiones; realm por registro BE-11; honestidad de autoridades consistentes |

## Recomendación

Apto para **revisión e integración en `dev` como código no compuesto**, con las condiciones siguientes. No apto para producción ni para atribución real.

### Condiciones exactas para integrar en `dev`

1. Revisión humana de los cambios en `protected-ingest.mapper.ts` (BE13-02) y aceptación explícita de que el registry es procedencia intra-proceso, no autenticidad.
2. Aceptación del nuevo campo `fingerprints` como parte del contrato `ready-for-attribution`.
3. Suite 554/554, HTTP 13/13, typecheck/build limpios en CI sobre la rama rebasada si `dev` avanzó.
4. El gate permanece sin composición en `app.ts`, sin rutas y con adapters bloqueantes por defecto.
5. PR propio, sin squash con otras etapas, sin modificar BE-12.

### Condiciones para BE13-04

Las de BE13-03 (política temporal, `missingReason`, `declaredAt`, `persistedAt` nulo, catálogo BE-04, hardware, adapters reales) más:
1. Revalidar cada autoridad comparando `revisions` **y** `fingerprints` recalculadas con `fingerprintAuthorityResponse`.
2. Decidir el tratamiento de dispositivos hoy inactivos con eventos históricos (L1).
3. Adapters productivos que filtren por realm en almacenamiento.
4. No usar el registry como control de seguridad frente a código no confiable.

## Revisión pre-publicación (ciclo de integración a `dev`)

- **Cambio BE13-02 (`protected-ingest.mapper.ts`)**: aditivo. `map()` devuelve el mismo objeto congelado con las mismas claves; las cuarentenas no se registran; `WeakSet` sin retención; sin efecto en determinismo; los 64 tests BE13-02/02A sin cambios. Puede "evitarse" accidentalmente solo hacia el lado seguro: un candidate copiado o serializado pierde procedencia y el gate lo rechaza. Se documentó el export en `CONTRATO_BE13_02_CANDIDATE.md`. `isIssuedProtectedCandidate` representa **solo procedencia dentro del mismo proceso**: no autenticidad criptográfica, ni hardware, ni EMQX, ni defensa frente a código hostil en el proceso. Sin defecto.
- **Fingerprints**: canonicalización = salida Zod estricta + `JSON.stringify`. Verificado: invariante al orden de propiedades; arrays sensibles al orden; `-0` ≡ `0`; sin normalización Unicode (NFC ≠ NFD); `undefined`, claves faltantes y `Date` rechazados (huella `null`); objetos congelados sin efecto. Con claves fijas por schema y tipos JSON primitivos no hay colisiones estructurales por serialización. Es huella de consistencia de contenido, no firma, MAC ni autenticación. Sin defecto; 2 regresiones agregadas.
- Validación: `npm test` **556/556**, HTTP 13/13, typecheck/build/diff-check OK. Diff contra `origin/dev` sin secretos, `.env`, `app.ts`, rutas, dependencias ni configuración Vercel/Atlas/EMQX.
