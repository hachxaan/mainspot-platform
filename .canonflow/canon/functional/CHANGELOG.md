# Functional Canon changelog

## 0.2.0-staging — F-01 avisos del productor con acuse (rama feat/f01-telegram-acknowledged-alerts, RUN-0017)

Parche de staging; no aprobado (G-FUN pendiente). Ámbito: canal de avisos del productor de respaldos remotos.

- DECIDED: FR-0012 (entrega en la misma ejecución, sin éxito falso; DEC-0064, DEC-0065, DEC-0061, DEC-0063),
  BR-0007 (confirmación humana solo por acción autenticada; DEC-0065), BR-0008 (el respaldo nunca espera
  al acuse; DEC-0065), NFR-0006 (secretos solo en el equipo de MainSpot; DEC-0064, DEC-0065).
- PROPOSED (mandato de desarrollo SRC-0011 y definición SRC-0012, sin DEC del HDC): FR-0013 (recibo
  verificable ≠ acuse humano), FR-0014 (botón «Confirmar recepción»), FR-0015 (vencimiento, recordatorios
  acotados, atención del operador), NFR-0007 (estado durable local independiente de PostgreSQL).
- Sin CONFLICTED; sin preguntas abiertas que bloqueen el desarrollo offline autorizado. Los PROPOSED solo
  obligan tras G-FUN.
