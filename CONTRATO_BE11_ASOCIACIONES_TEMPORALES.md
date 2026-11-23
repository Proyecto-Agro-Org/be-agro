# Contrato BE-11 — Asociaciones temporales

## Identidades

| Concepto | Identificador | Regla |
|---|---|---|
| Cliente empresarial | `clientId` | Derivado de sesión autorizada; nunca de body, query, topic o payload. |
| Sensor lógico | `sensorId` | UUID opaco estable generado por backend. |
| Dispositivo físico | `physicalDeviceId` | UUID interno; no equivale a una clave MQTT. |
| Clave técnica | `TechnicalDeviceKey` | `{ kind: mqtt-clientid | device-id, value }`; ambos tipos son distintos. |
| Evento | pendiente BE-12 | No se reutiliza como identidad de dispositivo ni medición. |

## Ventanas

Todas las ventanas son semiabiertas: `[validFrom, validTo)`. `validTo = null` representa una ventana abierta. Debe cumplirse `validFrom < validTo` cuando existe cierre.

La asociación sensor-dispositivo conserva una instantánea de `fieldId` y `areaId`. La propiedad histórica se resuelve con la ventana que contiene el tiempo atribuible; nunca con la relación actual.

## Operaciones internas implementadas

1. Registrar sensor y abrir su primera asignación sensor-área.
2. Registrar dispositivo con verificación externa confiable.
3. Abrir asociación para un dispositivo verificado y sensor activo.
4. Cerrar una asociación con CAS.
5. Reasignar dispositivo: cerrar la asociación vigente y abrir otra de manera atómica.
6. Reasignar sensor a un área: cerrar y abrir asignaciones de área con CAS, solo sin dispositivo abierto.
7. Consultar historiales completos por sensor.
8. Desactivar o descomisionar sin borrado físico.

## Invariantes

- No hay asociaciones entre clientes diferentes.
- Campo y área deben existir, estar activos y pertenecer al cliente derivado de la sesión.
- Un mismo dispositivo físico no puede tener ventanas solapadas, incluso entre sensores o clientes.
- Un sensor puede tener más de un dispositivo diferente mientras la cardinalidad definitiva siga pendiente; no se crea un índice irreversible que prohíba esa alternativa.
- Las reasignaciones no se ejecutan mediante PATCH genérico.
- Un recurso descomisionado no recibe asociaciones nuevas ni se reactiva.
- CAS usa `version` en sensores/dispositivos y `revision` en asociaciones/asignaciones.
- El motivo de auditoría es texto acotado y seguro; no admite secretos, credenciales ni objetos arbitrarios.

## Concurrencia

Todas las escrituras del cliente toman la misma fila de coordinación que BE-10 dentro de una transacción MongoDB. Esto serializa:

- apertura/cierre/reasignación;
- creación/descomisionamiento;
- inspección de dependencias y baja de área/campo.

Los índices únicos protegen IDs e identidad técnica. El control de intervalos se vuelve a ejecutar dentro de la transacción. Un error de evidencia o índice produce `DEPENDENCY_UNAVAILABLE`; nunca se interpreta como ausencia de dependencias.

## Estados

- `active`: admite operaciones compatibles.
- `inactive`: no admite asociaciones nuevas; puede pasar a descomisionado.
- `decommissioned`: terminal para este alcance.

No se implementa reactivación. Estados adicionales (mantenimiento, extraviado, cuarentena física) requieren aprobación funcional.

## Contrato HTTP

Los DTOResponse y esquemas preparatorios están implementados, pero **no hay rutas HTTP aprobadas ni montadas**. Los paths, métodos, statuses de éxito y OpenAPI deben cerrarse con FE/BE antes de exponer el módulo. Los errores internos reutilizan el catálogo seguro existente (`400`, `404`, `409`, `503`).

## Decisiones pendientes

- Cardinalidad máxima de dispositivos distintos por sensor.
- Autoridad de reloj para operaciones administrativas y atribución de telemetría.
- Autoridad real de verificación del dispositivo.
- Naming/mapeo físico de Atlas.
- Política aprobada para reactivar recursos inactivos (no descomisionados).
