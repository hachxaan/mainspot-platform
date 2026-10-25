# Technical Canon changelog

## 0.2.0-staging — F-01 avisos con acuse verificable (rama feat/f01-telegram-acknowledged-alerts, RUN-0018)

Parche de staging derivado del funcional 0.2.0-staging; no aprobado (G-TEC pendiente). Todos PROPOSED.

- API-0005 adaptador emisor: clasificación de respuestas, recibo verificable, salidas 0/10–16, botón.
- API-0006 protocolo de acuse: `a1:<event_id>:<HMAC-96>`, único consumidor `getUpdates`, persistir antes del cursor.
- API-0007 registro durable local y máquina de estados.
- API-0008 vencimiento, recordatorios acotados, `--status` y salida 18.
- API-0009 integración con el productor (valores `delivery=`, no reintentar entregas inciertas).
- ADR-0001…ADR-0004 (getUpdates, archivos locales, ejecutable único, entrega incierta).
- TR-0001…TR-0007 riesgos residuales (24 h de updates, mismo bot, token comprometido, duplicado por 5xx,
  HMAC truncado, consumidor parado, reloj).
