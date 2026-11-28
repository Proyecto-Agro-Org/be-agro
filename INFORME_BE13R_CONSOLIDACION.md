# BE-13R — Informe de consolidación sobre `dev`

## Estado y estrategia

La consolidación parte exactamente de `dev` `6a30be4374e68f655ef31fbb69286f4b5ab48178`, que contiene BE-12 mediante PR #21. Se creó `feature/be13-01-consolidacion` en un worktree nuevo y se recuperaron, en orden, los commits originales BE-13A `881375631be499817686add6cea8b8e4bcc80401` y BE13-01 `43e7a73c6a43da8d471fb51aeb6d3cdbcdfdb123` mediante cherry-pick.

Los commits eran lineales: BE13-01 era hijo directo de BE-13A. Los cherry-picks no produjeron conflictos de Git. Los worktrees y ramas originales permanecieron sin cambios; el worktree principal con archivos históricos sin seguimiento no fue utilizado.

## Reconciliación semántica

Se corrigió el estado histórico que describía BE-12 como una rama separada. Se compararon contratos, schemas, servicios y repository provisional de BE-12 con las identidades y fixtures BE-13.

Conclusiones:

- `sourceId + TechnicalDeviceKey` coincide con la resolución exacta BE-12 y nunca concede `clientId`.
- `physicalDeviceId`, `sensorId`, campo, área y cliente proceden de la ventana temporal persistida, no del evento IoT.
- El candidato BE13-02 no es un `TrustedMeasurementEvent` parcial. El servicio BE-12 solo puede invocarse con su forma estricta completa.
- `receivedAt` conserva recepción; la política actual no lo acepta como prueba silenciosa de adquisición.
- El evento debe permanecer en cuarentena mientras falten autoridad temporal, catálogo de magnitudes/unidades, procedencia verificable o mapping físico aprobado.
- Los históricos permanecen filtrados por `realm + clientId`, con ventanas semiabiertas y orden determinista.

No se modificó código funcional BE-11/BE-12, rutas, configuración ni variables de entorno.

## Fixtures conservados

Se conservaron los 14 fixtures y su manifest:

- 12 `SINTETICO`.
- 2 `OBSERVADO_EN_CODIGO`.
- 0 muestras reales o sanitizadas de EMQX.

Se reforzó la regresión documental para comprobar los conteos exactos y que ningún fixture pueda presentarse como un `TrustedMeasurementEvent` completo. Esto no convierte las muestras en evidencia externa ni aprueba el camino positivo.

## Validaciones

Resultados de la suite reconciliada:

- `npm.cmd ci --offline`: aprobado, 120 paquetes restaurados desde el lockfile, 0 vulnerabilidades informadas. Se usó `npm.cmd` porque la política local de PowerShell bloquea el wrapper `npm.ps1`; no se modificó esa política.
- Typecheck: aprobado.
- Build: aprobado.
- Pruebas offline: 425/425 aprobadas, incluidas 8/8 de BE13-01/BE-13R.
- Regresión HTTP: 13/13 escenarios equivalentes.
- `git diff --check`: aprobado.

Las suites BE-10, BE-11 y BE-12 permanecen incluidas en la regresión completa. La aplicación pública continúa montando únicamente health; no se agregaron rutas, conexiones automáticas ni variables productivas.

No se repiten MongoDB real, Atlas, EMQX, Vercel ni hardware porque no se modifica código funcional ni persistencia.

## Riesgos y decisiones pendientes

- Identidad de hardware, autenticador/ACL y rotación de `clientid` en EMQX.
- Estabilidad y scope real de `eventId` entre reintentos.
- Autoridad, precisión y tolerancia de `sentAt`/timestamp de dispositivo.
- Catálogo aprobado de magnitudes, unidades, ausencias y procedencia.
- Mapping físico Atlas y repository productivo.
- Aislamiento de Preview y activación controlada del modo protegido de iot-ingest.

## Condición para BE13-02

BE13-02 puede comenzar únicamente como mapper puro y offline, fail-closed, con salida `candidate | quarantined`, sin endpoints, MongoDB, EMQX ni atribución positiva inventada. El camino positivo hacia `TrustedMeasurementEvent` queda condicionado a las autoridades documentadas en `MATRIZ_BE13R_COMPATIBILIDAD_DEV.md`.
