# BE-13A — Contrato de identidades técnicas y empresariales

## Principio

Una identidad técnica localiza una conexión o dispositivo dentro de una fuente. No concede propiedad empresarial. La propiedad de una medición se obtiene únicamente de una asociación temporal persistida y verificada.

## Identidades

| Nombre | Significado | Autoridad actual | Puede seleccionar cliente |
|---|---|---|---|
| `mqtt-clientid` / `clientid` | identificador técnico de conexión MQTT | legacy: declarado; protegido: debe venir del contexto EMQX, aún no verificado externamente | NO |
| `device-id` | identificador técnico alternativo de hardware | pendiente de fuente y unicidad aprobadas | NO |
| `sourceId` | namespace técnico del origen/broker | configuración del servicio protegido (`config.ts:1-15`) | NO |
| `TechnicalDeviceKey` | `{kind: mqtt-clientid|device-id, value}` | contrato BE-11 (`association.contracts.ts:3`) | NO |
| `physicalDeviceId` | ID estable del registro físico BE-11 | catálogo backend verificado | NO por sí solo |
| `sensorId` | sensor lógico del dominio | BE-11, ligado temporalmente a área y dispositivo | dentro de un snapshot autorizado |
| `clientId` | entidad empresarial | sesión/catálogo y ventana histórica BE-11 | SÍ, solo internamente |
| `eventId` | identidad de entrega/reintento técnico | origen EMQX/servicio pendiente de validación | NO |
| topic MQTT | ruta declarada por broker | contexto operativo pendiente | NO |

## Resolución propuesta

1. El adapter de ingesta fija `sourceId`; el request no lo elige.
2. Obtiene la clave técnica solo de contexto autenticado del broker. Payload y topic se preservan, pero no autorizan.
3. BE-11 busca exactamente `sourceId + kind + value`, con máximo dos resultados.
4. Cero resultados: cuarentena `unknown-device`; más de uno: `ambiguous-device`.
5. El dispositivo debe estar `active` y `verified` por una autoridad aprobada.
6. Una política temporal independiente selecciona el instante atribuible.
7. BE-11/12 busca una única ventana `[validFrom, validTo)` del dispositivo.
8. La ventana aporta `clientId`, `fieldId`, `areaId`, `sensorId`, asociación y revisión.
9. Esa jerarquía se copia como snapshot inmutable; una reasignación posterior no modifica históricos.

## Reglas obligatorias

- `mqtt-clientid !== clientId` empresarial.
- `device_id` del frontend no debe mezclar sensor lógico y dispositivo físico.
- Topic, payload, email, query y headers públicos no seleccionan tenant.
- El cliente B nunca hereda mediciones históricas del cliente A al recibir un dispositivo.
- Un evento tardío usa la ventana del instante autoritativo, no la asociación actual.
- Si el reloj no es confiable, el evento queda en cuarentena; no se usa `_receivedAt` como sustituto silencioso.
- `physicalMeasurementVerified=false` y `commercialAttribution=false` permanecen falsas hasta que BE-11/12 las establezcan mediante autoridades distintas.
- IDs duplicados, ventanas solapadas, outputs incompletos y adaptadores fallidos deben fallar cerrados.

## Contrato candidato de frontera, no aprobado

El adapter futuro puede recibir un documento técnico protegido con:

```text
sourceId, eventId, technicalClientId, receivedAt,
brokerDeclaredAt, deviceTimestamp, mqttContext, topic,
messageType, dataOriginDeclared, payload
```

Debe producir un candidato validado con:

```text
eventId, sourceId, device:{kind,value}, receivedAt,
declaredAt|null, persistedAt, rawPayload, provenanceEvidence
```

Todavía no puede producir `TrustedMeasurementEvent` completo porque faltan reglas aprobadas para extraer magnitud/unidad/valor, procedencia física y reloj. La implementación inicial debe devolver un resultado discriminado `candidate | quarantined`, sin inventar esos campos.

## Evidencia requerida para aprobación

- Fixtures sanitizados de EMQX para telemetría, estado, conexión, desconexión y reintento.
- Versión/edición EMQX, autenticador, ACL y origen real de `clientid`.
- Política de unicidad y rotación de IDs del hardware.
- Garantía de `eventId` estable entre retries HTTP.
- Precisión, zona, deriva y autoridad de `sentAt`/timestamp del dispositivo.
- Catálogo físico de dispositivo ↔ sensor lógico y proceso de alta/descomisionamiento.
- Mapeo Atlas observado, no inferido.
