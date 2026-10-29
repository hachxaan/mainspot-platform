# MainSpot — Handoff E2E paralelo (2026-10-29)

**Estado:** AUTORIZADO PARA DESARROLLO · NO es producción.  
**Repositorio:** `hachxaan/mainspot-platform` · **Rama:** `feat/canonflow-implementation`.

La instrucción más reciente del propietario reemplaza el modelo de ejecución secuencial de *diseñar → esperar aprobación → programar* **solo para este ciclo de desarrollo**. **SOL MAIN y Claude Design trabajan simultáneamente y finalizan todo su alcance E2E sin crear ni esperar sesiones HDC**. Documentan decisiones de ingeniería en un registro corto; no alteran DEC históricos ni se detienen por revisiones estéticas. Si una API externa requiere credenciales o aprobación de plataforma ausente, cerrar el flujo E2E contra un simulador, sin fingir que la integración real funciona.

## Leer primero

1. [Autorización del propietario y límites](OWNER-AUTHORIZATION.md)
2. [Contrato compartido de comportamiento y teléfonos](SHARED-CONTRACT.md)
3. [Handoff SOL MAIN — backend y frontend integrado](LOCAL-E2E.md)
4. [Handoff Claude Design — UX/UI](../../ux/claude-design/ITERATION-2-E2E-HANDOFF.md)
5. [Registro de decisiones de desarrollo](DECISION-LOG.md)

## Estado verificado en la rama base (antes de este handoff)

- **Existe:** identidad, tenant/RBAC/auditoría, flujo conversacional con preview, web simulada, reseñas de Google simuladas con tres sugerencias/aprobación, publicaciones/Ads básicos de Facebook simulados y programación, suscripciones y analítica.
- **Falta para el objetivo:** observación continua sin navegador, ingestión/respuesta a comentarios de Facebook, políticas por negocio con opt-in y ejecución automática limitada, caso/aviso unificado en panel y Telegram, número configurable independiente por integración, gestión de ficha Google Maps/Business Profile, alta e inicio de sesión sin tenant_id e integración frontend final.
- La configuración telefónica **NO** usa un único «otro número»: cada integración `website`, `google_business_profile` y `facebook` almacena su propio override opcional, independientemente de las demás. Si todas eligen «Otro número», **los tres pueden ser distintos**.
- La publicación pública real mediante proveedores no está demostrada: `src/reputation/google.ts` y `src/social/meta.ts` son adaptadores parciales, sin certificación E2E externa.
- **No tocar:** `QS-0015`, Gate 7, Garage/KVM4 ni productor de respaldo; siguen separados y desactivados.

## Paralelismo sin dependencia circular

| Frente | Archivos propios | Objetivo |
|---|---|---|
| **SOL MAIN / local** | `src/`, `migrations/`, `tests/`, archivos frontend integrados, este handoff (bitácora) | Extensiones mínimas de backend + API + worker + integración funcional E2E + pruebas. |
| **Claude Design** | `docs/ux/claude-design/**` | UX/UI E2E navegable, assets, interacciones, pantallas de agente, Google, Facebook y teléfonos, QA/reportes. |

Claude trabaja con fixtures basados en [SHARED-CONTRACT.md](SHARED-CONTRACT.md); SOL MAIN define rutas finales y publica un esquema simple al concretarlas. **Nadie espera al otro para comenzar.** SOL MAIN incorpora la entrega del diseñador cuando esté lista, sin alterar su fuente por cambios silenciosos; si aún no llega, deja el frontend integrado técnicamente funcional con UI mínima y pruebas. Claude no bloquea diseño por falta de backend.

## E2E terminado cuando

1. Alta/entrada → panel → teléfono principal → 3 configuraciones independientes → integración visible por canal, todo persistido y aislado por negocio.
2. Web: solicitar cambio → vista previa → aprobación del cliente → publicación/versión de desarrollo.
3. Google: nueva reseña → evaluación de política → respuesta simulada autorizada **o** caso humano con tres alternativas y aviso Telegram; ficha/ubicación simulada editable dentro de lo permitido.
4. Facebook: publicación programada → comentario entrante → misma evaluación → respuesta simulada autorizada **o** caso humano; idempotencia real.
5. Worker procesa sin que el navegador esté abierto; reinicia, reconcilia, no duplica y recupera fallos.
6. Panel/Telegram muestran las **mismas** excepciones; teléfono público por canal no equivale a destino de Telegram.
7. Tests E2E, aislamiento, seguridad y accesibilidad reportados con PASS/FAIL **real**, commits y links de evidencia. Ningún resultado simulado se reporta como envío real a Google/Meta.

**Sin solicitudes de aprobación al propietario para pasos de desarrollo.** Solo el propietario declarará una futura puesta en producción; esta tarea no lo hace.
