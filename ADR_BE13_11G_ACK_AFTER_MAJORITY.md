# ADR BE13-11G — Ningún veredicto `duplicate` ni ACK desde datos sin majority

Estado: **aplicado para el pre-check** (cambio mínimo de código); la fila 71 de la matriz de decisiones queda PENDIENTE de confirmación humana.

## Contexto
Una lectura `local` puede ver un claim que sólo el primario tiene (G01). Si ese claim se revierte tras un step-down, un `duplicate` basado en él daría el evento por manejado.

## Decisión
1. El pre-check de idempotencia (sin sesión) lee con `readConcern: majority`.
2. El recibo del inbox ya escribe con `w: majority, j: true` y relee con majority (G3). El ACK MQTT sólo se libera desde un recibo persistido (G4). No cambian.

## Consecuencias
- Sin majority, el pre-check no responde `duplicate`: ve ausente o falla acotado.
- No afecta la limitación broker/sesión de 11F (F-E2), que sigue abierta.

## Alternativas no elegidas
Lectura `linearizable` (más costo, mismo efecto aquí). No cambiar nada (deja abierta la ventana de G01).
