# INFORME BE13-11F — Durabilidad de sesiones EMQX y recovery tras restart

Todo es `LOCAL_LAB_EVIDENCE` (EMQX 5.8.6 Community, `emqx/emqx:5.8.6`, Docker local, MongoDB 8.0 de tres nodos desechable). No es evidencia de producción. `productionReady` permanece `false`.

## Pregunta

¿Un mensaje QoS 1 que EMQX ya confirmó al publisher (PUBACK) sobrevive a un reinicio o caída del broker y llega al consumer / Durable Inbox? (Hallazgo F-E2 de BE13-11E: sin sesiones durables un reinicio perdió 145–147 de 200 eventos.)

## Resultado

- **Cola OFFLINE durable: `PROVEN_LOCAL`.** Con `durable_sessions.enable=true`, volumen persistente, `clientId` estable, `cleanStart=false` y `sessionExpiryInterval>0`, los mensajes confirmados para una sesión desconectada sobreviven a `docker restart`, `stop/start`, recreación con el mismo volumen y `docker kill` (0 perdidos tras PUBACK en D03, D06, D07 y D09 ×3).
- **Estado INFLIGHT / posición de ACK de la sesión: LIMITACIÓN DEMOSTRADA (D04).** Con el consumer conectado y sin ACKear, un reinicio dejó 1–3 mensajes confirmados por ciclo sin recuperar (`PUBACKED_BUT_NOT_RECOVERED` = 6 en 3 ciclos de 100 en la campaña de referencia) y, en paralelo, el mismo número de redeliveries obsoletos (`STALE_REDELIVERY` = 6: eventos ya consumidos y ACKeados en un ciclo anterior). Reproducido en cinco campañas completas independientes y en sondas mínimas; la hipótesis «re-suscribirse causa la pérdida» se probó y se descartó.
- **Ventana PUBACK → escritura durable: LIMITACIÓN DEMOSTRADA (D27).** EMQX envía el PUBACK antes del volcado del buffer de escritura (`local_write_buffer.flush_interval`, 100 ms por defecto). Con un buffer de 3 s, un `kill` inmediato tras los PUBACK perdió 50 de 50 mensajes confirmados. Con buffer afinado (1 ms / 1 ítem) y con el valor por defecto no se observó pérdida en 3×100–200 mensajes, pero la ventana no es cero por construcción.
- **F-E2 = `BLOCKED_BY_BROKER_CAPABILITY`** (no `CLOSED_LOCAL`): ninguna configuración probada eliminó la pérdida de D04 y 5.8.6 no ofrece escritura síncrona. No se cierra porque la cola offline sobreviva.

## Separación de clases (no se mezclan)

| Clase | Estado |
|---|---|
| A. Cola OFFLINE de sesión durable (restart, stop/start, recreate mismo volumen, kill) | PROVEN_LOCAL |
| B. Mensajes entregados y sin ACK (inflight) al reiniciar | KNOWN_LIMITATION (D04): `PUBACKED_BUT_NOT_RECOVERED` > 0, severidad ALTO |
| C. Ventana PUBACK→durable (crash duro) | LIMITACIÓN demostrada (D27); D09d sin pérdida observada pero sin garantía |
| D. Stale redelivery | Separado de pérdida; la idempotencia (11D) lo absorbe |
| E. Mala configuración (cleanStart, expiry 0, clientId distinto, volumen nuevo) | Pérdida esperada; el guard de laboratorio la rechaza |
| F. Almacenamiento no disponible / disco lleno | NO_VERIFICABLE (D28, D29): no se llena el disco del host |

## Evidencia (campaña `audit-be13-11f-emqx-durability`)

Estados: PASS / KNOWN_LIMITATION / FAIL / NO_VERIFICABLE; un estado no se reetiqueta para volverlo PASS.

