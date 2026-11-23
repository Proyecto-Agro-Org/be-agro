# Contrato BE-11 → IoT / BE-12

## Propósito

Este contrato define la frontera para resolver una identidad técnica recibida por ingesta contra el catálogo BE-11 sin permitir que el payload elija cliente, campo, área o sensor.

## Entrada confiable mínima propuesta

La integración futura deberá entregar desde un adapter autenticado:

- `sourceId`: namespace del emisor/adaptador.
- `device`: `TechnicalDeviceKey` exacta.
- evidencia de emisor EMQX autorizado;
- evidencia de dispositivo autenticado por broker, separada de la anterior;
- `receivedAt`: timestamp del backend/ingesta;
- `declaredAt`: timestamp declarado o `null`;
- `eventId` y tipo de evento;
- marca `simulated` explícita;
- referencia inmutable al payload almacenado, no campos de propiedad confiados.

## Resolución requerida

1. Buscar identidad exacta por `sourceId + kind + value`; cero o múltiples resultados se rechazan.
2. Exigir dispositivo activo y verificado por una autoridad aprobada.
3. Determinar el tiempo de atribución según política de reloj aprobada.
4. Resolver una única asociación cuya ventana `[validFrom, validTo)` contenga ese tiempo.
5. Resolver el cliente/campo/área/sensor exclusivamente desde esa asociación persistida.
6. Revalidar revisión y sesión antes de publicar el resultado, siguiendo el planner existente de telemetría.
7. Cuarentenar datos tardíos, ambiguos, sin procedencia o fuera de ventana; no elegir “el primero”.

## Salida propuesta

```ts
type AttributionResult =
  | { status: 'verified'; clientId: string; fieldId: string; areaId: string; sensorId: string; associationId: string; associationRevision: number }
  | { status: 'quarantined'; reason: 'unknown-device' | 'unverified-device' | 'ambiguous-device' | 'no-window' | 'overlap' | 'untrusted-clock' | 'untrusted-source' };
```

Los códigos son una propuesta de integración interna, no un contrato HTTP aprobado.

## Prohibiciones

- `clientid` MQTT no se interpreta como `clientId` empresarial.
- Topic, payload, headers públicos o `device_id` declarado no prueban propiedad.
- El timestamp del dispositivo no reemplaza automáticamente a `receivedAt`.
- No se recalcula historia con la asociación vigente.
- No se escriben mediciones verificadas si la atribución no es única.

## IMPLEMENTADO

- Separación `sourceId`, `TechnicalDeviceKey`, ID interno y cliente.
- Identidad técnica única, estado de verificación y asociaciones versionadas.
- Planner previo que exige fuente autenticada, atribución temporal y revalidación.

## PENDIENTE

- Adapter entre iot-ingest y BE-11.
- Esquema final de eventos/mediciones y `eventId`.
- Política de `receivedAt`/`declaredAt`, tolerancia y precisión.
- Mapeo real de colecciones e índices de ingesta.

## BLOQUEADO

- EMQX real y credenciales.
- Atlas real.
- Activación de telemetría comercial.
- Atribución automática mientras no se aprueben procedencia, reloj y mapeo físico.
