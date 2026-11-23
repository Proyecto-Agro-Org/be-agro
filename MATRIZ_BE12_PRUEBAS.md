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

## MongoDB real preparada

La sonda `audit-be12-mongodb-local.ts` prepara diez casos R01–R10: versión/topología, índices, sensor, dispositivo, área/campo, paginación, transferencia histórica, evento tardío, evento duplicado y lecturas concurrentes aisladas. R04 usa explícitamente `attributedAt DESC, id DESC`; no depende del orden natural ni del índice elegido. La evidencia incluirá el SHA obtenido directamente de Git y exige árbol limpio.

Comando pendiente desde CMD de Windows, después del commit:

```bat
cd /d "C:\Users\CamilaGonzález\be-agro\.local-consolidacion\dev"
npm ci && npm run build && powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\be11-local.ps1" -Suite be12 -AuthorizeDisposable
```

No se informa aprobación MongoDB hasta inspeccionar `.local-evidence/be12-mongodb.json`.
