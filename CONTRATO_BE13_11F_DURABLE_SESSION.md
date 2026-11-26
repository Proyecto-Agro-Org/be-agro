# CONTRATO BE13-11F — Sesión durable del consumer EMQX (laboratorio)

`LOCAL_TEST_ONLY`. Valores de laboratorio, no propuestas productivas.

## Requisitos del broker (probados en 5.8.6 CE)

- `durable_sessions.enable = true` (`EMQX_DURABLE_SESSIONS__ENABLE`).
- `cluster.discovery_strategy = singleton` y `node.name` estable (el backend `builtin_local` guarda RocksDB en `/opt/emqx/data`).
- Volumen persistente montado en `/opt/emqx/data`; sin él (D08) la sesión se pierde.
- `durable_storage.messages.local_write_buffer.flush_interval` y `max_items` definen la ventana en que un PUBACK ya enviado aún no está en disco.

## Requisitos del cliente (guard `assertDurableSessionConfig`)

- `clean = false` (`LAB_DURABLE_CONFIG_CLEAN_START_FORBIDDEN`).
- `sessionExpiryInterval > 0` (`LAB_DURABLE_CONFIG_SESSION_EXPIRY_REQUIRED`).
- `clientId` estable (`LAB_DURABLE_CONFIG_STABLE_CLIENT_ID_REQUIRED`); un clientId distinto no reclama la sesión (D17/D18).
- MQTT 5; ACK sólo tras el recibo durable del inbox (11D); sin ACK se corta la conexión y el broker reentrega.

## Garantías que se pueden afirmar (local)

- Los mensajes confirmados a una sesión desconectada sobreviven a reinicio ordenado, stop/start, recreación con el mismo volumen y SIGKILL con buffer afinado.
- Con cola recuperada, inbox e idempotencia: una medición por evento.

## Garantías que NO se pueden afirmar

- Que un mensaje con PUBACK sobreviva a un reinicio si estaba entregado y sin ACK (D04).
- Que un crash duro dentro de `flush_interval` no pierda mensajes (D27).
- Orden global, exactly-once del broker, HA/clúster, disco lleno o de sólo lectura (D28/D29 `NO_VERIFICABLE`).

La garantía «no perder lo confirmado» sigue dependiendo de decisiones humanas (matriz, filas 63–70); F-E2 permanece `BLOCKED_BY_BROKER_CAPABILITY`.
