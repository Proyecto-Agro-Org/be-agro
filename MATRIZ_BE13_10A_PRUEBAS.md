# BE13-10A — Matriz de pruebas

## Totales

| Suite | Resultado |
| --- | --- |
| `npm test` completo | **825/825** (776 previas + 49 nuevas) |
| `test/be13-10a-security-policy.test.js` | 39/39 |
| `test/be13-10a-adversarial.test.js` | 10/10 |
| `scripts/verify-be10-http.mjs` | 13/13 equivalentes |
| typecheck / build / `git diff --check` | OK |
| Mongo | no aplica: sin cambios de esquema ni de repositorios |
| Mutaciones | 6/6 detectadas |

## Funcionales (39)

| Grupo | Pruebas |
| --- | --- |
| Identidad | I01 sin proveedor (y cualquiera de las 8 políticas) · I02 proveedor deniega · I03 rol forjado · I04 capacidad forjada (credencial o respuesta del proveedor) · I05 realm ajeno · I06 principal sintético válido · I07 respuestas malformadas (incl. email como subject) · I08 proveedor lanza |
| Mapeo | M01 rol desconocido · M02 sin capacidad / mapeo vacío · M03 mapeo sintético · M04 capacidades excesivas/desconocidas/duplicadas · M05 realm preservado |
| SoD | S01 combinación en conflicto · S02 combinación permitida · S03 política ausente/placeholder · S04 política lanza / malformada / otro realm |
| Lease | L01 activo · L02 expirado sintético + recuperación explícita · L03 liberación no autorizada · L04 liberación por el dueño · L05 versión vieja / leaseId distinto · L06 recuperación concurrente (un ganador) · L07 sin autoridad temporal · L08 dueño distinto / política placeholder nunca expira |
| Retención | R01 pendiente · R02 indefinida · R03 hasta fecha sintética · R04 legal hold impide borrado · R05 respuesta inválida · R06 política lanza |
| Evidencia | E01 declarada sigue sin verificar · E02 verificada sintética · E03 rechazada · E04 respuesta malformada · E05 verificador lanza |
| Otros | Readiness (BLOCKED / INJECTED_UNVERIFIED / MISSING; `productionReady` false) · bundle con todos los placeholders · integración con el bootstrap de BE13-09 (replay real autorizado por el bundle) |

## Adversariales (10): ver `INFORME_BE13_10A_AUDITORIA_SEGURIDAD.md`.

## Mutaciones (sobre `dist`, restauradas byte a byte; línea base 49/49)

| Mutante | Cambio | Detectado por |
| --- | --- | --- |
| M1 rol/capacidad | capacidad pedida no comparada con el mapeo | X1, X2, I03, I04, M02, L03 |
| M2 realm | realm de la identidad no comparado | I05 |
| M3 CAS del lease | `expectedVersion` no comparada | L05, X5 |
| M4 legal hold | `legalHold: true` ignorado | R04, X6 |
| M5 verificación de evidencia | eco de realm/referencia no comparado | E04, X7 |
| M6 SoD (extra) | cualquier decisión tratada como `permit` | S01, S03 |

## Ajuste intencional a pruebas previas

BE13-07A V1: lista cerrada de exportaciones de placeholders + `createBlockingSecurityPolicies`.
