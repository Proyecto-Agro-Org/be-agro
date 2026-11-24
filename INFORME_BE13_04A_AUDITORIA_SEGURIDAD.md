# BE13-04A — Auditoría adversarial del Trusted Event Builder

## Método

Después de pasar las pruebas funcionales se atacó el builder con 18 vectores automatizados (`test/be13-04a-adversarial.test.js`), revisión de código línea a línea y verificación de mutación (3 controles rotos deliberadamente en `dist` → detectados por la suite). Los tipos de TypeScript no se consideraron frontera de seguridad: todos los vectores usan objetos JavaScript arbitrarios.

## Hallazgos

| ID | Severidad | Descripción | Evidencia | Acción | Estado |
| --- | --- | --- | --- | --- | --- |
| A1 | MEDIO (arquitectónico) | BE-12 vuelve a resolver con `ResolvedPhysicalDevice`/`AttributionWindow`, sin versión ni fingerprint; no puede confirmar que lo que atribuye coincide con `attribution`/`revisions` de BE13-04. | Contratos BE-12 (`measurements/contracts.ts`) | Documentado; no se modificó BE-12. La composición debe comparar el `AttributionResult` con `attribution` y cuarentenar si difiere. | PENDIENTE |
| A2 | BAJO | Sin atomicidad entre las cinco relecturas: un cambio revertido entre lecturas (ABA) no se detecta; cambios posteriores al retorno tampoco. | Diseño | `revalidation:'required'`; documentado. | RESIDUAL |
| A3 | BAJO | El mismo par (candidate, ready) puede producir el evento repetidas veces. | V-replay (comportamiento determinista, #26) | Idempotencia por `eventId` en persistencia futura. | PENDIENTE |
| A4 | BAJO (preventivo) | Nada impedía en compilación que el resultado BE13-04 se tratara como `AttributionResult` o `TrustedMeasurementEvent`. | — | Aserciones agregadas en `trust-gate.type-assertions.ts`. | CORREGIDO |
| A5 | BAJO (preventivo) | Un resultado `quarantined` del gate podía intentar usarse como ready. | V18 | Confirmado rechazado (`invalid-ready`); regresión agregada. | SIN DEFECTO |

No se demostró ningún bypass CRÍTICO, ALTO ni MEDIO en el código de BE13-04. No se inflaron severidades.

## Vectores resistidos

Ready fabricado, clonado, spread, `structuredClone`, JSON, Proxy, `Object.create`, `setPrototypeOf`, descriptores idénticos, ready de otra instancia del módulo del gate, ready genuino emparejado con otro candidate genuino de igual contenido, revisiones/fingerprints falsos (objeto congelado; copias rechazadas), revalidadores contradictorios (ambigüedad, ausencia, otro dispositivo, otra asociación, temporal no resuelto, origen de hardware cambiado), omisión de revalidadores, opción `skipRevalidation`, políticas `null`, políticas que inventan o reetiquetan instantes (declaredAt, clock, persistedAt), missingReason forzado sobre números, payload con `clientId`/`physicalDeviceId`/`realm`/`tenant`, realm cruzado en los 5 revalidadores y 3 políticas, spoofing temporal vía revalidador, throws hostiles (string, `null`, `undefined`, getters, Proxy), thenable hostil, timeout, mutación tardía de respuestas, diagnósticos en cuarentena. Detalle: `MATRIZ_BE13_04A_VECTORES.md`.

## Procedencia del ready (fase 27)

Hace falta: sin ella, un caller podría presentar un ready con `field`, `value` o `eventId` arbitrarios que la revalidación de autoridades no cubre. Se usa un `WeakMap` privado `ready → candidate` en el módulo del gate; solo se exporta `isIssuedReadyFor`. Alcance: **procedencia intra-proceso**; no es autenticación ni protege frente a código hostil en el proceso (que puede instanciar su propio gate con autoridades falsas).

## Políticas falsas (fase 28)

Un caller del mismo proceso puede construir políticas y revalidadores que aprueben todo. El builder limita lo que una política puede afirmar (valores atados a relojes del candidate, consistencia de clock, persistedAt exacto), pero no puede distinguir una política honesta de una maliciosa consistente. **El trust boundary real está en la composición de la aplicación**, que no existe todavía.

## Validaciones

`npm.cmd ci --offline` OK · typecheck OK · build OK · `npm test` **610/610** · HTTP 13/13 · `git diff --check` OK.

## Recomendación

BE13-04 queda listo para revisión local. No publicar ni integrar hasta decidir: políticas de clock/declaredAt/missingReason/persistedAt, `DEVICE_STATUS_HISTORY_REQUIRED`, y el mecanismo de comparación BE-12 ↔ `attribution` en la composición.

## Revisión final pre-publicación

### Extracción de helpers sin cambio observable

Prueba diferencial (script local, fuera del repo): el gate de `dev` `6f6c5c8` (antes de extraer `authority-call.ts` y `trust-gate.queries.ts`) y el gate de esta rama se ejecutaron sobre los mismos 30 escenarios, que cubren 19 resultados distintos (6 `ready-for-attribution` y 18 códigos de cuarentena). **30/30 resultados idénticos**, fingerprints incluidos. Las suites BE13-02/02A/03/03A siguen en 131/131. Única diferencia: el texto del `TypeError` de construcción cambia de "authority" a "port" (tipo de error sin cambios).

### WeakMap `ready → candidate`

- Identidad de objeto: copias, spread, JSON, `structuredClone`, Proxy, `Object.create`, otra instancia del módulo y otro candidate de igual contenido → rechazados (V1–V4, V18).
- Memoria (Node 24, `--expose-gc`, 20 000 pares con payload ~2 KB): base 8,7 MB; candidates + readies vivos 53,0 MB; solo readies vivos 51,6 MB (un ready vivo mantiene vivo a su candidate, por diseño); readies descartados 10,8 MB. Sin fuga: el WeakMap no retiene readies descartados ni sus candidates.
- `isIssuedReadyFor` es **procedencia dentro del mismo proceso**. No es autenticación, firma, MAC ni atestación, y no protege frente a código hostil en el proceso.

### Revalidación

Matriz V19: 5 autoridades × {contenido distinto con igual revisión, solo revisión, ambos, vacía, malformada, `undefined`, otro realm} = 35 combinaciones, todas fail-closed con el código esperado. La comparación usa la misma canonicalización que BE13-03 (`trust-gate.fingerprint.ts`), cubre la respuesta completa, compara valores (no referencias) y no tiene defaults.

### Estrategia A1 para BE13-05

Composición externa sin modificar BE-12: después de `resolve()` de BE-12, comparar su `AttributionResult` con `attribution` y el evento de BE13-04: `eventId`, `sourceId`, `realm`, `physicalDeviceId`, `clientId`, `fieldId`, `areaId`, `sensorId`, `associationId`, `associationRevision`, `attributedAt = authorizedAt` y `clock`. Cualquier diferencia → cuarentena `attribution-drift`, sin persistir.

Validación: 611/611 (610 + V19), HTTP 13/13.
