# BE-12 — Validación final

## Resumen ejecutivo

BE-12 queda técnicamente validado para integración en `dev` como infraestructura aislada y deshabilitada públicamente. El código funcional probado corresponde a `dc39a89f2734772bf6dd76a880b11504a28cb726`. La documentación de cierre no modifica dicho código ni requiere repetir la campaña MongoDB.

## IMPLEMENTADO

- Resolución exacta de identidad técnica sin inferir cliente desde MQTT, topic o payload.
- Atribución mediante ventanas semiabiertas `[validFrom, validTo)` y snapshot histórico inmutable.
- Históricos por sensor, dispositivo físico, área y campo, con rango, límite, cursor y orden `attributedAt DESC, id DESC`.
- Aislamiento por `realm` y `clientId` derivados de una sesión autorizada; no se acepta selección pública de tenant.
- Revalidación de sesión y de la asociación antes de entregar resultados.
- Estados de cuarentena y validación explícita de magnitud, unidad, ausencia y procedencia.
- Adapter provisional local, controllers y DTOs aislados, sin montaje en la aplicación pública.

## PROBADO

- MongoDB 8.0.38, topología `single-node-replica-set`, run `61ac51716d554ee1b489d8c4`.
- R01–R10: 10 aprobadas, 0 fallidas, para el SHA funcional probado.
- Índices comprobados: `measurement_id_unique`, `measurement_event_unique`, `measurement_sensor_history`, `measurement_device_history` y `measurement_area_history`.
- R04 conserva `{ realm, clientId, physicalDeviceId }` y ordena por `{ attributedAt: -1, id: -1 }`.
- Transferencias A→B→A, límites temporales, eventos tardíos, duplicados, paginación y concurrencia de lecturas sin filtraciones entre clientes.
- Regresión offline: 417/417.
- Regresión HTTP: 13/13 escenarios equivalentes; `/health` continúa público.
- BE-10, BE-11 y BE-12 continúan sin rutas públicas en `app.ts`.

La evidencia de ejecución es local, está excluida por `.gitignore` y no se incorpora al repositorio.

## BLOQUEADO

- Política temporal productiva y tolerancia para datos tardíos.
- Catálogo productivo de magnitudes, unidades, transformaciones y calibraciones.
- Adapter y mapeo físico definitivo de Atlas.
- Integración real con EMQX, `iot-ingest` y hardware verificado.
- Montaje público de rutas y actualización coordinada de OpenAPI/contratos FE.

## PENDIENTE

- Aprobar autoridad de timestamps de adquisición y recepción.
- Aprobar el catálogo de variables y el contrato de latest para magnitudes parciales.
- Confirmar colecciones, tipos BSON e índices definitivos en Atlas mediante acceso autorizado.
- Acordar paths, estados HTTP, cursores y DTO públicos con frontend.
- Ejecutar Preview controlado únicamente cuando sus variables estén aisladas de Production.

## Alcance de la evidencia

La campaña usa una base descartable, datos sintéticos y un replica set local de un solo nodo. Demuestra comportamiento real de consultas, índices y unicidad en MongoDB 8.0.38, pero no demuestra failover, disponibilidad distribuida, compatibilidad física con Atlas, integración EMQX, autoridad del hardware ni seguridad de un despliegue productivo.

La integración en `dev` no habilita autenticación productiva, endpoints de negocio, conexiones automáticas a Atlas ni promoción a Production.
