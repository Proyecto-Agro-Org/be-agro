# ADR BE13-10B — Cierre de S7 (liberación indebida de lease durante un replay)

## Estado

**Aceptado. S7: CLOSED.** La duración del lease, la autoridad temporal productiva y el proveedor de identidad siguen **pendientes de decisión humana**; el cierre no depende de ninguno de ellos.

## Riesgo

S7 (MEDIO, BE13-09): `releaseLease` no exigía ser dueño ni que el lease hubiera expirado. Secuencia: A adquiere el lease → el replay de A está en curso → B libera el lease → B descarta la entrada → el replay de A termina y persiste una medición de una entrada `DISCARDED`.

## Decisión

1. **Propiedad persistida.** La cuarentena guarda `lease = { ownerId, acquiredAt, token }` mientras está en `REPLAYING`. `ownerId` es el `operatorId` del principal autorizado. `acquiredAt` sale de `OperationsTimeAuthority`. `token` es la versión que produce la CAS de adquisición.
2. **Una sola CAS para adquirir** (`acquireLease`): `realm + id + RETRYABLE + version` → `REPLAYING + lease`. Sin tiempo confiable no se adquiere.
3. **Una sola CAS para terminar** (`settleReplay`): `realm + id + REPLAYING + ownerId + token (+ version)` → `RESOLVED | RETRYABLE | BLOCKED`, y borra `lease`. El `transition()` genérico ya no puede entrar ni salir de `REPLAYING`.
4. **Liberación voluntaria solo para el dueño** (`releaseLease`, `QUARANTINE_REPLAY`). Se compara la identidad estable (`operatorId`), nunca un objeto ni un campo del request.
5. **Recuperación de un lease expirado** (`recoverExpiredLease`, `QUARANTINE_UNBLOCK`) solo si se cumplen todas estas condiciones:
   - el tiempo es confiable;
   - la `ReplayLeasePolicy` responde `EXPIRED` de forma explícita, bien formada y para el mismo realm;
   - la política permite `recoveryByNonOwner: 'when-expired'`;
   - la CAS de versión, dueño y token se cumple;
   - existe un audit obligatorio previo.
   
   Cualquier otra respuesta deja el lease `ACTIVE`. La entrada vuelve a `RETRYABLE`. Un nuevo replay o un discard son operaciones separadas: no hay takeover directo.
6. **Fencing transaccional.** Al persistir, la CAS de `settleReplay` hacia `RESOLVED` corre **dentro de la misma transacción Mongo** que el claim y la medición. Si el lease ya no pertenece al replay, la CAS no coincide, la transacción aborta y **no existe medición**. Si una recuperación o un discard concurrentes tocan el mismo documento, hay write-conflict y confirma exactamente uno.
7. **El token de fencing no es `version`.** `version` también aumenta con cada recurrencia de `record()`, que es ajena al lease: un fence sobre `version` haría fallar sin motivo al dueño legítimo. El token es la versión en el instante de adquirir: es monotónico, único por adquisición y no aleatorio. No es un secreto ni un autenticador; la propiedad la prueba la identidad autorizada.
8. **Capacidad de recuperación.** Se reutiliza `QUARANTINE_UNBLOCK`: recuperar un lease ajeno devuelve una entrada trabada a `RETRYABLE`, que es semánticamente un desbloqueo, y permite que el mapeo y la SoD lo separen de "reprocesar". No se agregó una capacidad nueva, lo que evita cambiar el vocabulario y el validator del audit.

## Alternativas descartadas

- **Verificar el lease y después escribir, sin transacción:** TOCTOU evidente.
- **Fence sobre `version`:** falsos stale por recurrencias.
- **Token aleatorio (UUID):** no ordena las adquisiciones ni aporta nada que el token monotónico no tenga.
- **Takeover A→B en una sola operación:** oculta la recuperación en el audit.
- **Expiración automática por worker o TTL:** exige elegir una duración (decisión humana) y agrega runtime.

## Evidencia del cierre

| Criterio | Evidencia |
| --- | --- |
| Protección del dueño activo | B03, B15, B25 (Mongo real); offline B03, B15/B25a, A01, A08 |
| Expiración fail-closed | B06–B09; offline B06–B08, A04, A05 |
| Recuperación autorizada | B10, B11, B23; offline B09/B10, B11, A10 |
| CAS | B05, B12 (2 conexiones), B13 (10 conexiones); offline B05, B12, B13, A08, A11 |
| Fencing final | B14, B17, B27 (Mongo real, escritura stale bloqueada en la transacción); offline B14, A06, fence sin lease |
| Sin escritura stale | B14 (1 medición), B17 (0 mediciones con `DISCARDED`), B27 (gana el fence) |
| Campaña Mongo | 28/28 × 2 |
| Mutantes | 6/6 detectados (M1 dueño, M2 fence de la raíz, M3 expiración, M4 versión, M5 realm sobre Mongo real, M6 fence del adaptador sobre Mongo real) |

## Consecuencias

- Por defecto (placeholders) no se puede adquirir un lease, porque el tiempo no es confiable. El replay queda bloqueado hasta inyectar una autoridad temporal: es fail-closed.
- Un lease huérfano solo se recupera con una política que declare `EXPIRED`. Sin esa política, solo su dueño puede liberarlo. No hay worker.
- Un adaptador de persistencia que no declara `replayFencing: 'atomic'` no puede ejecutar replays.
- La migración del validator se bloquea si existen entradas `REPLAYING` sin dueño (heredadas de BE13-09).
