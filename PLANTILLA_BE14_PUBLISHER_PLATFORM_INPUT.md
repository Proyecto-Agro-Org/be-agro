# PLANTILLA — Entrada de producto/hardware para elegir la plataforma del publisher (BE14-05)

Completar por producto/hardware. **Ningún campo viene rellenado ni sugerido por ingeniería.** Un campo vacío es una decisión pendiente, no un valor por defecto. Se usa con `ESPECIFICACION_BE14_FUTURE_PUBLISHER_REQUIREMENTS.md` §17 y su cálculo de capacidad (`node dist/scripts/be14-05/capacity.js '<json>'`).

## A. Entrada del producto
| Campo | Valor | Quién decide |
|---|---|---|
| Plataforma candidata (nombre/familia) | | hardware/producto |
| Conectividad (Wi-Fi / LTE / LoRa / otra) | | producto |
| Sensores e interfaces | | hardware |
| Frecuencia de muestreo | | producto |
| Eventos por día (`eventsPerDay`) | | producto |
| Tamaño medio / máximo de payload (bytes) | | producto |
| **SLA offline** (días máximos sin red, `offlineDays`) | | producto |
| Fuente de energía y presupuesto | | hardware |
| Almacenamiento disponible para el outbox | | hardware |
| Overhead de metadatos por registro (`metadataOverheadBytes`) | | firmware (tras elegir D10) |
| Factor de seguridad (`safetyFactor` ≥ 1) | | producto/firmware |
| Vida útil esperada del dispositivo | | producto |
| Restricciones ambientales | | hardware |
| Requisito de seguridad | | producto/seguridad |
| Mecanismo de auth MQTT / HTTP (ver §10 de la especificación) | | producto/seguridad |
| Almacenamiento de credenciales / rotación / revocación | | seguridad |
| OTA (sí/no, frecuencia) | | producto |
| Expectativa de reintentos (valores fast/slow) | | producto |
| Comportamiento al saturar el outbox | | producto |
| Owner de `UNCONFIRMED_EXPLICIT` (rol, plazo) | | operación |
| Restricción de costo | | producto |

## B. Cálculo (rellenar con los datos de A)
`requiredBytes = eventsPerDay × offlineDays × (avgPayloadBytes + metadataOverheadBytes) × safetyFactor` · registros = `eventsPerDay × offlineDays × safetyFactor`.
Red: `bytesPorEvento = (publishOverheadBytes + avgPayloadBytes + reconciliationOverheadBytes) × (1 + retryFactor)`.

## C. Matriz de comparación de plataformas (una columna por candidata; sin candidatas inventadas)
| Criterio | Candidata 1 | Candidata 2 | Candidata 3 |
|---|---|---|---|
| Plataforma | | | |
| Almacenamiento persistente | | | |
| Opciones de escritura atómica | | | |
| Resistencia de flash / wear-leveling | | | |
| Comportamiento ante corte de energía | | | |
| Criptografía (SHA-256 hw/sw, almacén seguro) | | | |
| TLS | | | |
| Librería MQTT (v3.1.1/v5, QoS 1, clientId fijo) | | | |
| Cliente HTTP | | | |
| OTA | | | |
| Memoria RAM | | | |
| Flash | | | |
| Energía | | | |
| Watchdog | | | |
| Herramientas de desarrollo | | | |
| **Factibilidad del puente de conformidad** (stdio / simulador / capacidades `crash-injection`, `clock-control`, `capacity-config`, `policy-config`, `outbox-corruption`) | | | |

## D. Criterio de salida
Se puede abrir FW-01 cuando D1 y D10 de la especificación pasan de `PENDING` a decididas por una persona con autoridad. Este documento no marca ninguna decisión como `DECIDED`.
