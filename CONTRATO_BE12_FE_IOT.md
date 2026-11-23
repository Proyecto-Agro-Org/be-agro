# Contrato BE-12 — Fronteras FE / IoT

## IoT futuro

La frontera separa seis responsabilidades: autenticación del webhook, autenticación/verificación del hardware, identidad técnica, selección temporal, atribución empresarial y persistencia. Una credencial EMQX autoriza al emisor del webhook, no demuestra por sí sola que el dispositivo pertenezca a un cliente.

El adapter futuro debe entregar `TrustedMeasurementEvent`; payload, topic, `clientid`, `device_id` y timestamp declarado no pueden seleccionar cliente. Replay/idempotencia de recepción permanece en `iot-ingest`; BE-12 exige `eventId` estable y el storage debe imponer unicidad, pero no duplica el protocolo ACK.

## FE futuro

Operaciones internas preparadas:

- histórico por sensor lógico;
- histórico por dispositivo físico autorizado;
- histórico por área;
- histórico por campo;
- última medición atribuida.

Todos usan sesión, rango half-open, límite máximo 200 y cursor opaco. El DTO propuesto expone IDs técnicos necesarios, magnitud, unidad, valor/null, procedencia y fechas, pero no realm, clientId, asociación interna ni metadata cruda.

## Pendiente de aprobación conjunta

- paths, métodos, statuses y nombres definitivos;
- catálogo de variables visible y unidades canónicas;
- semántica de humedad y conductividad;
- representación pública de causas de `null` y procedencia;
- precisión temporal y cursor;
- política de latest cuando diferentes magnitudes tienen instantes distintos;
- autorización de acceso por dispositivo físico en UI.

Por estas decisiones no se agregan rutas ni OpenAPI productivo en BE-12.
