# BE13-11B — Auditoría de seguridad del Durable Broker Inbox

## Alcance

Store del inbox, modelo y validator, admisión durable, recuperación y replay desde registros, receipt, audit, métricas, alertas, readiness y placeholders. Evidencia:

- 37 pruebas offline;
- campaña Mongo real 27/27 × 2, con majority caída y failover;
- 6 mutantes detectados;
- regresiones de BE13-11A y BE13-10B.

## H1: **CLOSED**

`rawPersistedAt` sale exclusivamente del inbox durable. El boundary no lo acepta como dato declarado. Hay E2E aceptado desde un receipt real y crash recovery, incluso con failover. Si la persistencia falla, no se procesa nada. La campaña Mongo pasa.

## Modelo de confianza

- **El inbox es la autoridad del instante persistido:** lo asigna el servidor (`$$NOW`) y el receipt solo existe con ack majority + j.
- **El registro es la única entrada de la recuperación.** La integridad (sha, contexto y procedencia) se recomputa siempre.
- **Los fingerprints no son MAC.** Detectan corrupción o manipulación parcial, no a quien pueda reescribir un registro completo de forma consistente. Contra eso hacen falta control de cuentas de la base de datos o WORM (decisión pendiente). No hay criptografía inventada.
- **Límite:** código hostil dentro del proceso o con acceso a la base de datos queda fuera del alcance.

## Hallazgos

| ID | Severidad | Estado |
| --- | --- | --- |
| N1 Desfase de reloj entre el adapter y el servidor | MEDIO | Fail-closed (`invalid-timestamp`); la decisión sobre el reloj está pendiente |
| N2 `admitForReplay` sin recomputar la procedencia | MEDIO | CORREGIDO |
| N4 Registro huérfano tras una escritura no confirmada | MEDIO | Residual documentado; no se procesa; reconciliación pendiente |
| R1 Fingerprints sin MAC | INFORMATIVO | ACEPTADO / documentado |
| R2 Sin revalidar ni revocar la procedencia al recuperar | BAJO | Decisión pendiente |
| R3 El payload crudo puede contener datos sensibles | MEDIO | Retención y clasificación pendientes antes de Production |

Sin hallazgos ALTOS ni CRÍTICOS abiertos.

## Escaneo de secretos (manual)

En el diff contra `dev` se buscaron, sin imprimir valores:

- `password`, `token`, JWT (`eyJ…`) y claves privadas;
- credenciales de broker (`mqtt(s)://usuario:…@`), `x-emqx-key`;
- `mongodb+srv` y `mongodb.net`.

Resultado:

- Solo aparecen marcadores sintéticos de prueba (`pw-SYNTHETIC-NOT-A-SECRET-456`) y campos rechazados a propósito en pruebas del validator (`password: 'x'`, `x-emqx-key`).
- Aparecen menciones en la documentación.
- No hay ningún secreto ni cadena de conexión.

## Runtime

- Sin EMQX ni dependencia MQTT.
- Sin worker, cron, polling, TTL ni borrado.
- `app.ts` sin cambios.
- HTTP 13/13.
- `productionReady` es el literal `false`.

> **Actualización BE13-11C:** N4 cerrado por reconciliación manual con claim CAS y fencing (ver `INFORME_BE13_11C_AUDITORIA_SEGURIDAD.md`).
