# BE13-02 — Implementación del mapper IoT seguro

## Resumen

Se implementó un mapper puro, síncrono, determinista y fail-closed para documentos del store protegido de `iot-ingest`. Produce únicamente `candidate | quarantined`; no crea `TrustedMeasurementEvent`, no atribuye clientes y no tiene I/O.

## Arquitectura

- `protected-ingest.contracts.ts`: contratos cerrados de entrada lógica, candidato, cuarentena y autoridad.
- `protected-ingest.schemas.ts`: forma estricta del documento técnico persistido.
- `ingest-provenance.authority.ts`: frontera nominal con capacidades opacas guardadas en `WeakMap`.
- `protected-ingest.mapper.ts`: clasificación, validación, copia defensiva y mapeo.

No se agregó composición en `app.ts`, dependencias, rutas, adapters de MongoDB ni configuración. La autoridad productiva deliberadamente no existe: un integrador futuro deberá verificar evidencia externa y emitir una capacidad vinculada al evento esperado.

## Seguridad y confianza

El schema demuestra forma, no origen. La capacidad externa se valida contra fuente, operación, evento y dispositivo; objetos copiados o flags del payload no funcionan. La salida distingue autorización de identidad técnica de integridad del payload, que permanece explícitamente no atestada. El mapper rechaza contradicciones entre documento, procedencia y aliases de identidad. Las excepciones se reducen a códigos controlados.

La identidad MQTT permanece técnica. No se generan IDs empresariales ni se consulta BE-11. `x-emqx-key` autenticaría al servicio EMQX, no al hardware, y no aparece como entrada aceptada por el mapper.

## Temporalidad y datos

Los cuatro tiempos se conservan por separado y marcados como no confiables para atribución. No se usa el reloj del proceso. El payload se copia recursivamente con límites de profundidad/presupuesto, rechazo de claves peligrosas y congelación de estructuras. No se normalizan valores, magnitudes ni unidades.

## Operaciones e idempotencia

Telemetría puede ser candidata de medición. Estado, conexión y desconexión son candidatos técnicos explícitamente no medibles. La tupla `sourceId + storeOperation + eventId` se conserva, pero digest, ACK, retry, transacción y deduplicación permanecen en `iot-ingest`.

## Compatibilidad

BE-12 permanece sin cambios. El candidato aporta parte de los datos técnicos, pero faltan autoridad temporal, catálogo, semántica de ausencia, procedencia BE-12 y metadata permitida. Por eso no puede construirse automáticamente `TrustedMeasurementEvent`.

## Validaciones

Resultados finales:

- `npm.cmd ci --offline`: aprobado; 120 paquetes restaurados desde lockfile y 0 vulnerabilidades informadas.
- Typecheck: aprobado.
- Build: aprobado.
- Suite funcional BE13-02: 37 casos.
- Suite adversarial BE13-02A: 27 casos.
- Suite completa: 489/489 pruebas aprobadas.
- Regresión HTTP: 13/13 escenarios equivalentes.
- `git diff --check`: aprobado.

## Estado

- IMPLEMENTADO: contratos, schema, frontera de autoridad, mapper y pruebas.
- PROBADO: mapper, autoridad, fixtures, regresión completa y equivalencia HTTP.
- PENDIENTE: verifier productivo, catálogo/extractor y política temporal.
- BLOQUEADO: activación EMQX, Atlas, atribución empresarial y endpoints.

## Limitaciones y siguiente paso

Los fixtures son 12 sintéticos y 2 observados en código; no son capturas EMQX. El siguiente paso recomendado es auditar esta implementación y obtener evidencia sanitizada de EMQX antes de diseñar el mapper positivo hacia BE-12. No debe montarse ninguna ruta ni conexión durante esa revisión.
