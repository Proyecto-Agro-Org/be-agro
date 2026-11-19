# BE-09.3A — Trazabilidad de auditoría

19/11/2026. Base 3ac72ab. [Informe final](INFORME_BE09_3A_AUDITORIA_FINAL.md).
Resultado: 266/266, 252 previas +14 A; 13/13 HTTP. Los prefijos A/P/K/I se encuentran
en `test/authentication-persistence.test.js`. Local = offline; parcial = gate externo;
pendiente = no ejecutado/implementado. No representa certificación distribuida.

| Requisito / amenaza | Control o análisis | Prueba / evidencia | Estado | Riesgo residual |
|---|---|---|---|---|
| Realm array muta recurso ajeno | Igualdad escalar de campo completo | A01 falló antes/aprueba después; F09.3A-01 | Local | BSON real y validators de colección pendientes |
| Nonce/digest array satisface claim | Strings exactos con type y literal | A02 falló antes/aprueba después | Local | No es un bypass HTTP demostrado |
| Fecha/id inválidos se actualizan | Guardias de fechas BSON e id consultado antes de update | A03 falló antes/aprueba después | Local | No sustituye validación física de toda la colección |
| ACK truthy equivale a confirmado | Solo boolean true e insertedId exacto | A04 falló antes/aprueba después; F09.3A-02 | Local | Driver/replicación real no certificados |
| Null/array/missing/already-used | Type agregado exige null escalar | P18 original + A05 | Local | Limpieza de datos históricos no autorizada |
| BSON temporal inesperado/TTL tardío | Guardias Date y expiración lógica | A06, P07/P13 | Local | No se observó TTL físico |
| Inyección de operadores/epochs | Validación antes de IO | A07, P06 | Local | Endpoints futuros deben usar el mismo puerto seguro |
| ID lógico con dólar | $literal, no interpretación como field path | A12 | Local | Canonicalización de IDs físicos BE-02 pendiente |
| Duplicación de sesión | Índices y insert sin overwrite/upsert | P03/P05; sonda real preparada | Parcial | Unicidad y sharding reales no probados |
| Consumo duplicado/replay | Un update condicional, sin lock local | P08/P09/I03 | Parcial | Dos procesos contra MongoDB real pendientes |
| Renovación idle fuera de orden | Max condicional y snapshot after | A09 con dos Connections y barrera | Parcial | Simulación no es atomicidad del servidor |
| Logout concurrente/reactivación | Estado null exigido, no cambiar revokedAt por touch | P11/P12/A05 | Parcial | No cancela I/O ya admitido |
| Catálogo con varias pertenencias/identidades | Rechazar arrays/ambigüedad explícita, sin política multicliente inventada | A08, K03/K05 | Local | Reader no detecta duplicados ocultos si el store elige el primero |
| Unicidad física de identidad | Contrato exige unique o rechazo de ambigüedad | Comentario del store y análisis A08 | Pendiente | Catálogo físico/writer BE-02 no implementados |
| Usuario/cliente deshabilitado/reasignado | Pertenencia y versión revalidadas | I02, K03/K04, A10 | Parcial | Reactivar sin versionar puede revivir sesiones viejas |
| Escritura después de invalidar catálogo | Carrera reproducida: deny final, touch puede completarse | A10 | Parcial, garantía absoluta NO satisfecha | Requiere protocolo writer/consistencia o transacción aprobada |
| Acceso cruzado entre clientes | Contexto privado y scope persistente | I01/I03, regresiones BE-09.1/2 | Parcial | Queries físicas de negocio no implementadas |
| Error de lectura/escritura/resultado parcial | Rechazo seguro sin raw exception ni retry propio | A11, P09/P14/P15/P19, I05 | Local | Red/ACK perdidos reales aún pendientes |
| Logging sin secretos | DTO cerrado BE-08; solo hashes en store | I05, K07/A11, suite preservada | Local | Configuración de logging/debug desplegada pendiente |
| Startup/índices/config | Namespace explícito; índices únicos completos; sin auto-DDL/buffering | P01/P02/P03/P19 | Parcial | DDL posterior, topología y permisos reales pendientes |
| Modelo catálogo real | Mantener puerto readonly sin usuarios/clientes ficticios | K01…K08, revisión de módulos | Pendiente de BE-02 | No se declaró una colección productiva |
| Prueba MongoDB real autorizada | Inventario local sin instancia identificada | PATH/servicios/repositorio revisados | No ejecutada | Sin versión ni resultados de servidor |
| Preparación de sonda local | Guard opt-in, loopback directo, DB aleatoria y cleanup acotado | A13/A14; compilación de scripts/audit-auth-mongodb-local.ts | Local solo guard/compilación | Casos positivos y cleanup real no ejecutados |
| No activación accidental de sonda | No URI externa, no import desde app, opt-in antes de connect | A13/A14 y grafo | Local | Operador debe confirmar aislamiento/ausencia de túneles |
| Regresiones preservadas | AST de 32 tests + diez archivos previos intactos | 266/266; 46/46 suite persistencia | Local | Tests no certifican seguridad universal |
| HTTP productivo intacto | App/router/health/CORS/handler existentes sin cambios | Comparador 13/13 contra 3ac72ab | Local | Preview/E2E remoto pendiente |
| Integración real | Auth default sigue deshabilitada | Revisión de grafo/imports | Pendiente BE-02/03/GIS/FE/Vercel | No habilitar hasta resolver gates |

F09.3A-01 medio y F09.3A-02 bajo corregidos. Sin hallazgos altos/críticos locales
abiertos identificados. Aptitud para revisión/publicación de infraestructura
inactiva, no para habilitación productiva. Sin commit, push, PR, merge o deploy.
