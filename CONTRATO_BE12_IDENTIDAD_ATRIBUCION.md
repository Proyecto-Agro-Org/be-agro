# Contrato BE-12 — Identidad y atribución temporal

## Entrada confiable

`TrustedMeasurementEvent` contiene `eventId`, `sourceId`, `TechnicalDeviceKey`, recepción, timestamp declarado opcional, persistencia, magnitud, unidad, valor, procedencia, marca simulada y metadata acotada. Es la salida validada de un adapter confiable futuro; no autoriza por sí misma un cliente.

Se prohíben `clientId`, campo, área, sensor, flags de confianza y operadores MongoDB en esa entrada.

## Resolución

1. Buscar exactamente `sourceId + kind + value`, con límite dos.
2. Cero coincidencias: `unknown-device`; más de una o una forma contradictoria: `ambiguous-device`.
3. Exigir dispositivo `active` y `verified`.
4. Solicitar a `TemporalPolicy` un instante confiable. La política conservadora incluida siempre rechaza hasta que exista una autoridad aprobada; `receivedAt` conserva su valor de recepción, pero no prueba adquisición.
5. Validar magnitud/unidad/procedencia mediante catálogo inyectado.
6. Buscar como máximo dos ventanas del dispositivo que contengan el instante.
7. Exigir una única ventana `[validFrom, validTo)` y copiar su snapshot empresarial.

El resultado es `verified` o `quarantined`. No se selecciona el primer resultado, no se infiere propietario y no se usa la asociación vigente para eventos antiguos.

## Modelo lógico

Una medición atribuida conserva IDs de evento/medición, realm, cliente, campo, área, sensor lógico, dispositivo físico, asociación y revisión, magnitud/unidad, valor y causa de ausencia, procedencia y cuatro tiempos: declarado, recibido, persistido y atribuido.

`null` exige causa; cero no es ausencia. `simulated=true` exige procedencia `simulated` y viceversa. Ningún nombre físico de colección Atlas queda aprobado por este contrato.

## Errores y cuarentena

Entradas públicas mal formadas producen `VALIDATION_ERROR`; fallos de adapters producen `DEPENDENCY_UNAVAILABLE` sin diagnóstico privado. La falta de evidencia de negocio produce cuarentena controlada y nunca una atribución parcial.
