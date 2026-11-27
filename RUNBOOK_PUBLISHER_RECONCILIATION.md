# RUNBOOK — Publisher y reconciliación (BE14-01, referencia)

Alcance: operación **local / `TEST_ONLY`**. Nada de esto está aprobado para producción.

## Configuración (todo fail-closed por defecto)
| Elemento | Default | Para pruebas locales |
|---|---|---|
| política del outbox (carriles, capacidad) | `BLOCKED` (el publisher no arranca) | `OutboxPolicy` `TEST_ONLY` explícita |
| auth de reconciliación | `BLOCKED_RECONCILIATION_AUTH` (toda consulta = `no-answer: auth-blocked`) | `createTestOnlyAuth('<principal sintético>')` |
| endpoint | no compuesto en `app.ts` | router `TEST_ONLY` de BE13-11M en un servidor de prueba |
| almacén | — | memoria o archivo atómico (`createFileStore`) |
| credenciales MQTT | nunca en el código | inyectadas por el arnés (secretos del laboratorio, generados por corrida) |

## Reglas operativas
- Un dispositivo = una identidad MQTT = una conexión; `clientId` = clave técnica. Si aparece `CLIENT_ID_COLLISION`, hay dos procesos con la misma identidad.
- El `eventId` nunca se edita ni se reutiliza para otro contenido. `REJECTED_EVENT_ID_REUSED_WITH_OTHER_BYTES` indica un bug del llamador.
- Toda lectura lleva `deviceTimestamp` (la referencia lo declara siempre); sin él el pipeline la cuarentena.

## Diagnóstico por estado del outbox
| Estado / señal | Qué significa | Acción |
|---|---|---|
| `BROKER_ACCEPTED` persistente | PUBACK sin consulta aún (espera o 429) | normal; revisar `nextAttemptAt` |
| `RETRY_REQUIRED` / `publish_attempts` creciendo | el backend no tiene el evento (`not-found`/`pending`) o no responde | revisar broker y API; el evento se republica solo |
| `no_answer` alto | API caída, auth denegada/bloqueada, respuesta malformada | revisar endpoint/auth; no hay pérdida (el evento sigue en el outbox) |
| `unconfirmed` > 0 / `lane=slow` | carril rápido agotado | alerta (umbral candidato, no aprobado) |
| `UNCONFIRMED_EXPLICIT` | carril lento agotado | **ownership humano pendiente**: investigar broker/backend; el evento sigue retenido |
| `CONFLICT_REQUIRES_REVIEW` | mismo `eventId` con otro contenido | no se republica; revisar el origen (outbox perdido / `eventId` reutilizado) |
| `QUARANTINED` | el backend lo retuvo | revisar la cuarentena en el backend (operación de BE13) |
| `REJECTED_OUTBOX_FULL` | outbox saturado | el llamador conserva la lectura; política de saturación pendiente de decisión humana |

## Restart / recuperación
Reiniciar el proceso: el outbox se reconstruye desde el almacén (`publisher_restart_recovered` = entradas no terminales). **No borrar el archivo del outbox**: perderlo reabre el riesgo de `eventId` reutilizado (conflicto) y de pérdida silenciosa.

## Qué NO hacer
No marcar éxito por PUBACK, por timeout ni por silencio; no regenerar `eventId`; no abrir una segunda conexión con el mismo `clientId`; no ignorar `Retry-After`; no modificar BE13 para acomodar un publisher incorrecto.
