# BE13-10B — Campaña Mongo real (local, desechable)

Entorno:

- Replica set local de 3 nodos, MongoDB **8.0.38**, Docker, `127.0.0.1:27071-27073`.
- Lanzador: `scripts/be13-07-multinode-local.ps1 -AuthorizeDisposable -BasePort 27071 -Suite be13-10b`. Exige el árbol limpio y `npm run build` previo.
- **10 conexiones independientes**, una por operador: la concurrencia es real del lado del servidor.
- Operadores, reloj y ventana sintéticos (`TEST_ONLY_WINDOW = 1 000` unidades). Sin Atlas, EMQX, hardware ni credenciales.

Compuertas reales en la transacción de persistencia (seams del adaptador):

- **`after-read`:** A ya tiene el lease y su fence aún no corrió.
- **`after-fence`:** la escritura de fence de A está dentro de su transacción, sin commit.

## Corridas

| Corrida | SHA | Resultado | Limpieza |
| --- | --- | --- | --- |
| 1 | `e243547` | **28/28** | `cleanupConfirmed: true` |
| 2 | `e243547` | **28/28** | `cleanupConfirmed: true` |
| Regresión `be13-09` | `e243547` | 24/24 | sí |
| Regresión `be13-08` | `dcecd6f` (Q09 y Q22 actualizadas) | 25/25 | sí |

**Por qué 28 y no 26:** son B01–B26 pedidos más B27 (carrera en la que el fence escribe primero) y B-MIG (migración del validator), agregados porque prueban propiedades de S7 y de la migración que el listado no cubría.

## Escenarios

| ID | Escenario | Resultado |
| --- | --- | --- |
| B01 | Adquisición | `lease.ownerId = op-a`; `acquiredAt` BSON date igual al reloj confiable; `token = version`; sin `lease` después de `RESOLVED` |
| B02 | El dueño libera su lease activo | `RETRYABLE`; `lease` eliminado del documento |
| B03 | Un no-dueño libera un lease activo | `lease-owned-by-another-operator` / `lease-active` |
| B04 | Realm ajeno | operador preview denegado; store preview → `not-found` |
| B05 | Versión vieja | `stale-version` |
| B06 | Tiempo no confiable | sin adquisición y sin expiración |
| B07 | Tiempo malformado | `time-authority-unavailable` |
| B08 | La política lanza | `lease-policy-unavailable` |
| B09 | `ACTIVE` explícito | `lease-active` |
| B10 | `EXPIRED` explícito con `UNBLOCK` | `RETRYABLE`, sin `lease` |
| B11 | Recuperación sin `UNBLOCK` | `forbidden` |
| B12 | 2 recuperaciones en 2 conexiones | 1 ganador, 1 `stale-version` |
| B13 | 10 recuperaciones en 10 conexiones | 1 ganador, 9 `stale-version`; 1 audit `lease-recovered-expired` |
| B14 | Replay stale tras recuperación y readquisición | A `stale-replay-lease`; B `RESOLVED`; **1 medición** |
| B15 | Replay activo (compuerta tras el fence) | B denegado al liberar y al descartar; A `RESOLVED`; 1 medición |
| B16 | Replay vs discard en conexiones separadas | un solo ganador; nunca `DISCARDED` con medición (corrida 2: ganó el discard) |
| B17 | Recuperación y discard con A en curso | A `stale-replay-lease`; **0 mediciones**; `DISCARDED` |
| B18 | Dueño o token que no coinciden | `stale-replay-lease`; `settleReplay` con dueño ajeno → `stale` |
| B19 | Validator: `REPLAYING` exige un lease completo | sin lease o incompleto → 121; completo → aceptado |
| B20 | Validator: lease incoherente con el estado | `RETRYABLE` o `RESOLVED` con lease, `ownerId` con espacio, fecha string, token 0, campo extra → 121 |
| B21 | Audit `lease-acquired` | con actor `op-a` |
| B22 | Audit de denegaciones | 2 × `lease-release-denied` |
| B23 | Audit de recuperación | `lease-recovery-requested` antes que `lease-recovered-expired` |
| B24 | Falla de audit | `audit-unavailable`; sigue `REPLAYING` con el mismo dueño |
| B25 | **Reproducción exacta de S7** | B no libera, el lease sigue activo, B no descarta; A persiste |
| B27 | Gana el fence | una recuperación emitida durante la transacción de A espera el lock y pierde; A `RESOLVED`, 1 medición |
| B-MIG | Migración del validator | documentos legados (`OPEN`, `RETRYABLE`, `BLOCKED`, `RESOLVED`, `DISCARDED`) válidos tras el upgrade; un `REPLAYING` sin dueño **bloquea** el upgrade; `→ REPLAYING` sin lease → 121; validator de audit actualizado |
| B26 | Limpieza | confirmada por el lanzador |

## Mutantes sobre la campaña real

| Mutante | Corrida | Detectado en |
| --- | --- | --- |
| M5 realm fuera de las CAS de lease | falla | B04 |
| M6 el adaptador ignora el fence | falla | B17 (escritura stale) |
