# Fechas y precisión temporal BE-04

**Estado:** diseño documental parcial. Complementa D03-14 del PR #3; no lo modifica. Fuentes y alcance en [informe](../INFORME_BE04_CATALOGO_UNIDADES.md).

## 1. Tiempos que no deben fusionarse

| Concepto | Evidencia | Criterio |
|---|---|---|
| Adquisición | S03 propone timestamp string UTC o null con time_quality; S09 no lo valida ni exige | Representa lectura del dispositivo solo si productor/versión lo garantizan; secuencia o nombre de campo no prueban reloj sincronizado |
| Recepción en ingesta | S09 measurement.service agrega _receivedAt=new Date() y sobrescribe el del body | Instante del servidor al procesar mensaje, no instante de adquisición ni garantía de reloj perfectamente exacto |
| Recepción de estado | S09 actualiza _lastSeen; _createdAt conserva primera alta | Evento operativo; puede existir sin medición. No equivale a “última lectura” |
| Timestamp de broker/sobre | Sobre JSON libre S09, unidades/semántica no fijadas aquí | Preservar; no tratar número arbitrario como segundos o milisegundos por cantidad de dígitos |
| Ensayo / muestra / cálculo | S04 exige fecha y referencias de inputs; calculated_at como trazabilidad propuesta | Fecha de toma, análisis y cálculo pueden diferir; ninguna se copia como adquisición del S8 |

## 2. Acuerdos vigentes y propuestas

**Confirmado por ESPECIFICACION.md/plan:** respuesta ISO 8601 UTC, entrada histórica con zona, desde<hasta, orden estable y distinción recepción/adquisición; datos ausentes no se completan con cero. Colecciones convencionales, preservación del historial.

**Propuesto en BE-03, aún no aprobado conjuntamente:** perfil restringido con T/Z mayúsculas, segundos obligatorios, offset ±HH:mm o Z en entradas, salida Z; no segundos intercalares. No se dice aceptar todas las variantes ISO 8601 o RFC3339. Gramática por sí sola no verifica día real, offset o comparabilidad de instantes.

Para legacy: identificar formato/versión y validar calendario, zona, rango representable y procedencia del reloj antes de convertir. Fecha local sin zona no recibe por defecto America/Buenos_Aires, UTC ni zona del servidor. Requiere política de origen demostrada; conservar el original si no se resuelve. Timestamp numérico necesita unidad/época explícitas. Una fecha válida no demuestra dispositivo autorizado.

E04-08 usa un offset como caso sintético de entrada/legacy para contrastar instantes equivalentes. S03 propone timestamp de dispositivo en UTC; aceptar un offset legado es una política candidata, no un cambio aprobado de ese productor. BE-03 admite offsets en parámetros de entrada y requiere Z en respuesta: son fronteras distintas. Tampoco un timestamp parseable demuestra calidad de reloj; el mapper debe considerar la evidencia de sincronización/calidad definida por IoT, sin inferirla solo de la gramática.

## 3. Precisión: evitar pérdida silenciosa

S05 expresa resolución de magnitudes, no precisión de reloj del firmware. S03 da ejemplos con segundos, sin garantizar que ese sea el máximo de precisión. Date JS y BSON Date representan milisegundos; no preservan fracciones inferiores al milisegundo como instantes independientes. No se confunde BSON Date con el tipo BSON Timestamp de replicación.

BE-03 permite fracciones de más de tres cifras. Se confirmó localmente en Node que Date.parse('2026-11-16T12:00:00.0001Z') y Date.parse('2026-11-16T12:00:00.0002Z') producen el mismo número, aunque son instantes distintos. No se permite usar esa igualdad para rechazar un rango válido, ordenar iguales o deduplicar observaciones distintas.

**Propuesta D04-09:** conservar string/precisión de origen y comparar instantes a precisión suficiente (segundos normalizados a UTC y fracción exacta, por ejemplo), sin elegir ahora una librería o schema de persistencia. Si se usa una clave BSON Date para consultas, resolver el residual submilisegundo y los bordes de consulta con BE-02; convertir solo después de una política explícita de precisión. Alternativamente el equipo podría aprobar limitar la precisión pública con tratamiento de históricos; BE-04 no impone esa restricción ni un redondeo silencioso.

