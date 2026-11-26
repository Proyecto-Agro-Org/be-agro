# MATRIZ BE13-11F — Durabilidad por escenario

`LOCAL_LAB_EVIDENCE`. Estados: PASS, KNOWN_LIMITATION, FAIL, NO_VERIFICABLE. «Perdidos» = confirmados con PUBACK y no recuperados (`PUBACKED_BUT_NOT_RECOVERED`).

| Escenario | Qué se probó | Resultado | Perdidos |
|---|---|---|---|
| D01 / D01b | Sin sesiones durables: reinicio con cola offline o consumer lento | PASS (F-E2 reproducido) | pérdida esperada |
| D02 | Configuración durable activa (config as code) | PASS | — |
| D03 | Restart con sesión offline | PASS | 0 de 200 |
| D04 | Entregados y sin ACK al reiniciar (3 ciclos) | **KNOWN_LIMITATION** | 6 de 300 (+ 6 stale) |
| D05 | Restart con consumer en línea consumiendo | PASS | 0 |
| D06 | stop → start (mismo contenedor y volumen) | PASS | 0 de 200 |
| D07 | Contenedor recreado, mismo volumen | PASS | 0 de 200 |
| D08 | Contenedor recreado con volumen nuevo | PASS (control negativo: pierde todo) | esperado |
| D09 | `docker kill` tras el último PUBACK, buffer afinado ×3 | PASS | 0 de 600 |
| D09b | Kill a mitad de lote, contabilidad exacta | PASS | 0 de los ACKeados |
| D09d | Kill con buffer por defecto (100 ms) ×3 | PASS (sin garantía: ver D27) | 0 de 300 |
| D27 | Kill con buffer de 3 s | PASS = ventana demostrada | 50 de 50 |
| D11 | Kill + inbox durable punta a punta | PASS | 0; 1 medición por evento |
| D12 | Restart de broker + consumer | PASS | 0 |
| D13 | Restart de broker + Mongo sin majority 4 s (sin elección) | PASS (corrida dirigida final) | 0 de 60 |
| D13b | Igual con 14 s (más allá del timeout de elección: step-down, elección, `term` +1) | **KNOWN_LIMITATION** (capa Mongo/inbox, no EMQX) | 59 de 60 (claims y mediciones revertidos) |
| D14 | Broker recuperado y luego failover de Mongo | PASS | 0 |
| D15 | cleanStart=true tras construir la cola | PASS (pérdida esperada, guard lo rechaza) | esperado |
| D16 | sessionExpiry=0 | PASS (pérdida esperada) | esperado |
| D17/D18 | clientId distinto / mismo | PASS | — |
| D19 | Auth, ACL y regla restauradas desde el volumen | PASS | — |
| D20 | Bytes exactos de cada payload tras kill | PASS | 0 |
| D21 | Orden observado | PASS (sin promesa) | 0 |
| D22 / D23 | Throughput y latencia PUBACK con/sin durabilidad | PASS (medición) | — |
| D24 | Crecimiento del almacenamiento y limpieza | PASS | — |
| D25 | Sin residuos Docker del laboratorio | PASS | — |
| D26 | Expiración de sesión | PASS | esperado tras expirar |
| D28 | Almacenamiento no disponible / sólo lectura | NO_VERIFICABLE | — |
| D29 | Disco lleno | NO_VERIFICABLE | — |

Veredicto F-E2: `BLOCKED_BY_BROKER_CAPABILITY` (D04 y D27).
