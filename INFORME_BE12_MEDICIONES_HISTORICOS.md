# BE-12 — Mediciones, atribución e históricos

## Resumen

BE-12 implementa un núcleo aislado para resolver identidades técnicas, atribuir eventos mediante ventanas históricas y consultar mediciones ya atribuidas con aislamiento empresarial. No agrega rutas a `app.ts`, no conecta Atlas/EMQX y no modifica `iot-ingest` ni frontend.

## IMPLEMENTADO

- Contratos tipados de evento, dispositivo, ventana, atribución, medición y paginación.
- Validación Zod estricta de entrada y salida de adapters.
- Resolución exacta `sourceId + TechnicalDeviceKey`, sin derivar `clientId` desde MQTT, topic o payload.
- Rechazo de identidad desconocida, duplicada, no verificada o inactiva.
- Ventanas semiabiertas `[validFrom, validTo)` y snapshot inmutable de cliente/campo/área/sensor/asociación.
- Política temporal inyectable y adapter conservador fail-closed: mientras no exista autoridad aprobada, tanto recepción como timestamp declarado quedan bloqueados para atribución. Las pruebas positivas usan una política sintética explícita.
- Catálogo de magnitud/unidad/procedencia como puerto confiable; no se hardcodean propuestas BE-04 como contratos aprobados.
- Valor finito o `null` con causa explícita; cero permanece válido.
- Procedencia separada: física, derivada, estimada, simulada, manual o laboratorio.
- Históricos por sensor, dispositivo físico, área y campo; última medición, rangos, límite 200, orden `attributedAt DESC, id DESC` y cursor determinista.
- Revalidación de sesión antes y después de la lectura; salida defectuosa o de otro tenant falla cerrada.
- Adapter provisional en memoria para validación local. No es seleccionable por entorno ni representa Atlas.
- DTOResponse y controllers aislados. No se creó router ni montaje público.
- Campaña MongoDB BE-12 preparada sobre el launcher seguro BE-11, con selección cerrada de runner.

## PROBADO

- Regresión completa: 415/415 pruebas offline y 13/13 escenarios HTTP equivalentes.
- Identidad válida/desconocida/duplicada.
- Dispositivo no verificado, inactivo y descomisionado.
- Asociación faltante, solapada y borde exacto `validTo`/`validFrom`.
- Timestamp no confiable, `clientId` inyectado, null, cero y dato simulado.
- Catálogo desconocido, fallos sanitizados y outputs corruptos.
- Paginación, latest, filtros por sensor/dispositivo/área/campo y aislamiento multicliente.
- Revocación durante lectura asíncrona.
- Revalidación de dispositivo y revisión/ventana antes de emitir la atribución.
- Rutas BE-12 ausentes de la aplicación pública.
- Sonda MongoDB sin autorización detenida antes de inspección Git o acceso a base.

## PENDIENTE

- Ejecutar la campaña MongoDB real BE-12 desde Windows después del commit local.
- Aprobar catálogo productivo de magnitud/unidad y transformaciones BE-04.
- Aprobar reloj autoritativo/tolerancia para eventos tardíos.
- Aprobar contrato físico y adapter Atlas.
- Acordar paths/statuses HTTP con FE/BE y actualizar OpenAPI antes de montar rutas.
- Aprobar autenticación de webhook, dispositivo y autoridad real de hardware.

## BLOQUEADO

- Persistencia o lectura en Atlas real.
- Integración EMQX/`iot-ingest` real.
- Activación pública de controllers.
- Reatribución de históricos sin evidencia temporal inequívoca.
- Normalización productiva de unidades propuestas.

## Seguridad y límites

El snapshot histórico de una medición no se recalcula con la asociación actual. Todo evento queda en cuarentena con la política incluida hasta aprobar autoridad temporal; una política futura deberá aportar evidencia independiente. El adapter de consulta recibe siempre `realm` y `clientId` derivados de sesión; los filtros públicos no admiten expresiones MongoDB. La campaña real propuesta usa datos sintéticos, namespaces descartables y un replica set de un nodo, por lo que no demuestra failover.
