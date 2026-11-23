# Matriz de pruebas BE-12

## Offline

| Grupo | Cobertura | Estado |
|---|---|---|
| Identidad | exacta, desconocida, duplicada, no verificada | APROBADO |
| Ciclo de vida | activo, inactivo, descomisionado | APROBADO |
| Temporalidad | half-open, ausente, overlap, reloj no confiable | APROBADO |
| Medición | null/causa, cero, simulada, catálogo inyectado | APROBADO |
| Seguridad | propietario no público, outputs corruptos, errores sanitizados | APROBADO |
| Históricos | sensor, dispositivo, área, campo, latest | APROBADO |
| Paginación | rango, límite, orden estable y cursor | APROBADO |
| Sesión | revocación durante lectura | APROBADO |
| HTTP | rutas no publicadas | APROBADO |
| Regresión general | suite completa | 417/417 |
| HTTP legacy | health, CORS, 404 y 500 | 13/13 |

## MongoDB real validada

La campaña R01–R10 se ejecutó para `dc39a89f2734772bf6dd76a880b11504a28cb726` con MongoDB 8.0.38 y un replica set local de un nodo. Resultado: 10 aprobadas, 0 fallidas. Validó versión/topología, índices, sensor, dispositivo, área/campo, paginación, transferencia histórica, evento tardío, evento duplicado y lecturas concurrentes aisladas. R04 usa explícitamente `attributedAt DESC, id DESC`; no depende del orden natural ni del índice elegido.

| Casos | Resultado |
|---|---|
| R01–R10 | 10/10 APROBADO |
| Índices | identidad, evento, sensor, dispositivo y área presentes |
| Limitación | un nodo; no prueba failover, Atlas ni Production |

Comando reproducible desde CMD de Windows:

```bat
cd /d "C:\Users\CamilaGonzález\be-agro\.local-consolidacion\dev"
npm ci && npm run build && powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\be11-local.ps1" -Suite be12 -AuthorizeDisposable
```

La evidencia local `.local-evidence/be12-mongodb.json` fue inspeccionada y permanece excluida de Git.
