# ADR BE13-08 — Semántica de reintentos y commit ambiguo

Estado: **ACEPTADA para el entorno local** (no habilita runtime). Fecha: 24/11/2026.

## Contexto

BE13-07 demostró con evidencia REAL que un commit puede ser ambiguo: el llamador recibe `UnknownTransactionCommitResult` (p. ej. `writeConcernError MaxTimeMSExpired`) y la medición queda confirmada. Hasta ahora eso llegaba como `persistence-unavailable` (R1). Además, el lookup de idempotencia lee el claim con read concern `local`, mientras que la verdad durable es la majority.

## Decisión

1. **Un commit ambiguo es incertidumbre, no éxito ni fracaso.** Ante `persistence-unavailable` se ejecuta primero un **recovery read-only con read concern `majority`** sobre la clave lógica (`realm + sourceId + operation + eventId + field`):
   - `committed` + mismo fingerprint → `recovered-committed` (cero escrituras nuevas);
   - `committed` + fingerprint distinto → cuarentena `idempotency-conflict`;
   - `inconsistent` (claim sin medición, medición sin claim, referencias o fingerprints contradictorios, documentos malformados) → cuarentena `persistence-state-inconsistent` (BLOCKED), **sin reparar ni borrar evidencia**;
   - `not-committed` → se trata como transitorio y pasa por la política de reintentos;
   - recovery no disponible o respuesta inválida → cuarentena `persistence-uncertain` (RETRYABLE).
2. **Todo `duplicate` se confirma contra el estado majority.** Si el claim se vio en el lookup pero no está confirmado en majority (retraso de replicación o partición), es incertidumbre (`persistence-uncertain`, reintento), no corrupción. Este caso apareció en la campaña real (Q05).
3. **Un retry conserva la identidad exacta**: mismo candidate (mismo `realm`, `sourceId`, `operation`, `eventId`, `field`) y mismo fingerprint técnico. Nunca se genera un `eventId` nuevo para resolver incertidumbre.
4. **La clasificación es determinista y vive en el código** (`classifyIngestionFailure`). Clases: `transient`, `ambiguous-commit`, `validation`, `security`, `conflict`, `policy-blocked`, `consistency`, `unknown`. Solo `transient` es reintentable. Ninguna política, flag de payload ni parámetro del llamador puede volver reintentable un fallo de seguridad, validación, conflicto, política o consistencia.
5. **La política de reintentos (`IngestionRetryPolicy`) es inyectable y solo decide `retry | stop`** para fallos `transient`. Los delays los ejecuta un `RetryScheduler` inyectable (en pruebas, determinista y sin esperas reales). Hay además un **techo duro de 10 intentos por llamada**, independiente de la política: es una red de seguridad, no un SLO.
6. **Defaults productivos bloqueantes**: la política placeholder nunca reintenta y el scheduler placeholder nunca agenda. Todo fallo reintentable termina en cuarentena RETRYABLE, a la espera de un replay explícito.
7. **Agotar los reintentos lleva a cuarentena (RETRYABLE, causa `retry-exhausted`)**, nunca a descarte.

## Qué no se garantiza

- Exactly-once global: la garantía es local al store y a su transacción.
- Distinguir el commit propio de uno concurrente con el mismo contenido: ambos se informan como "ya persistido" (`duplicate` o `recovered-committed`).
- Resolver la incertidumbre durante una partición prolongada: el resultado queda en cuarentena RETRYABLE.
- Valores productivos de `maxAttempts` y backoff: siguen siendo una decisión pendiente (`TEST_ONLY` en las pruebas).
