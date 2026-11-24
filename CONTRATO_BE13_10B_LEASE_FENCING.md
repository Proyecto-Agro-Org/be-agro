# BE13-10B — Contrato de fencing de replay

Fuentes: `src/iot/ingestion-composition.contracts.ts`, `src/repositories/mongo-measurement-persistence.repository.ts`, `src/services/measurement-ingestion-root.ts`.

## Puerto de persistencia

```ts
interface MeasurementPersistencePort {
  persistAtomically(input, options?: { fence?: (transaction: unknown) => Promise<boolean> }): Promise<PersistenceOutcome>;
  readonly replayFencing?: 'atomic';   // declaración explícita
}
```

- El fence se ejecuta **dentro** de la misma unidad atómica que las escrituras de claim y medición. Recibe la transacción como valor opaco; en Mongo, la `ClientSession`.
- Si el fence devuelve algo distinto de `true` o lanza una excepción, la unidad aborta y no se escribe nada (`INGESTION_REPLAY_FENCE_STALE`).
- Si ya existe un claim, el fence no se ejecuta: el resultado es `duplicate` o `conflict` y no hay escritura.
- Un replay se rechaza con `replay-fence-unsupported` si el adaptador no declara `replayFencing: 'atomic'`. En ese caso no se intenta nada y el servicio devuelve el lease.

## Fence de la cuarentena

```ts
settleReplay({ quarantineId, holder, to: 'RESOLVED', outcome: 'replay-persisted', evidence: 'replay' }, transaction)
```

- **Con lease:** filtro `realm + id + REPLAYING + lease.ownerId + lease.token`. Actualiza a `RESOLVED`, borra `lease` y hace `version+1`.
- **Sin lease** (replay directo de BE13-08): filtro `realm + id + RETRYABLE`. Un `discard`, `block` o una adquisición concurrentes lo invalidan.
- Dentro de la transacción no se fija `writeConcern` por operación: lo define la transacción (majority + j).

## Por qué no hay TOCTOU

La medición y la CAS del lease se confirman juntas o no se confirma ninguna. Hay tres órdenes posibles:

| Orden | Resultado |
| --- | --- |
| La recuperación o el discard confirman antes de que el fence escriba | El fence no coincide (o hay write-conflict con reintento y luego no coincide) → abort → sin medición (B14, B17) |
| El fence escribe primero (sin confirmar) y la recuperación llega después | La recuperación espera el lock del documento; cuando A confirma, la CAS ya no coincide → `stale-version` (B27) |
| Los dos chocan | Write-conflict; `withTransaction` reintenta con un nuevo snapshot y la CAS se reevalúa |

## Cierre del replay en la raíz

| Resultado del pipeline | Acción |
| --- | --- |
| Fence perdido (`lost`) | Corte inmediato: sin clasificación, recovery, reintento ni nueva cuarentena → `stale-replay-lease` |
| `accepted` (el fence resolvió) | La CAS final es stale y se ignora: la entrada ya está `RESOLVED` por este replay |
| `duplicate` / `recovered-committed` | CAS final a `RESOLVED`; si es stale y el fence no fue de este replay → `stale-replay-lease` (no escribió bajo su lease) |
| `BLOCKED` | CAS final a `BLOCKED`; con lease y stale → `stale-replay-lease` |
| Otro (transitorio) | CAS final a `RETRYABLE` (devuelve el lease); con lease y stale → `stale-replay-lease` |

Un error del store se distingue de `stale` y nunca se informa como stale.

## Composición por replay

`buildComposition` arma una composición con la persistencia que incluye el fence, usando el realm **ya fijado** al construir la raíz. No vuelve a consultar la autoridad de realm (BE13-07 V6).
