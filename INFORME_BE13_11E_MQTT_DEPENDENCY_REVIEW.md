# INFORME BE13-11E — Revisión de la dependencia `mqtt@5.16.1`

Fecha: 2026-11-25. Sin cambio de versión durante el benchmark (no hubo un bug que lo justificara).

| Aspecto | Resultado |
|---|---|
| Versión | `5.16.1`, fijada **exacta** en `package.json` |
| Es la última publicada | Sí (`dist-tags.latest = 5.16.1`, modificada el 2026-10-14) |
| Licencia | MIT |
| `npm audit --omit=dev` | 0 vulnerabilidades |
| Clausura de dependencias | 42 paquetes (incluida la librería): 37 MIT, 3 ISC, 1 BSD-3-Clause, 1 0BSD |
| Paquetes relevantes | `ws`, `mqtt-packet`, `debug`, `socks`, `readable-stream`, `lru-cache`, `worker-timers` |
| Motor | Node ≥ 16 (el proyecto usa Node 24) |
| Dependencias directas | 15 |

## Comportamientos verificados que importan para seguridad

- `customHandleAcks` **solo se respeta con MQTT 5**; con 3.1.1 el cliente ACKea solo (F-D1, mitigado).
- Un `start()` puede colgar si la conexión se cierra antes de completar la suscripción (F-E3, corregido en el adapter).
- Sin reconexión automática (`reconnectPeriod: 0`), por diseño del adapter.
- Los tipos de la librería arrastran tipos DOM que `lib: ["ES2022"]` no provee; se carga con un especificador dinámico y tipado local. `skipLibCheck` se descartó porque alteraba tipos de mongoose.

## Riesgos conocidos localmente

Dependencia con cadena de suministro nueva (37 paquetes). Parte de la lógica de ACK depende de un comportamiento interno (`customHandleAcks`) que no es una API de contrato explícita: un cambio de la librería podría romper persist-before-ack silenciosamente. **Mitigación:** las pruebas D05/D06/D11 y el escenario E04 fallan si el ACK deja de ser diferido.

## Política de actualización propuesta (no vigente)

1. Mantener la versión fijada exacta.
2. Actualizar solo con una razón (vulnerabilidad o bug demostrado) y volver a correr la campaña de ACK completa (E04, E18–E20, T06).
3. `npm audit` y revisión de licencias en cada actualización.
4. Revisar cualquier librería futura de autenticación con el mismo criterio.
5. Para la imagen de EMQX en producción, fijar el **digest** además del tag y escanearla (fuera de este ciclo).
