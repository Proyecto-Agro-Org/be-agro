# MATRIZ BE13-11F — Modos de fallo, severidad y estado

| ID | Fallo | Severidad | Estado | Mitigación en el sistema |
|---|---|---|---|---|
| F-F1 | Mensaje con PUBACK entregado y sin ACK no recuperado tras reinicio del broker (+ stale redelivery) | ALTO | ABIERTO (`BLOCKED_BY_BROKER_CAPABILITY`) | Ninguna del lado del consumer; idempotencia absorbe el stale; el publisher no puede detectar la pérdida |
| F-F2 | PUBACK anterior a la escritura durable (ventana = `flush_interval`) | ALTO | ABIERTO | Reducir `flush_interval` acorta la ventana pero no la elimina |
| F-F3 | Volúmenes Docker anónimos filtrados por contenedores del laboratorio y lanzador | BAJO | CORREGIDO | `docker rm -f -v` / `--volumes` sólo sobre recursos propios |
| F-F7 | Con Mongo sin majority más allá del timeout de elección (`term` 1→2) se pierden 59 de 60 eventos ya ACKeados: los claims y las mediciones desaparecen, los estados del inbox figuran `completed`. Reproducido 3 veces (D13b, y D13 con pausa efectiva larga). Causa probable (hipótesis, sin confirmar): rollback de escrituras no majority tras el step-down; el pre-check de idempotencia decide `duplicate` con datos aún no majority. NO es un hallazgo de EMQX | ALTO | ABIERTO (investigar en la etapa siguiente; no se modificó código de persistencia) | Ninguna; la pausa de 4 s (sin elección) recupera 60/60 |
| F-F4 | Arnés D13: sin espera de contabilidad ni recuperación `receipted` | BAJO | CORREGIDO | Mismo criterio `noLoss`, sin relajarlo |
| F-F5 | Disco lleno / volumen de sólo lectura | desconocida | NO_VERIFICABLE | Requiere un driver de volumen con límite; no se llena el disco del host |
| F-F6 | Mala configuración (cleanStart, expiry 0, clientId inestable, volumen nuevo) | MEDIO | MITIGADO en laboratorio | `assertDurableSessionConfig` |

Las clases se mantienen separadas: cola offline, estado inflight, stale redelivery y mala configuración no se suman.
