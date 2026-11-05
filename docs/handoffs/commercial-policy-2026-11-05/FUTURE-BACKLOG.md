# Backlog FUTURO separado del cierre comercial (registro de plataforma)

Este archivo conserva en la plataforma, **sin implementarlos**, los requisitos futuros decididos o pospuestos el
2026-11-05 (SRC-0014 F01–F08; DEC-0076 «Qué no decide»). No forman parte del incremento de cuotas de
`feat/commercial-quota-semantics-20261105` ni de su PR.

- Origen: `hachxaan/mainspot-documentation@docs/commercial-governance-20261105`, commit `0a7188a`,
  `docs/staging/FUTURE-2026-11-05-roadmap-decisions.md` (sha256
  `83fb863404ed7368b34069a45a182debc39b033aee1e7ac6c293e25eb809a28a`). Es staging documental, no canon publicado.
- **FUT-01 (voz por Telegram) es mandatoria en la próxima ronda de producto** (SRC-0014 F05). Necesita su propio
  incremento con transcripción, aclaración ante ambigüedad, confirmación de actos sensibles, la misma gobernanza que el
  texto, privacidad y pruebas reales del bot y del webhook autorizados (`docs/architecture/telegram-webhook-starlink.md`:
  la entrega real sigue sin verificar). Nada de eso se adelanta aquí.
- Relación con el incremento actual: FUT-04/FUT-06 (complementos y recargas prepagadas) reutilizarían el libro de
  cuotas y la cuota mensual `ai_review_replies`; FUT-09 (cortesías durante impago) depende de C09, hoy bloqueada.

---

# FUTURO — MainSpot, decisiones de 2026-11-05

Fuente: SRC-005. Estado: backlog en preparación; no es canon publicado.

## Mandatorio en próxima ronda de producto
**FUT-01 Voz por Telegram.** El usuario podrá enviar audios con instrucciones. El sistema transcribirá, interpretará y solicitará aclaración si detecta incertidumbre. La ejecución de acciones sensibles conservará confirmaciones, permisos, privacidad y trazabilidad, compartiendo el mismo flujo que los mensajes de texto. Necesita pruebas reales del bot y webhook autorizados antes de declarar integración verificada.

## Decisiones pospuestas
- **FUT-02** Vista previa de publicaciones Facebook en Telegram: imagen + descripción con emojis, opciones de aprobar o ajustar.
- **FUT-03** Vista previa de cambios a página web en Telegram: captura tomada de una versión auténtica de previsualización, no generada imaginariamente.
- **FUT-04** Complementos de capacidad puntuales y recurrentes, comprables al contratar o posteriormente. Precio recurrente preferencial solo si lo justifican los márgenes. Comparar de forma transparente la conveniencia de mejorar de plan.
- **FUT-05** Recomendaciones de capacidad sobre consumo real, comenzando por reglas estadísticas.
- **FUT-06** Recargas automáticas prepagadas, activación voluntaria y topes definidos por el cliente; nunca automáticas por defecto.

## Ideas sin exclusividad aprobada
- **FUT-07** Chatbot en página como posible diferenciador del plan C.
- **FUT-08** Integración futura de WhatsApp y nuevas capacidades.
- **FUT-09** Cortesías limitadas de IA durante fallos de cobro para clientes con historial favorable, condicionadas a métricas de retención y costo.

## Disparadores para retomar
FUT-01: siguiente incremento de producto de voz/Telegram. FUT-02/03: incremento específico de UX previsualización. FUT-04/06: modelo de cobro, cuotas e idempotencia seguro y justificación económica. FUT-05: volumen suficiente de datos históricos. FUT-07/08: disponibilidad técnica y propuesta de valor comprobable. FUT-09: evidencia económica sobre retención.

Toda propuesta termina aprobada, modificada, descartada o pospuesta con condición identificable. La mera compatibilidad arquitectónica no autoriza desarrollo anticipado.
