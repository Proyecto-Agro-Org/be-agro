# CONTRATO BE13-11E — Concurrencia del consumer

## Hechos medidos (`LOCAL_LAB_EVIDENCE`)

- **Una entrega a la vez por conexión.** Mientras el callback de ACK está pendiente, MQTT.js no inicia otra entrega de esa conexión. Con un retardo artificial de 40 ms en el handler, el máximo de handlers concurrentes fue **1** con `receiveMaximum` por defecto, 1, 10 y 100 y con ventana de publicación de 64 (T06). El broker mantiene hasta 32 mensajes en vuelo hacia ese cliente (`inflight_cnt`), pero el cliente los atiende en serie.
- **El throughput depende del consumer, no de los publishers.** 1, 2, 5, 10 y 25 publishers dieron aproximadamente el mismo ritmo de eventos procesados (ver `MATRIZ_BE13_11E_BENCHMARK.md`): el cuello es persistir en el inbox con `w: majority, j: true` + ACK + el procesamiento posterior, serializados.
- **El procesamiento posterior al ACK no bloquea la recepción siguiente**: corre de forma asíncrona (`ACK → measurement`), pero sí compite por CPU y por Mongo con la siguiente persistencia.

## Reglas de concurrencia seguras

1. **No ACKear antes del receipt durable majority.** Rechazado cualquier diseño que ACKee antes (mutante M1).
2. **No paralelizar ACKs dentro de una conexión** sin demostrar seguridad. Cada entrega debe conservar sus bytes, su principal, su receipt, su `inboxId` y su propio callback; ningún estado mutable compartido entre entregas.
3. **El procesamiento posterior lee siempre del registro persistido** (`processPersistedBrokerDelivery({ inboxId })`), nunca de variables compartidas entre entregas.
4. **La idempotencia de negocio es la defensa final**: los duplicados (reentrega, varios `clientId`, recuperación) producen una sola medición.
5. **Claim con CAS** para recuperación y reconciliación: con tres ejecutores paralelos, cada registro se recupera exactamente una vez (T19, T20).
6. **Un resultado `uncertain` nunca marca el registro como completado** (hallazgo F-E1, corregido): queda `receipted` y la recuperación lo reintenta.

## Orden

- **Persistencia:** el orden de persistencia por fuente se conservó (0 violaciones en T23/T24).
- **Medición:** el procesamiento es asíncrono tras el ACK; en una fuente secuencial se observaron algunas inversiones del orden de medición (T23). **No existe orden global ni se promete orden por fuente en las mediciones.** Si el negocio necesita orden por `sourceId`, es un requisito nuevo (decisión 56).

## Opciones de escalado (sin elegir)

Ver `ADR_BE13_11E_CONSUMER_SCALING_OPTIONS.md`.
