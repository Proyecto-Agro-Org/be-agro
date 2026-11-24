# BE13-11A — Contrato de identidad de broker

## Puerto

```ts
interface BrokerIdentityMapping {
  resolve({ realm, principalReference }) → Promise<
    | { status: 'mapped'; realm; principalReference; sourceId; technicalDeviceKey: { kind: 'mqtt-clientid'; value }; mappingRevision }
    | { status: 'unknown'; realm }>
}
```

Responde a la pregunta "¿con qué identidad puede publicar este principal **autenticado**?". El origen de los datos queda pendiente de decisión humana: configuración, backend de autenticación del broker, registro de dispositivos u otro.

## Semántica de identidades

| Identidad | Origen | Nunca |
| --- | --- | --- |
| realm | `realmAuthority` del bootstrap | topic, payload, client id, metadata |
| principal | `authenticatedPrincipalReference` observado, confirmado por el verifier | payload, username declarado |
| `sourceId` | `BrokerIdentityMapping` (configuración o autorización) | payload (un `sourceId` declarado hace malformado el sobre) |
| clave técnica (`mqtt-clientid`) | `BrokerIdentityMapping`; debe coincidir con el `mqttClientId` observado | el `clientid` declarado se compara, nunca se eleva |
| `clientId` de negocio | asociación BE-12 (`client-A` en las pruebas) | `mqttClientId`, payload, topic |

## Reglas

- `mapped` para otro realm → `broker-realm-mismatch`.
- `unknown` → `broker-principal-unknown`.
- Otro principal → `broker-context-mismatch`.
- Respuesta malformada → `invalid-authority-response`.
- Excepción o timeout → `broker-verifier-unavailable`.
- `observed.mqttClientId !== clave autorizada` → `technical-identity-mismatch`: la conexión usa una clave que su principal no tiene autorizada.
- El `clientid` declarado o un alias en el payload (`clientid`, `client_id`) distinto de la clave autorizada → `technical-identity-mismatch`. Se rechaza en el boundary, sin cuarentena, con audit y la alerta `TECHNICAL_IDENTITY_MISMATCH`.
- Las claves del payload siguen la forma de campo `^[a-z][a-z0-9_]{0,63}$`. Las variantes en camelCase hacen malformado el sobre.

## Placeholder

`createBlockingMqttBoundaryPlaceholders().brokerIdentityMapping` responde siempre `unknown`.
