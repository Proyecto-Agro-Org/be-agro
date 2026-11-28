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

La factory es una frontera entre módulos confiables del mismo proceso, no un autenticador externo: cualquier módulo con ejecución arbitraria dentro del backend pertenece al mismo dominio de confianza y podría crear otra authority. La composición productiva debe mantener el verifier fuera de entradas públicas y someter su implementación a revisión. Actualmente no existe verifier productivo.

## Resultado `candidate`

Un candidato contiene:

- `sourceId`, `storeOperation`, operación técnica y `eventId`;
- `device:{kind,value}` y la identidad técnica declarada;
- tupla inmutable `sourceId + storeOperation + eventId`;
- timestamps separados con origen y `trustedForAttribution:false`;
- copia defensiva e inmutable del payload técnico;
- identidad técnica autorizada por capacidad externa, `payloadIntegrity:'not-attested'` y broker conservado solo como declaración;
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

`deviceTimestamp`, `sentAt`, `_receivedAt` y `persistedAt?` permanecen separados. Si existe, `persistedAt` no puede ser anterior a recepción. No se usa `Date.now()`, no se crea `attributedAt` y ningún reloj se eleva a autoridad empresarial. Cero, `null` y ausencia permanecen diferentes; no se normalizan magnitudes ni unidades.

Telemetría exige el mismo topic no nulo, sin comodines y de hasta 1024 bytes que el schema protegido real. El payload crudo se valida antes de Zod para que claves peligrosas no puedan ser eliminadas silenciosamente. Los límites de profundidad 16 y presupuesto 10.000 reflejan el validador de `iot-ingest`; el límite HTTP de 1 MB pertenece a la frontera anterior y no se reinventa aquí.

## Idempotencia

El mapper conserva la tupla técnica pero no compara digests, no entrega ACK, no persiste y no afirma exactly-once. La capacidad puede reutilizarse para la misma tupla y no atesta los bytes del payload; esto se expresa en la salida mediante `payloadIntegrity:'not-attested'`. Replay, retry y transacciones siguen siendo responsabilidad de `iot-ingest`.

## Registro de candidates emitidos (agregado en BE13-03/BE13-03A)

El módulo `protected-ingest.mapper.ts` exporta además `isIssuedProtectedCandidate(value)`. Devuelve `true` solo para el objeto exacto devuelto por un `map()` exitoso de **esa instancia del módulo**; se implementa con un `WeakSet` privado (no hay forma exportada de registrar objetos, no retiene memoria).

- No altera el resultado de `map()`: mismas claves, mismos valores, mismo congelamiento. Las cuarentenas no se registran.
- Copias, clones, Proxy, objetos deserializados o candidates de otra instancia del módulo devuelven `false`. Un candidate que cruce una frontera de serialización (cola, worker, persistencia) pierde esa procedencia.
- Representa **solo procedencia dentro del mismo proceso**. No es autenticidad criptográfica, ni autenticación de hardware, ni de EMQX, ni protección frente a código hostil que ya ejecuta en el proceso (que puede crear su propia authority y su propio mapper).
