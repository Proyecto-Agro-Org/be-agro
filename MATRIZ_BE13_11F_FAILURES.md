# MATRIZ BE13-11F — Modos de fallo, severidad y estado

| ID | Fallo | Severidad | Estado | Mitigación en el sistema |
|---|---|---|---|---|
| F-F1 | Mensaje con PUBACK entregado y sin ACK no recuperado tras reinicio del broker (+ stale redelivery) | ALTO | ABIERTO (`BLOCKED_BY_BROKER_CAPABILITY`) | Ninguna del lado del consumer; idempotencia absorbe el stale; el publisher no puede detectar la pérdida |
| F-F2 | PUBACK anterior a la escritura durable (ventana = `flush_interval`) | ALTO | ABIERTO | Reducir `flush_interval` acorta la ventana pero no la elimina |
| F-F3 | Volúmenes Docker anónimos filtrados por contenedores del laboratorio y lanzador | BAJO | CORREGIDO | `docker rm -f -v` / `--volumes` sólo sobre recursos propios |
| F-F4 | Arnés D13: sin espera de contabilidad ni recuperación `receipted` | BAJO | CORREGIDO | Mismo criterio `noLoss`, sin relajarlo |
| F-F5 | Disco lleno / volumen de sólo lectura | desconocida | NO_VERIFICABLE | Requiere un driver de volumen con límite; no se llena el disco del host |
| F-F6 | Mala configuración (cleanStart, expiry 0, clientId inestable, volumen nuevo) | MEDIO | MITIGADO en laboratorio | `assertDurableSessionConfig` |

Las clases se mantienen separadas: cola offline, estado inflight, stale redelivery y mala configuración no se suman.
