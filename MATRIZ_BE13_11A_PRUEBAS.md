# BE13-11A — Matriz de pruebas

## Totales

| Suite | Resultado |
| --- | --- |
| `npm test` | **897/897** (859 previas + 22 funcionales + 16 adversariales) |
| `test/be13-11a-provenance-boundary.test.js` | 22/22 |
| `test/be13-11a-adversarial.test.js` | 16/16 |
| HTTP `verify-be10-http` | 13/13 |
| Mongo E2E `-Suite be13-11a` | 13/13 × 2 |
| Regresión Mongo `-Suite be13-10b` | 28/28 |
| Mutantes | 6/6 detectados |

## Funcionales

| Prueba | Cubre |
| --- | --- |
| P01 | `VERIFIED` → ingested; identidad desde el mapping; request congelada con realm y fingerprint; audit y métrica |
| P02 | Sin principal (no se consulta al verifier) o principal desconocido → `security`, no reintentable; sin cuarentena |
| P03 | `REJECTED` → `broker-provenance-rejected` |
| P04 | El verifier lanza o se cuelga (timeout `TEST_ONLY`) → `transient` y alerta |
| P05 | Respuestas malformadas → `invalid-authority-response`; `VERIFIED` de otro contexto o principal → `broker-context-mismatch` |
| P06 | Realm distinto en el verifier o en el mapping |
| P07 | Topic falsificado (con ruta) no cambia la identidad; el topic declarado se ignora; sin ruta → `topic-not-routed` |
| P08 | El `mqttClientId` no es el `clientId` de negocio (este sale de BE-12) |
| P09 | Clave técnica distinta (declarada, alias o la de la conexión) → rechazo en el boundary, alerta y audit |
| P10 | Retained bloqueado por defecto; aceptado solo con política explícita `TEST_ONLY` |
| P11 | JSON inválido, UTF-8 inválido, raíz no objeto, `1e400`; `"0"` no se convierte |
| P12 | `__proto__`, `constructor`, `prototype`; ningún prototipo contaminado |
| P13 | Tamaño excesivo antes del hash, profundidad, cantidad de claves, longitud |
| P14 | Banderas trusted/verified/authenticated no cambian nada |
| P15 | Banderas retryable no cambian la clasificación |
| P16 | Reentrega QoS 1/2 del mismo evento → `duplicate` |
| P17 | Reutilizar el packet id es irrelevante |
| P18 | E2E aceptado de punta a punta; `admitForReplay` |
| P19 | E2E en cuarentena dentro del pipeline (sin `rawPersistedAt`; dispositivo desconocido) |
| P20 | Métricas y alertas con etiquetas cerradas, sin identificadores |
| — | Placeholders: no se admite nada; readiness `BLOCKED` / `MISSING`; `productionReady` false |
| — | El boundary es dueño de la procedencia: rechaza un verifier inyectado; dependencias obligatorias; evidencia forjada rechazada |

## Adversariales: `MATRIZ_BE13_11A_VECTORES.md`.

## Mutantes (sobre `dist`, restaurados; línea base 38/38)

| Mutante | Cambio | Detectado por |
| --- | --- | --- |
| M1 | Verifier omitido (todo `VERIFIED`) | P01, P03, P04, P05, A06, A07 (11 fallas) |
| M2 | Sobre con `passthrough` (acepta realm, `sourceId`, trusted declarados) | A01, A03, A04, A13, P14 |
| M3 | El `mqttClientId` observado se toma como identidad autorizada | A05 |
| M4 | Claves peligrosas permitidas | P12 |
| M5 | `REJECTED` clasificado como reintentable | P03, P15 |
| M6 | Sin control de clave técnica | P09, P20, A03, A05 |

## Ajustes a pruebas y dobles previos

- BE13-07A V1: lista cerrada de placeholders, que suma `createBlockingMqttBoundaryPlaceholders`.
- Guard del launcher: suma `be13-11a`.
- Doble de persistencia en memoria: `measurementId` = `sha256` de la clave (H2).
