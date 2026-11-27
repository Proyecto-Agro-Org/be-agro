# RUNBOOK — Certificar un publisher contra el kit (BE14-03)

Alcance: **local / `TEST_ONLY`**. El resultado máximo es `CONFORMANCE PASS LOCAL`. Hoy **no existe firmware real**: el modo externo está *preparado*, no ejecutado.

## Modo A — referencia (ya disponible)
```
npm run publisher:conformance                       # = --mode reference, 38 pruebas offline
npm run publisher:conformance -- --levels 0,1       # subconjunto
npm run publisher:conformance -- --only L2-06       # una prueba
npm run publisher:conformance -- --integrated .local-evidence/publisher-conformance-integrated-C1.json
```
El reporte JSON queda en `.local-evidence/publisher-conformance-report.json` (ignorado por git; no se versiona).

## Modo B — publisher externo (futuro firmware / gateway)
1. **Compilar el firmware** o gateway con su toolchain (el kit no impone plataforma).
2. **Provisionar una identidad `TEST_ONLY`**: una clave técnica canónica (`^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$`), credenciales de laboratorio generadas para la prueba. Nunca credenciales reales.
3. **Configurar MQTT local** (EMQX de laboratorio, solo loopback). El kit rechaza endpoints no locales.
4. **Configurar la reconciliación local**: el kit levanta su propio servidor HTTP `TEST_ONLY` (router real de BE13) y se lo indica al publisher en `boot`.
5. **Conectar el adapter**: implementar el puente stdio (JSON-lines, ver `CONTRATO_BE14_03_PUBLISHER_CONFORMANCE.md` §2) que traduzca `boot / createEvent / advance / inspectPending / restart / shutdown` (y, si existen, `armCrash / setClock / corruptOutbox`) a su firmware o simulador. Copiar `be14-03.external.example.json` y completar; **los secretos solo por variables de entorno** (`*Env`), nunca en el archivo.
6. **Ejecutar**: `npm run publisher:conformance -- --mode external --config <archivo>`.
7. **Guardar el reporte** (`--report <ruta>`); es local y no se commitea.
8. **Interpretar**: `L0..L5 PASS` por nivel; `FAIL` con `failureCode` y evidencia; `SKIP` solo por capacidad opcional o decisión pendiente; `NOT_RUN` = el kit todavía no puede ejecutar ese caso en modo externo (veredicto `INCOMPLETE`, código 4).
9. **Corregir los FAIL** en el publisher (no en el kit ni en BE13): cada `failureCode` indica qué regla se violó (p. ej. `PUBACK_AS_SUCCESS`, `RETRY_CHANGED_IDENTITY`, `DEVICE_TIMESTAMP_MISSING`, `SILENT_DROP`).
10. **Repetir** hasta cubrir los niveles alcanzables.

## Limitación vigente del modo externo
Esta versión del kit puede ejecutar de forma externa solo las pruebas **independientes del mundo** (L0 vía `createEvent`/`inspectPending`). Los casos que requieren observar o fallar un broker MQTT real (`world: mqtt`) se reportan `NOT_RUN`. Completar el modo externo exige un observador MQTT y control de fallos del broker (por ejemplo, el laboratorio EMQX de BE13): es el siguiente ticket recomendado cuando exista un publisher real.

## Códigos de salida
`0` PASS · `1` FAIL · `2` configuración inválida (modo desconocido, config ausente, secreto en línea, variable de entorno faltante, vectores corruptos) · `3` infraestructura no disponible (el puente no arranca) · `4` incompleto.

## Qué NO decir
No "production certified", no "hardware certified". Un PASS local no cubre red de campo, energía, autenticación productiva ni ninguna decisión humana pendiente.
