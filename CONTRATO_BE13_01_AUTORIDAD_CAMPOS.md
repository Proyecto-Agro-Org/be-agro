# BE13-01 — Autoridad de campos

## Matriz de autoridad

| Campo | Generador esperado | Transmisor/modificadores | Autenticación observable | Identificación técnica | Atribución empresarial | Faltante |
|---|---|---|---|---|---|---|
| `sourceId` | configuración de iot-ingest protegido | operador del servicio | validación local de config | sí, como namespace | no | gobernanza y valor real por broker |
| `mqtt-clientid` / `clientid` | conexión MQTT, pero fixtures lo declaran | EMQX/bridge; payload en legacy | no verificada externamente | condicional | nunca | autenticador, ACL y origen del campo |
| `device-id` | hardware/catálogo pendiente | origen/adapter | ninguna demostrada | pendiente | nunca | unicidad y lifecycle |
| `TechnicalDeviceKey` | adapter backend | código confiable | depende de source/clientid | sí | no | mapper BE13-02 |
| `physicalDeviceId` | catálogo BE-11 | backend administrativo | catálogo/índices BE-11 | sí | no por sí solo | mapping técnico real |
| `sensorId` | dominio BE-11 | backend administrativo | asociación temporal | sensor lógico | solo dentro de ventana |
| `clientId` | catálogo/sesión y ventana BE-11 | backend | sesión y persistencia | no | sí | adapter Atlas definitivo |
| `eventId` | EMQX/origen pendiente | bridge/retry | solo forma; origen no verificado | evento técnico | no | estabilidad real por retry/tipo |
| `topic` | broker | regla/bridge | contexto real no inspeccionado | metadata auxiliar | no | fixture EMQX real |
| `sentAt` | broker/servicio propuesto | bridge | ventana local, origen no probado | frescura técnica | no | reloj/precisión reales |
| `deviceTimestamp` | hardware/payload | hardware/bridge | no | metadata declarada | no | formato, zona, deriva |
| `_receivedAt` | iot-ingest | servicio | reloj servidor | recepción | no | sincronización/precisión operativa |
| magnitud/unidad | payload + catálogo futuro | dispositivo/adapter | sin catálogo actual | dato técnico | no hasta validación | aprobación BE-04/IoT/Agronomía |
| `x-emqx-key` | operación/seguridad | EMQX bridge | comparación constant-time | autentica servicio | no autentica hardware/cliente | secretos, rotación, TLS y red reales |

## Reglas de consumo

1. Campos del payload son datos, no autoridad.
2. `x-emqx-key` prueba posesión de una clave del servicio, no autenticidad del dispositivo declarado.
3. `sourceId + TechnicalDeviceKey` resuelve como máximo un dispositivo físico.
4. Cliente, campo, área y sensor provienen exclusivamente de una ventana BE-11 válida.
5. `receivedAt` no reemplaza automáticamente la fecha de adquisición.
6. Topic, email, query y headers públicos no seleccionan cliente.
7. La procedencia `physical-unverified` continúa no verificada.
8. Un campo sin autoridad suficiente produce cuarentena o resultado bloqueado, nunca un valor inventado.

## Frontera para BE13-02

BE13-02 puede aceptar como entrada un documento técnico protegido ya persistido. Debe verificar forma y procedencia, separar tiempos y construir solamente:

```text
candidate {
  eventId,
  sourceId,
  technicalDeviceKey,
  receivedAt,
  declaredTimes,
  rawPayload,
  evidence
}
```

Debe devolver `quarantined` si falta identidad, hay contradicción, el documento es legacy, la procedencia es insuficiente o el tiempo no puede representarse. No debe producir cliente, sensor, magnitud normalizada ni `TrustedMeasurementEvent` positivo.
