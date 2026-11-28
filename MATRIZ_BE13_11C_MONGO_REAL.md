# MATRIZ BE13-11C — Campaña MongoDB real local

Entorno: MongoDB 8.0 en réplica set de 3 nodos (Docker, desechable, loopback), lanzado con `scripts/be13-07-multinode-local.ps1 -AuthorizeDisposable -Suite be13-11c`. Script: `scripts/audit-be13-11c-multinode-local.ts`. 10 conexiones. Sin Atlas, sin EMQX, sin credenciales. El launcher exige árbol limpio y **no compila**: `dist` se reconstruyó del mismo HEAD antes de cada campaña.

## Resultado

23 checks de la campaña (los 19 pedidos C01–C19 más 4 adicionales) + limpieza confirmada por el launcher (C19). Corridas finales: ver §Corridas finales (al final).

| ID | Qué se prueba (Mongo real) |
|---|---|
| C01 | **N4 reproducida**: 7 admisiones con los dos secundarios pausados ⇒ todas `broker-inbox-unavailable`, ninguna con receipt; tras reanudar, los 7 registros existen en Mongo, sin medición y sin documento de estado. |
| C02 | Los 7 candidatos se detectan (antigüedad con reloj de BD). |
| C13 | `inspect-only` no cambia colecciones (estado, mediciones, inbox). |
| C14 | Límite de barrido respetado; límites inválidos rechazados. |
| C06 | Realm `preview`: reconciler, store, scan y claim no ven ni tocan registros de `test`. |
| extra | Política BLOCKED (placeholder): nada listado, reclamado ni procesado. |
| C03 | Dos claims simultáneos desde conexiones distintas ⇒ un solo ganador; versión 1. |
| C04 | Registro huérfano procesado desde los bytes persistidos: una medición; registro crudo idéntico antes/después. |
| C05 | Segunda reconciliación ⇒ `duplicate`. |
| C08 | 2 reconciliadores ⇒ un ganador, una medición. |
| C09 | 10 reconciliadores (10 conexiones) ⇒ un ganador, una medición. |
| C07 | Manipulación de bytes en Mongo ⇒ `integrity-failed`, pegajoso, sin medición. |
| C12 | Ya procesado ⇒ `already-processed`, sin segunda medición. |
| C10 | Claim vencido ⇒ takeover (versión 3 al completar); el titular viejo no puede completar. |
| C10b | **Completion stale con estado aún `claimed`**: solo el titular vigente completa. |
| C11 / C11b | Failover tras claim: primary detenido, nuevo primary toma el trabajo tras el lease; una medición. |
| C15 | Audit sin payload, topic, ids de cliente, ids de evento ni de inbox. |
| C16 | Métricas con labels cerrados. |
| C17 | `$jsonSchema` del estado rechaza documentos inválidos (código 121). |
| C18 | `explain`: el barrido usa `inbox_realm_persisted` (sin COLLSCAN); la colección de estado solo tiene `_id_`. |
| C20 | Estado final: una medición por evento, sin duplicados, todos los huérfanos completados; el manipulado nunca se procesó. |
| C19 | Cleanup confirmado por el launcher (`cleanupConfirmed: true`). |

## Stability run C11

Tres corridas independientes y completas de la campaña (cada una levanta y destruye su propio replica set). Datos tomados de la línea `C11_STABILITY` de cada log y del JSON del launcher.

| Corrida | Resultado | Primary inicial | Nuevo primary | Error labels / errores de driver | Measurement count (G) | Orphans | Cleanup |
|---|---|---|---|---|---:|---:|---|
| 1 | PASS (23/23) | nodo 0 | nodo 1 | ninguno observado | 1 | 0 | confirmado |
| 2 | PASS (23/23) | nodo 1 | nodo 0 | ninguno observado | 1 | 0 | confirmado |
| 3 | PASS (23/23) | nodo 0 | nodo 1 | ninguno observado | 1 | 0 | confirmado |

Detalle común: estado final del claim `completed`, versión 3 (claim v1 → takeover v2 → completion v3), `outcome: recovered-and-processed`; un registro crudo; 0 estados no completados; replica set sano (3 miembros con health=1) al terminar; reconcile del nuevo primary: `recovered-and-processed`; la completion del titular muerto: `false`.

Tiempo hasta confirmar nuevo primary (medido desde el `stop` hasta que una sonda en una conexión superviviente respondió con otro nodo primario): **20.4 s, 20.7 s, 20.8 s**. Es una cota superior aproximada: incluye la espera de selección de servidor del driver. "Errores de driver: ninguno" significa que la sonda no recibió excepciones; el driver bloquea en selección de servidor, por lo que las etiquetas transitorias no llegaron a la aplicación.

### Clasificación

`C11 = STABLE_LOCAL`: 3/3 con resultado consistente, máximo una medición, 0 claims/estados huérfanos o imposibles, cleanup confirmado y el nuevo primary permitió continuar. **No** es una garantía sobre Atlas ni Production.

### Historial honesto del flake

Antes de instrumentar C11 hubo **1 fallo en 6 corridas completas** de la campaña (las otras 5 pasaron; una séptima fue interrumpida a propósito y no cuenta). Ese intento no capturó diagnóstico, por lo que **la causa raíz no está demostrada**. La hipótesis más probable es una carrera del harness: la verificación de la completion stale no reintentaba una llamada que podía caer durante la elección del primary. Se corrigió reintentando esa llamada (no se subió ningún timeout), se instrumentó C11 con diagnóstico previo al cleanup (`C11_DIAGNOSTICS`) y, con esa versión, 3/3 pasaron y las corridas finales también. El cierre de N4 se apoya en las corridas con el harness corregido.

## Corridas finales (HEAD `c15682b`, `dist` reconstruido del mismo HEAD)

| Campaña | Resultado | Cleanup |
|---|---|---|
| BE13-11C corrida final 1 | 23/23 | confirmado |
| BE13-11C corrida final 2 | 23/23 | confirmado |
| Regresión BE13-11B | 27/27 | confirmado |
| Regresión BE13-11A | 13/13 | confirmado |
| Regresión BE13-10B | 28/28 | confirmado |

Sin contenedores ni redes residuales. No verificable: nada fue marcado como no verificable.