Offset distinto puede representar el mismo instante: 2026-11-16T09:00:00-03:00 = 2026-11-16T12:00:00Z. No ordenar strings heterogéneos lexicográficamente. Comparar instantes válidos, preservar zona original como trazabilidad y emitir UTC con la precisión acordada. Mostrar hora local es presentación FE; no cambiar la cronología persistida.

## 4. Faltantes, inválidos y mensajes tardíos

| Caso | Comportamiento documental propuesto |
|---|---|
| timestamp=null con reloj no sincronizado | adquisición desconocida; preservar time_quality y recepción separada. No inventar instante mediante seq/uptime sin regla validada |
| Ausencia o fecha imposible | Marcar causa diferenciada; no usar Date.parse como único validador de calendario; bruto intacto |
| Recepción conocida, adquisición desconocida | Posible listado técnico por recepción si se aprueba como tal; no reutilizar contrato de histórico de adquisición silenciosamente |
| Fecha futura, gran demora o reloj desviado | Registrar anomalía sin tolerancias inventadas. IoT acuerda sincronización y límites; no clamp a “ahora” |
| Fuera de orden | Preservar inserción y tiempo de origen. Última por adquisición válida, no último insertOne, como propuesta para BE-12; tardío puede caer dentro de histórico |
| Igual adquisición, distinto mensaje | Mantener registros hasta política de duplicación; timestamp solo no es clave única |
| Reentrega mismo msg_id / seq reiniciada | Necesita identidad, sesión/reinicio y namespace de productor confiables. No borrar ni crear índice único en esta tarea |
| Reloj/precisión cambian entre firmware | Versionar interpretación; no mezclar series con falsa precisión; conservar evidencia |

## 5. Última lectura, orden y límites

Propuesta para BE-12: último frame de adquisición válido y autorizado, incluso si parcial; seis variables FE presentes con valores null cuando no hay dato utilizable. No confundir con fecha de recepción ni enriquecer con ensayos de otra fecha bajo el mismo timestamp. Si ningún frame puede representarse por fecha/fuente válida, el tratamiento de ultima_medicion:null y sus diagnósticos debe acordarse con FE/BE; no afirmar que “no hubo ningún documento”.

Para BE-13: filtro por identidad/relación confiable antes de exponer, adquisición válida orden ascendente y desempate estable interno por identidad del registro, conservando todos los registros que la política aprobada no haya clasificado como duplicados. Un ObjectId puede desempatar, pero no prueba adquisición ni identidad del productor. La clave física definitiva depende de Atlas y BE-02.

El rango desde<hasta está acordado; inclusividad [desde,hasta] sigue propuesta de BE-03. Acordar bordes submilisegundo, límite, empates, paginación y truncado. Ordenar/filtrar/excluir por calidad no puede ocultarse usando truncado como si solo significara límite. No mezclar silenciosamente unidades/métodos en puntos con unidad única.

## 6. Aceptación futura, sin implementación

- UTC y offset equivalentes, fechas imposibles y locales sin zona.
- null, ausencia, reloj no sincronizado, adquisición distinta de recepción y recepción anterior por desajuste.
- Fracciones .0001/.0002, fechas iguales con distinta grafía y cambios de precisión.
- Dos mensajes mismo timestamp, reentrega y reinicio de seq, sin borrar históricos.
- Tardíos y rangos cuyos bordes caen entre milisegundos; orden estable y límite sin omisiones por conversión.
- Snapshot parcial sin arrastrar datos antiguos, series compatibles y contexto de cliente verificado.

Estos son criterios para pruebas futuras, no tests de backend ejecutados. Los ejemplos se encuentran en [EJEMPLOS_BE04.json](EJEMPLOS_BE04.json); no prueban un parser o comparador productivo.