- D01/D01b: F-E2 reproducido sin sesiones durables (PASS = el hallazgo se reproduce).
- D02: la configuración durable está realmente activa (config as code, sin dashboard).
- D03/D06/D07: restart / stop-start / recreate con el mismo volumen: 200/200 recuperados, 0 duplicados, sesión presente, primer mensaje ~3 ms tras reconectar.
- D08: volumen nuevo y vacío pierde todo (control negativo: la durabilidad vive en el volumen).
- D09/D09b/D09d: `docker kill` (SIGKILL) con buffer afinado y por defecto; kill a mitad de lote con contabilidad exacta de PUBACK.
- D11/D12/D13/D14: punta a punta con Durable Inbox: broker matado, restart de broker y consumer, restart de broker con Mongo sin majority (60/60 tras sanar), failover de Mongo tras recuperar el broker; exactamente una medición por evento.
- D15/D16/D17-18: cleanStart, expiry 0 y clientId distinto no recuperan (esperado); el mismo clientId recupera todo. D26: la sesión caduca según `sessionExpiryInterval`.
- D19: autenticador, ACL y regla `lab_verify` se restauran desde el volumen tras recrear.
- D20: payloads binarios idénticos byte a byte, topic y QoS preservados. D21: orden observado (sin promesa global).
- D22/D23 (impacto): publisher 1264 ev/s no durable, 1343 durable afinado, 1536 durable por defecto; p50 12.3 / 11.8 / 10 ms; p99 16.1 / 13.6 / 14.2 ms. La durabilidad no degradó el camino de publicación en el laboratorio. D24: el directorio de datos crece ~18 MB tras la cola (no es un dimensionamiento).
- D25: 0 contenedores/volúmenes del laboratorio residuales.

## Hallazgos

- **F-F1 (ALTO, abierto)**: mensajes confirmados pero no recuperados con consumer conectado y sin ACK al reiniciar el broker (D04), junto a stale redelivery. Componente: estado inflight/posición de ACK de la sesión. No se modifica el adaptador para enmascararlo.
- **F-F2 (ALTO, abierto)**: PUBACK anterior a la escritura durable; ventana = `flush_interval`; 5.8.6 CE no ofrece escritura síncrona (D27).
- **F-F3 (BAJO, corregido)**: fugas de volúmenes anónimos de contenedores del laboratorio y del lanzador; ahora `docker rm -f -v` / `docker rm --force --volumes` sólo sobre recursos propios.
- Arnés: D13 falló por el propio arnés (sin espera de contabilidad ni recuperación `receipted`, y lectura majority imposible sin mayoría); corregido sin relajar `noLoss`.

## Hallazgo fuera de EMQX: F-F7 (ALTO, abierto)

D13b (Mongo sin majority 14 s, más que el timeout de elección) perdió 59 de 60 eventos ya ACKeados: `term` de Mongo 1→2, claims y mediciones ausentes, estados del inbox `completed`. Con 4 s sin elección (D13) se recuperan 60/60. La causa (rollback de escrituras no majority; pre-check de idempotencia con lecturas no majority) es una hipótesis sin confirmar; no se tocó código de persistencia. Es una pérdida posterior al ACK en la capa Mongo/inbox y debe investigarse antes de cualquier uso productivo.

## Estado de las corridas finales (honesto)

- Campaña completa de referencia: `d11f-full5` (26 PASS, 1 KNOWN_LIMITATION D04, 2 NO_VERIFICABLE, 1 FAIL D13 de arnés).
- Dos corridas completas finales (RUN 1, RUN 2) se ejecutaron antes de corregir el arnés: ambas mostraron D04 KNOWN_LIMITATION y 21 PASS, con D13 y D27 FAIL (D27: `Not authorized` por un SIGKILL segundos después del bootstrap de la configuración por API, antes de que la autenticación se persistiera; corregido haciendo un reinicio ordenado previo). Los arreglos de arnés se validaron con corridas dirigidas (D13/D13b/D14, D27, D12). **No se repitió la campaña completa** por instrucción del usuario: la evidencia final es la suma de la campaña de referencia, esas corridas y las dirigidas.
- Arnés corregido: espera de contabilidad y supervisor en D13, pausa de Mongo exacta y acotada, `waitHealthy` acotado, reintento de CONNECT rechazado tras reinicio, un valor único por evento. D12 mostró un timeout intermitente de 8 min en una corrida (no reproducido).
- Mutantes: 8 de 8 detectados (M1 durabilidad desactivada, M2 cleanStart por defecto, M3 expiry 0, M4 clientId aleatorio, M5 oráculo ignora pérdidas, M6 olvida huecos, M7 mide contra enviados, M8 stale como limpio); no hubo mutantes inválidos.

## Alcance no cubierto

No se actualizó la imagen de EMQX ni se probó 5.9/6.x (queda como decisión humana). No se evaluó clúster/HA. No se cambió la autenticación (username/password TEST_ONLY; `PRODUCTION AUTH = PENDING`). No se tocó `app.ts`.
