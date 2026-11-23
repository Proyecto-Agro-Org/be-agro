# BE13-01 — Evidencia pendiente de EMQX

No se accedió al tenant EMQX ni se recibieron capturas reales sanitizadas. Para cerrar el contrato positivo deben solicitarse al responsable de EMQX las siguientes evidencias, sin secretos ni datos reales de clientes.

## Plataforma y seguridad

- Versión, edición y modalidad de alojamiento EMQX.
- Autenticador usado por dispositivos y política de unicidad de `clientid`.
- ACL por dispositivo/topic y comportamiento ante reconexión o clientid duplicado.
- TLS extremo a extremo, terminación, restricciones de red y headers agregados por proxies.
- Regla/bridge HTTP exacta, sin valores de credenciales.
- Política de rotación y rollback de `x-emqx-key`.

## Fixtures requeridos

Para cada muestra: JSON o bytes sanitizados, headers no sensibles, nombre del evento EMQX, QoS, retain/DUP si están disponibles, origen de cada timestamp y comportamiento de retry.

1. Publicación normal de telemetría.
2. Publicación parcial con null y cero.
3. Estado de dispositivo.
4. Conexión aceptada.
5. Desconexión normal y pérdida abrupta.
6. Deep sleep y reconexión.
7. Reintento HTTP después de timeout/ACK perdido.
8. Duplicado MQTT/bridge.
9. Mensaje fuera de orden o retenido.
10. Clock skew del dispositivo.
11. Reinicio con eventId nuevo o preservado.
12. Colisión o takeover de clientid.

## Preguntas bloqueantes

- ¿Quién genera `eventId` y cuál es su scope de unicidad?
- ¿Se conserva exactamente entre reintentos HTTP?
- ¿Qué campo proviene del contexto autenticado y cuál del payload?
- ¿`sentAt` representa publicación MQTT, ejecución de regla o envío HTTP?
- ¿Qué precisión y zona tienen los tiempos?
- ¿EMQX reserializa JSON entre retries o preserva bytes?
- ¿Cómo representa eventos connected/disconnected en la versión usada?
- ¿Qué ocurre con mensajes retained, offline queue, QoS 1/2 y sesiones persistentes?
- ¿Hay más de un broker/source y cómo se separan sus namespaces?
- ¿Existe inventario confiable hardware ↔ clientid y proceso de rotación/descomisionamiento?

## Criterio de desbloqueo

BE13-02 puede comenzar offline con casos negativos y la interfaz `candidate | quarantined`. El camino positivo hacia atribución solo se desbloquea cuando las muestras permitan demostrar identidad técnica, estabilidad de eventId, significado temporal y formato de payload. Ninguna respuesta debe incluir secretos, IPs privadas, IDs reales sin sanitizar o datos productivos.
