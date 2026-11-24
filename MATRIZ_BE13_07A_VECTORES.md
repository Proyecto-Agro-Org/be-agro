# BE13-07A — Matriz de vectores

## Offline (`test/be13-07a-adversarial.test.js`, 9/9; `test/be13-07-multinode-guard.test.js`, 3/3)

| V | Vector | Resultado | Severidad |
| --- | --- | --- | --- |
| V1 | Import de `test-support` desde `src/`; exports de placeholders y root | ninguno; solo factories bloqueantes | SIN HALLAZGO (prueba corregida, H4) |
| V2 | Modo permisivo por variables de entorno (`AGRO_INGEST_PERMISSIVE`, `NODE_ENV`, …) | sin efecto; sin `process.env` en el root | SIN HALLAZGO |
| V3 | Autoridad "productiva" falsa; copia de un placeholder | `INJECTED_UNVERIFIED`; la copia sigue bloqueando | SIN HALLAZGO |
| V4 | Bypass del root con la composición de nivel inferior | posible en proceso; documento crudo / candidate clonado → `invalid-candidate` | LIMITACIÓN |
| V5 | Evidencia de otro documento, sin evidencia, flag no booleano, candidate como documento | `unverified-provenance` / `mapper-rejected` | SIN HALLAZGO |
| V6 | Realm suplantado; authority que cambia después de construir | ignorado | SIN HALLAZGO |
| V7 | Filas de otro realm filtradas por el store | `realm-mismatch` | SIN HALLAZGO |
| V8 | Políticas malformadas o mentirosas | `invalid-authority-response` / `contradictory-authority` | SIN HALLAZGO |
| V9 | TOCTOU tras aceptación | instantánea; retry → `duplicate` | LIMITACIÓN |
| G1 | Solicitud multi-nodo sin autorización explícita u override de destino | rechazada | SIN HALLAZGO |
| G2 | URI `+srv`, Atlas, credenciales, IP no loopback, 1 host, otro replica set, `directConnection`, TLS; `hello` con miembros remotos | rechazados | SIN HALLAZGO |
| G3 | Launcher: binding loopback, namespace del holder, limpieza confirmada, sin privilegios/volúmenes; caos con lista cerrada | verificado | SIN HALLAZGO |

## Multi-nodo real

| ID | Vector | Resultado |
| --- | --- | --- |
| MN03/MN11/MN16 | Pérdida, reinicio y pausa del primary | consistente; sin duplicados ni huérfanos |
| F02–F04 | Pérdida del primary dentro de la transacción | reintento real; 1 medición |
| MN14 | Commit ambiguo | `UnknownTransactionCommitResult` real; datos confirmados; retry → `duplicate` (R1) |
| MN08–MN09b | Carreras multiproceso | 1 escritura; resto `duplicate`/`conflict` |
| MN10 | Cross-realm | independiente |
| F05 | Parada durante el commit | NO VERIFICABLE |
| MN-NET | Desconexión individual de red | NO VERIFICABLE (namespace compartido) |
