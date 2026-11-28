# BE13-06A — Matriz de vectores

## Offline (`test/be13-06a-adversarial.test.js`, 8/8)

| V | Vector | Resultado | Severidad |
| --- | --- | --- | --- |
| V1 | Realm forjado (clave o atribución), evento de otra clave, realm fuera del enum | rechazado sin abrir sesión | SIN HALLAZGO |
| V2 | Fingerprint inválido, operadores `$` en clave/atribución, campos extra, evento inválido, `persistedAt < receivedAt`; lookup de otro realm | rechazado antes de Mongo | SIN HALLAZGO |
| V3 | Construcción sin base conectada, prefijo o realm inválido | `TypeError`/error | SIN HALLAZGO |
| V4 | Colisión estructural de clave por concatenación | ids distintos | SIN HALLAZGO |
| V5 | Colisión de fingerprint: reordenar claves igual; cualquier cambio declarado distinto (valor, campo extra `null`, tipo, array) | según contrato | SIN HALLAZGO |
| V6 | Resultados Mongo hostiles (Proxy, getter, tipos, throw con URI) | fail-closed | SIN HALLAZGO |
| V7 | Asociación cross-client y asociación stale | nunca llegan al store | SIN HALLAZGO |
| V8 | Replay de transacción a nivel composición | `duplicate` con la misma referencia | SIN HALLAZGO |

## Mongo real (campaña)

| ID | Vector | Resultado |
| --- | --- | --- |
| A01 | Claim manipulado (identidad inconsistente) | fail-closed → `persistence-unavailable` |
| A02 | Medición incompleta | validador (121) |
| A03 | Documento BE-11 malformado | fail-closed |
| A04 | Asociaciones solapadas (otro cliente) | reportadas; `overlapping-association` |
| A05 | Realm forjado en persistencia | rechazado sin escribir |
| M03 | Clave de dispositivo duplicada | índice único BE-11 (E11000) / ambigüedad reportada |
| M11–M12b | Carreras de procesos (mismo o distinto fingerprint) | 1 escritura; resto `duplicate`/`conflict` |
| M13–M14 | Abort tras claim, tras insert, manual, transitorio | sin huérfanos; reintento sin duplicar |
| M15 | Mismo eventId en otro realm | independiente |
| M18 | Drift antes de BE-12 | 0 escrituras |
| Mutación | Claim fuera de transacción | campaña falla (detectado) |

## No verificable localmente

| Vector | Motivo |
| --- | --- |
| Failover / `UnknownTransactionCommitResult` real | nodo único |
| Atlas / red real | prohibido en esta etapa |
| Código hostil dentro del proceso | trust boundary en bootstrap |
