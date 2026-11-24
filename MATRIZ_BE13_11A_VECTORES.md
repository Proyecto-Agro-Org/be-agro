# BE13-11A — Matriz de vectores

## Offline (`test/be13-11a-adversarial.test.js`, 16/16)

| V | Vector | Resultado | Severidad |
| --- | --- | --- | --- |
| A01 | Realm falsificado en el payload | sobre malformado; el verifier solo ve el realm del bootstrap | SIN HALLAZGO |
| A02 | Realm u owner falsificado en el topic | solo routing; realm y `clientId` de negocio intactos | SIN HALLAZGO |
| A03 | `clientId` de negocio falsificado | alias distinto → `technical-identity-mismatch`; nivel superior → malformado | SIN HALLAZGO |
| A04 | `sourceId` falsificado | malformado; el persistido sale del mapping | SIN HALLAZGO |
| A05 | Clave técnica falsificada (declarada o de la conexión) | `technical-identity-mismatch` | SIN HALLAZGO |
| A06 | Revisión o instante falsificados en la verificación | `invalid-authority-response` | SIN HALLAZGO |
| A07 | Getter hostil en el verifier o el mapping | `invalid-authority-response` (sin crash) | SIN HALLAZGO |
| A08 | Respuestas o configuración mutables | copias validadas; mutar después no cambia nada | SIN HALLAZGO |
| A09 | Contaminación de prototipo en cualquier nivel | rechazada; nada contaminado | SIN HALLAZGO |
| A10 | Payload bomb (límite exacto, +1, 50 000 niveles de anidamiento) | tamaño antes de leer; recorrido iterativo | SIN HALLAZGO |
| A11 | Reentrega retenida de un evento ya ingerido | bloqueada; una sola medición | SIN HALLAZGO |
| A12 | Packet id duplicado en entregas concurrentes de eventos distintos | se ingieren por separado | SIN HALLAZGO |
| A13 | Banderas "authenticated" falsas | rechazadas; el principal reportado por el broker es lo único que cuenta | SIN HALLAZGO |
| A14 | Intento de filtrar un secreto crudo | nada del payload llega a audit, métricas, alertas ni resultados | SIN HALLAZGO |
| A15 | Contexto de broker malformado (QoS 3, retain no booleano, packet id 0/70 000, instantes inválidos, comodines, tipos de payload incorrectos, getters hostiles) | `broker-context-malformed` sin parsear ni verificar | SIN HALLAZGO |
| A16 | Conexión de broker, red, credenciales, env, dependencias MQTT, montaje en `app.ts` | ausentes | SIN HALLAZGO |

## Mongo real (E2E 13/13 × 2)

| ID | Vector | Resultado |
| --- | --- | --- |
| E02 / E03 | Reentrega QoS y duplicados concurrentes en 3 conexiones | 1 medición |
| E04 / E05 / E09 | Procedencia rechazada, no verificada o verifier caído | sin medición ni cuarentena |
| E06 | Clave técnica distinta | sin escritura; audit |
| E07 / E08 | Retained, claves peligrosas, tamaño excesivo, malformado | sin escritura; el audit no contiene payload |
| E11 | Inserción directa de audit con acción desconocida o campos de payload | 121 |
