# BE13-11A — Auditoría de seguridad de la frontera de procedencia

## Alcance

Contratos de procedencia e identidad de broker, parser, boundary, clasificación, audit, métricas, alertas, readiness y placeholders. Evidencia:

- 38 pruebas offline;
- E2E en Mongo real, 13/13 × 2;
- 6 mutantes detectados;
- regresión de BE13-10B.

## Modelo de confianza

- **De confianza (inyectado y pendiente de aprobación):** el adapter (los hechos observados), el `BrokerProvenanceVerifier` (autenticación de la entrega) y el `BrokerIdentityMapping` (autorización y fuente de identidad).
- **Nunca de confianza:** todo lo que controla el dispositivo (payload, topic, client id declarado, metadata).
- **Única puerta al pipeline:** la evidencia emitida por el boundary.
- **Límite:** quien compone el runtime puede armar otro bootstrap. La frontera protege el camino del broker, no al proceso de sí mismo.

## Hallazgos

| ID | Severidad | Estado |
| --- | --- | --- |
| H1 BE13-04 exige un instante persistido; un consumer directo no lo tiene | MEDIO | MITIGADO (`rawPersistedAt` opcional; sin él, bloqueo fail-closed). La decisión de inbox durable está pendiente |
| H2 Colisión de `measurementId` en el doble de persistencia | BAJO | CORREGIDO |
| H3 Inundación de la cuarentena con entregas no autenticadas | INFORMATIVO | EVITADO por diseño |
| R1 TOCTOU de procedencia antes de persistir | BAJO | ACEPTADO / documentado |
| R2 Adapter comprometido | INFORMATIVO | ACEPTADO: depende de la decisión de autenticación |
| R3 Contención del stream `realm` del audit con alto volumen | BAJO | ACEPTADO: volumen pendiente de decisión |

Sin hallazgos ALTOS ni CRÍTICOS abiertos.

## Escaneo de secretos (manual)

En el diff contra `dev` se buscaron, sin imprimir valores:

- contraseñas, JWT (`eyJ…`) y claves privadas;
- credenciales MQTT (`mqtt://` o `mqtts://` con usuario);
- `x-emqx-key`, `mongodb+srv` y `mongodb.net`;
- URLs de broker reales.

Resultado:

- Solo aparece la cadena sintética `pw-SYNTHETIC-NOT-A-SECRET-123`, usada para comprobar que no se filtra.
- Aparecen tokens de prueba `tok-*` y menciones en la documentación.
- No hay ningún secreto ni URL real.

## Runtime

- Sin cliente MQTT ni SDK de EMQX (lo verifica A16 sobre `package.json`).
- Sin conexión ni suscripción.
- Sin endpoints ni workers.
- `app.ts` sin cambios.
- HTTP 13/13.
- `productionReady` es el literal `false`.
