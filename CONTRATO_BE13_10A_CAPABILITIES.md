# BE13-10A — Contrato de mapeo de capacidades y separación de funciones

## Mapeo (`OperatorCapabilityMappingPolicy`)

```ts
map({ realm, identity }): Promise<
  | { status: 'mapped'; realm; capabilities: OperatorCapability[]; policyRevision: number }
  | { status: 'denied'; realm; reason: 'unknown-identity' | 'no-capability' }>
```

- Entrada: solo la identidad devuelta por el proveedor (atributos confiables). Nunca la credencial.
- Capacidades: vocabulario cerrado de BE13-09 (8). Una capacidad desconocida, duplicada o una lista de más de 8 invalida **todo** el mapeo (M04).
- `mapped` con lista vacía → `forbidden` (M02). Realm distinto del bundle → `forbidden` (M05).
- La capacidad pedida debe estar en la lista mapeada (mutante M1).
- No hay roles en el código. El nombre de los atributos (`group`, `role`, etc.) y su correspondencia con capacidades los define la política inyectada.
- Default: placeholder → `denied` (`unknown-identity`).

## Separación de funciones (`SeparationOfDutiesPolicy`)

```ts
evaluate({ realm, operatorId, capabilities, requestedCapability }): Promise<
  | { realm; decision: 'permit'; policyRevision }
  | { realm; decision: 'conflict'; conflictingCapabilities; policyRevision }>
```

- Solo un `permit` explícito para el realm del bundle permite continuar. `conflict`, respuesta malformada, realm ajeno, excepción o timeout → `separation-of-duties` (S01, S04). En el puerto de BE13-09 se traduce a `forbidden`.
- **SoD estático**: evalúa la combinación de capacidades que el operador TIENE. Un conflicto deniega todas sus operaciones (supuesto conservador).
- **SoD dinámico** (p. ej., quien desbloqueó una entrada no la descarta) no se modela: requiere historial de audit y reglas aprobadas.
- Default: placeholder → `conflict` para todo (S03).

## Ejemplos a evaluar (NO son reglas aprobadas)

| Combinación | Pregunta para el responsable |
| --- | --- |
| `QUARANTINE_UNBLOCK` + `QUARANTINE_DISCARD` | ¿Quien desbloquea puede también descartar? |
| `QUARANTINE_REPLAY` + `QUARANTINE_RESOLVE` | ¿Quien reprocesa puede declarar la resolución? |
| `AUDIT_VIEW` + cualquier capacidad de escritura | ¿La auditoría requiere un rol separado? |

Las pruebas usan la exclusión sintética `UNBLOCK`+`DISCARD` solo para ejercitar el mecanismo.
