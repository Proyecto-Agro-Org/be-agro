# CONTRATO BE13-11D — Recuperación de registros `receipted` sin dueño (hallazgo R1)

## Problema

BE13-11C dejó abierto: un registro `receipted` (receipt emitido, ACK enviado) cuyo consumer murió antes de crear la medición no era reclamable. Con un consumer real el caso es relevante (E20): el broker ya no reentrega y el registro quedaría pendiente para siempre.

## Modelo

- El registro crudo sigue **inmutable**. El estado vive en `<prefix>_broker_inbox_state`.
- `markReceipted` ahora guarda `receiptedAt` con el **reloj de la base de datos** (`$$NOW`), insert-only.
- Un `receipted` es reclamable **solo** si la política inyectada `ReceiptedDeliveryRecoveryPolicy` lo permite y su antigüedad (reloj de BD) supera `minAgeMs`.
- La política productiva es **BLOCKED** (ninguna edad elegida). Las pruebas usan `TEST_ONLY` (1500 ms, valor sintético).
- Claim CAS: `receipted (v1) → claimed (v2, nuevo token)`; la completion fenceada lleva a `completed (v3)`. Igual que BE13-11C, un titular viejo no puede completar.
- Un único índice nuevo: `{ realm, status, receiptedAt }` para listar `receipted` viejos de un realm.

## Flujo de recuperación

`reconcileOne(inboxId)` / `reconcileBrokerInbox(...)` → claim desde `receipted` → integridad (SHA, contexto, procedencia) → `processPersistedBrokerDelivery` → `recovered-and-processed` o `already-processed` (si el consumer "muerto" solo estaba lento o la entrega se reprocesó por redelivery).

## Garantías probadas

| Propiedad | Evidencia |
|---|---|
| BLOCKED por defecto; formas inválidas ⇒ BLOCKED | R-A, R-F |
| Un registro joven no se reclama (su dueño puede seguir vivo) | R-B |
| Recuperación única + segunda recuperación `duplicate` | R-B, E21/E22 |
| Si el dueño termina primero, la recuperación es no-op | R-C |
| 5 recuperadores: un ganador, una medición | R-D |
| Integridad antes de procesar | R-E |
| Aislamiento por realm | E21c, mutante M7 |
| Proceso real muerto tras el ACK ⇒ recuperado (una medición) | E20, E21 |

## Estado del hallazgo R1

**CLOSED_LOCAL**: demostrado con un consumer real matado después del ACK, recuperación por política TEST_ONLY y segunda recuperación segura. El **valor** de la antigüedad, quién ejecuta la recuperación y con qué frecuencia siguen pendientes (decisiones 37, 38, 43 y 47).
