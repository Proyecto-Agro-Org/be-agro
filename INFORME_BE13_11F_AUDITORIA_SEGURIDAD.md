# INFORME BE13-11F — Auditoría de seguridad

- `LOCAL_TEST_ONLY`: broker EMQX en Docker local sobre loopback, MongoDB desechable de tres nodos; sin broker externo, Atlas, hardware, credenciales reales ni Production.
- Autenticación sin cambios: username/password TEST_ONLY generadas por corrida (`labpw-<hex>`) y depuradas de la salida; `PRODUCTION AUTH = PENDING`.
- Ninguna credencial TEST_ONLY versionada; sin JWT, claves privadas, `mongodb+srv` ni `x-emqx-key` en el repositorio (escaneo registrado en el informe final).
- Docker: recursos propios con etiqueta `agro.emqx.lab=<runId>`; se eliminan sólo ésos (contenedor con `-v`, volumen etiquetado). Los volúmenes ajenos preexistentes no se tocan.
- Sin cambios en `app.ts`, sin worker ni cron productivo; una sola dependencia MQTT (`mqtt@5.16.1`); `productionReady` permanece `false`.
- Control de configuración: el adaptador exige `cleanStart=false`, expiry > 0 y clientId estable cuando se pide sesión durable; los valores por defecto del adaptador no cambiaron.
- Riesgo residual: la ventana PUBACK→escritura durable y el estado inflight (F-F1/F-F2) son un riesgo de integridad (pérdida silenciosa de lecturas confirmadas), no de confidencialidad.
