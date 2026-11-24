# BE13-02 — Contrato del mapper IoT protegido

## Estado

IMPLEMENTADO y PROBADO offline. No está compuesto en la aplicación pública y no constituye aprobación productiva de EMQX, hardware, relojes, magnitudes ni Atlas.

## Entrada técnica

El mapper acepta exclusivamente la forma persistida por el store protegido de `iot-ingest`:

- `_id?`, `sourceId`, `operation`, `eventId`, `clientid`;
- `_receivedAt` y `persistedAt?` como `Date` válidos;
- `_payload` como objeto JSON técnico acotado;
- `_provenance` estricto con identidad repetida, contexto MQTT, tiempos y negaciones explícitas de verificación física y atribución comercial.

La estructura correcta no prueba procedencia. El documento debe acompañarse por una capacidad opaca emitida por `createIngestProvenanceAuthority`. Esa capacidad queda vinculada en memoria a `sourceId`, tipo de mensaje, `eventId` y `TechnicalDeviceKey`. Copiarla, serializarla o presentar `trusted=true` no autoriza el documento.

## Resultado `candidate`

Un candidato contiene:

- `sourceId`, `storeOperation`, operación técnica y `eventId`;
- `device:{kind,value}` y la identidad técnica declarada;
- tupla inmutable `sourceId + storeOperation + eventId`;
- timestamps separados con origen y `trustedForAttribution:false`;
- copia defensiva e inmutable del payload técnico;
- procedencia autorizada por capacidad externa, conservando que medición física y atribución comercial siguen sin verificar;
- `eligibleForMeasurementMapping=true` solo para telemetría.

No contiene `clientId`, `fieldId`, `areaId`, `sensorId`, `physicalDeviceId`, `attributedAt`, ACK, transacción, retry ni configuración de persistencia. No es `TrustedMeasurementEvent` y no puede enviarse directamente a BE-12.

## Resultado `quarantined`

La salida de cuarentena expone solo `status` y un código cerrado:

- `unsupported-document`;
- `invalid-schema`;
- `missing-source`;
- `missing-event-id`;
- `missing-technical-identity`;
- `conflicting-identity`;
- `unverified-provenance`;
- `unsupported-operation`;
- `invalid-timestamp`;
- `invalid-payload`;
- `internal-error`.

No incluye payload, identificadores, errores de bibliotecas, credenciales ni diagnósticos privados.

## Operaciones

- `measurement + telemetry` → `measurement-candidate`.
- `device-status + device-status|connected|disconnected` → `technical-event-candidate`, nunca medición.
- Cualquier combinación diferente → `unsupported-operation`.

## Temporalidad y payload

`deviceTimestamp`, `sentAt`, `_receivedAt` y `persistedAt?` permanecen separados. No se usa `Date.now()`, no se crea `attributedAt` y ningún reloj se eleva a autoridad empresarial. Cero, `null` y ausencia permanecen diferentes; no se normalizan magnitudes ni unidades.

## Idempotencia

El mapper conserva la tupla técnica pero no compara digests, no entrega ACK, no persiste y no afirma exactly-once. Replay, retry y transacciones siguen siendo responsabilidad de `iot-ingest`.
