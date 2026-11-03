#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
04-unit-economics.py — Modelo económico unitario del MainSpot AI Core (solo stdlib, determinista).

Entregable 04 de research/ai-provider-economics (HANDOFF §6/§7). SIN llamadas a APIs,
SIN secretos, SIN servidores: todo el modelo es cálculo local.

Entradas (leídas de este repositorio, no inventadas):
- evidence/lab-traces.md + lab-invocations.csv (sha256 4b35bab9…): tokens MEDIDOS por
  caso de uso × modelo (vía OpenRouter/TypeSafe, 310 invocaciones del 2026-10-30,
  negocios sintéticos). IMPORTANTE: los tokens medidos YA INCLUYEN las reparaciones
  (el dispatcher paga la conversación completa dos veces cuando repara) — este script
  NO vuelve a aplicarlas; solo las usa en la sensibilidad «reparaciones ×2».
- evidence/anthropic.md §2/§7: precios directos Anthropic verificados 2026-11-03
  (Haiku 5.5 0.10/0.50 ≤100K, caché 5m write 0.125/read 0.01, mín. caché 512,
  Batch −50%; Sonnet 5.5 2/10; Opus 5.5 4/20) y perfiles §7.
- evidence/openai.md §3.2/§7: precios directos OpenAI verificados 2026-11-03
  (Luna 0.10/0.50, cached 0.01, mín. caché 1,024, escritura 1.25×; Terra 1/5;
  Sol 2/10; Batch/Flex −50%; gpt-image-2 por-MTok 5/8/30 y por imagen 1024²
  low 0.006 / medium 0.053 / high 0.211; 1536×1024 medium 0.041; Batch imágenes −50%;
  caché de imagen solo vía Responses API).
- evidence/typesafe-jev.md: Jev 1.14.0 — 0.042 USD/MTok entrada, salida gratis,
  fallos no facturan (mismo precio en todos los mixes).
- evidence/image-providers.md §10/§11: costo por imagen ENTREGADA (reintento k=1.3),
  Nano Banana 2.1 0.0336/img 1K (Batch −50%), Seedream 5.0 flash 0.018.
- evidence/business-inputs.md: FIX 18.7962 (30-oct-2026), IVA 16% (netos
  431.03/862.07/1,724.14 MXN para planes 500/1,000/2,000), PSP Openpay tarjeta
  nacional 2.9% + MXN 2.50 + IVA (la más barata publicada en tarjeta),
  infraestructura ≈ USD 0.07–0.19/cliente/mes (R2+Neon+SES; S3 egress ~30×).
- 01-inventory.md §3 + migrations/0009: cuotas del plan piloto (website 1,
  social_posts 10, social_ads 5, reviews_managed 20, agents 5, conversations 500)
  y mecánica del dispatcher (reparación ≤1, sin fallback de rutas, imágenes n=1).
- src/engagement/service.ts:153,187-190: max_auto_replies_per_hour por defecto 10,
  rango permitido 1–60.

Salidas: 04-unit-economics.csv (una fila por caso de uso × escenario × mix) y un
resumen determinista en stdout. Verificación de reproducibilidad: correr dos veces
y comparar el sha256 del CSV impreso al final.
"""

import csv
import hashlib
import os

BASE = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(BASE, "04-unit-economics.csv")

# ----------------------------------------------------------------------------
# 0. Constantes económicas verificadas
# ----------------------------------------------------------------------------
FIX_MXN_USD = 18.7962          # HECHO VERIFICADO — Banxico FIX 30-oct-2026 (business-inputs §1)
IVA = 0.16                     # HECHO VERIFICADO — tasa general (business-inputs §2.1)
PLANS_MXN = {                  # precios al público CON IVA incluido — HIPÓTESIS de pricing (NO aprobados)
    "500": 500.0,
    "1000": 1000.0,
    "2000": 2000.0,
}
PLAN_NETO_MXN = {p: m / (1 + IVA) for p, m in PLANS_MXN.items()}  # 431.03 / 862.07 / 1,724.14
PSP_PCT, PSP_FIXED, PSP_IVA = 0.029, 2.50, 1.16  # Openpay tarjeta nacional + IVA (business-inputs §3.1)
INFRA_USD_CLIENTE = 0.12       # ESTIMACIÓN base (escala 1,000 clientes; rango medido 0.07–0.19)
IMAGE_RETRY_K = 1.3            # HIPÓTESIS de image-providers §10.1 (regeneraciones por rechazo)

# Precios directos verificados, USD/MTok. batch=(in,out) si el caso lo permite.
PRICES = {
    # Anthropic directo (anthropic.md §2.1) — Haiku en tramo ≤100K
    "haiku":  dict(pin=0.10, pout=0.50, cread=0.01, cwrite=0.125, cmin=512,  batch=(0.05, 0.25)),
    "sonnet": dict(pin=2.00, pout=10.00, cread=0.10, cwrite=2.50, cmin=512,  batch=(1.00, 5.00)),
    # OpenAI directo (openai.md §3.2)
    "luna":   dict(pin=0.10, pout=0.50, cread=0.01, cwrite=0.125, cmin=1024, batch=(0.05, 0.25)),
    "terra":  dict(pin=1.00, pout=5.00, cread=0.05, cwrite=1.25,  cmin=1024, batch=(0.50, 2.50)),
    "sol":    dict(pin=2.00, pout=10.00, cread=0.10, cwrite=2.50, cmin=1024, batch=(1.00, 5.00)),
    # TypeSafe/Jev directo (typesafe-jev.md §3.1) — sin caché, sin batch
    "jev":    dict(pin=0.042, pout=0.0, cread=None, cwrite=None, cmin=None,  batch=None),
}
# Imágenes (precio por imagen generada, sin reintento). "batch" si está documentado.
IMAGE_PRICES = {
    "gpt-image-2-web":    dict(base=0.041, batch=0.0205, modelo="gpt-image-2 1536×1024 medium"),   # openai.md §1.4
    "gpt-image-2-social": dict(base=0.053, batch=0.0265, modelo="gpt-image-2 1024² medium"),
    "nano-banana-web":    dict(base=0.0336, batch=0.0168, modelo="gemini-nano-banana-2.1 1K 16:9"), # image-providers §2.1
    "nano-banana-social": dict(base=0.0336, batch=0.0168, modelo="gemini-nano-banana-2.1 1K 1:1"),
    "seedream-social":    dict(base=0.018, batch=None, modelo="dola-seedream-5-0-flash"),           # image-providers §4.1
}
PROMPT_TOKENS_IMG = 150        # openai.md §7.1: prompt de texto ≈150 tokens (gpt-image-2 cobra texto in $5/M)
P_TEXT_IMG = 5.0 / 1e6

# ----------------------------------------------------------------------------
# 1. Perfiles de tokens MEDIDOS (lab-traces.md; in/out por invocación exitosa,
#    YA incluyen reparaciones) y tasas de reparación medidas
# ----------------------------------------------------------------------------
MEASURED = {  # (use_case, modelo) -> (tokens_in, tokens_out)
    ("business.insights.generate", "haiku"): (2135, 677),
    ("business.insights.generate", "luna"): (712, 404),
    ("conversation.owner.assistant", "haiku"): (4729, 427),
    ("conversation.owner.assistant", "luna"): (2096, 293),
    ("editorial.calendar.suggest", "luna"): (1767, 1860),
    ("engagement.facebook.comment.reply", "haiku"): (1287, 249),
    ("engagement.facebook.comment.reply", "luna"): (621, 189),
    ("engagement.google.review.reply", "haiku"): (1315, 203),
    ("engagement.google.review.reply", "luna"): (645, 182),
    ("marketing.campaign.creatives", "haiku"): (4243, 2067),
    ("marketing.campaign.creatives", "luna"): (1580, 760),
    ("marketing.campaign.plan", "haiku"): (5475, 2864),
    ("marketing.campaign.plan", "luna"): (1105, 1072),
    ("social.facebook.post.compose", "haiku"): (4424, 2550),
    ("social.facebook.post.compose", "luna"): (1776, 745),
    ("website.edit.complex", "luna"): (2202, 958),
    ("website.edit.simple", "luna"): (1735, 202),
    ("website.initial.design", "haiku"): (4029, 3396),
    ("website.initial.design", "luna"): (1608, 2033),
}
JEV_TOKENS_IN = {  # MEDIDOS, salida gratuita
    "conversation.intent.classify": 804,
    "engagement.facebook.comment.classify": 1158,
    "engagement.google.review.classify": 1158,
}
# P(éxito necesitó reparación) MEDIDA. Los tokens ya la incluyen; se usa solo para sensibilidad.
P_REPAIR = {
    ("business.insights.generate", "haiku"): 0.50,
    ("business.insights.generate", "luna"): 0.25,
    ("editorial.calendar.suggest", "luna"): 0.80,
    ("marketing.campaign.creatives", "haiku"): 0.75,
    ("marketing.campaign.creatives", "luna"): 0.50,
    ("marketing.campaign.plan", "haiku"): 1.00,
    ("marketing.campaign.plan", "luna"): 0.17,
    ("social.facebook.post.compose", "haiku"): 0.80,
    ("social.facebook.post.compose", "luna"): 0.67,
    ("website.edit.complex", "luna"): 0.12,
}
# Latencia p50/p95 medida sobre éxitos (ms), lab-traces.
LAT = {
    ("business.insights.generate", "haiku"): (3693, 9342),
    ("business.insights.generate", "luna"): (3679, 7922),
    ("conversation.owner.assistant", "haiku"): (7383, 12204),
    ("conversation.owner.assistant", "luna"): (3310, 13186),
    ("editorial.calendar.suggest", "luna"): (16307, 18864),
    ("engagement.facebook.comment.reply", "haiku"): (2122, 3999),
    ("engagement.facebook.comment.reply", "luna"): (2483, 3782),
    ("engagement.google.review.reply", "haiku"): (1228, 3543),
    ("engagement.google.review.reply", "luna"): (1974, 3992),
    ("marketing.campaign.creatives", "haiku"): (10207, 19939 - 740),  # 10,207 / 19,199
    ("marketing.campaign.creatives", "luna"): (5804, 8620),
    ("marketing.campaign.plan", "haiku"): (15160, 15160),
    ("marketing.campaign.plan", "luna"): (7746, 9648),
    ("social.facebook.post.compose", "haiku"): (13129, 18761),
    ("social.facebook.post.compose", "luna"): (5926, 8781),
    ("website.edit.complex", "luna"): (6091, 18979),
    ("website.edit.simple", "luna"): (2857, 14119),
    ("website.initial.design", "haiku"): (17105, 23250),
    ("website.initial.design", "luna"): (13415, 15266),
    ("conversation.intent.classify", "jev"): (729, 866),
    ("engagement.facebook.comment.classify", "jev"): (750, 919),
    ("engagement.google.review.classify", "jev"): (763, 966),
}

# Perfiles de §7 (anthropic.md §7.1) para casos SIN medición del modelo del mix.
PROFILE_V7 = {
    ("website.edit.simple", "haiku"): (5000, 600),     # ESTIMACIÓN §7.1 (esquema aplanado ≤16 uniones)
    ("website.edit.complex", "haiku"): (7000, 3500),   # ESTIMACIÓN §7.1
}
PROXY_COMPOSE_HAIKU = MEASURED[("social.facebook.post.compose", "haiku")]  # proxy calendario (caso medido más cercano)
RATIO_TOKENS_MEDIO = "ESTIMACIÓN: se aplican los tokens medidos del modelo más cercano (factor 1.0); el modelo del mix NO fue medido"

# ----------------------------------------------------------------------------
# 2. Casos de uso y control de abuso (cuotas plan piloto migrations/0009 +
#    max_auto_replies_per_hour=10 por defecto, rango 1–60)
# ----------------------------------------------------------------------------
CASES = [
    # (use_case_id, modalidad, control_techo_documentado)
    ("website.initial.design", "texto+imagen", "cuota plan website=1 (0009); ALTO=1 diseño+1 rediseño; ABUSO=rediseño quincenal (3)"),
    ("website.edit.simple", "texto", "sin cuota mensual explícita; peticiones del dueño acotadas por rate limits del plano"),
    ("website.edit.complex", "texto", "idem edit.simple; rediseños contados"),
    ("conversation.intent.classify", "clasificación", "1 por job de edición (1:1 con ediciones)"),
    ("website.image.generate", "imagen", "≤4 slots por diseño (design.ts); MEDIO=4 slots del diseño"),
    ("social.facebook.post.compose", "texto", "cuota plan social_posts=10 (0009); ABUSO=10 publicadas + 20 intentos que consumen IA antes del chequeo near-duplicate/cuota (HIPÓTESIS de acotamiento)"),
    ("social.facebook.image.generate", "imagen", "solo publicaciones con imagen; tope cuota social_posts=10 (0009)"),
    ("engagement.facebook.comment.classify", "clasificación", "techo técnico max_auto_replies_per_hour=10 × 720 h = 7,200/mes; ABUSO acotado a 750/mes (25/día); clasifica todo comentario entrante"),
    ("engagement.facebook.comment.reply", "texto", "techo técnico max_auto_replies_per_hour=10 × 720 h = 7,200/mes; solo safe_auto_reply; ABUSO acotado a 600/mes (20/día)"),
    ("engagement.google.review.classify", "clasificación", "cuota plan reviews_managed=20 (0009); ABUSO=60 (3× cuota; el excedente queda bloqueado)"),
    ("engagement.google.review.reply", "texto", "idem reviews_managed=20"),
    ("conversation.owner.assistant", "texto+tools", "cuota plan conversations=500 (0009); cada pregunta = 1 invocación"),
    ("marketing.campaign.plan", "texto", "cuota plan agents=5 (0009)"),
    ("marketing.campaign.creatives", "texto", "encadenado al plan (misma clave idempotencia); cuota agents=5"),
    ("business.insights.generate", "texto", "abstención gratuita con <7 días de actividad; ABUSO=1/día"),
    ("editorial.calendar.suggest", "texto", "acotado por aprobación humana del calendario"),
]
CASE_MODALITY = {c: m for c, m, _ in CASES}
CASE_CONTROL = {c: ctl for c, _, ctl in CASES}

# Frecuencias mensuales por cliente — HIPÓTESIS calibradas contra las cuotas del
# plan piloto (cada cota cita su control en CASES y se justifica en el MD).
SCENARIOS = {
    "BAJO": {
        "website.initial.design": 0.25, "website.edit.simple": 2, "website.edit.complex": 0.25,
        "conversation.intent.classify": 2, "website.image.generate": 2,
        "social.facebook.post.compose": 4, "social.facebook.image.generate": 1,
        "engagement.facebook.comment.classify": 10, "engagement.facebook.comment.reply": 8,
        "engagement.google.review.classify": 5, "engagement.google.review.reply": 4,
        "conversation.owner.assistant": 20, "marketing.campaign.plan": 0.25,
        "marketing.campaign.creatives": 0.25, "business.insights.generate": 1,
        "editorial.calendar.suggest": 0.25,
    },
    "MEDIO": {
        "website.initial.design": 1, "website.edit.simple": 5, "website.edit.complex": 1,
        "conversation.intent.classify": 5, "website.image.generate": 4,
        "social.facebook.post.compose": 8, "social.facebook.image.generate": 3,
        "engagement.facebook.comment.classify": 40, "engagement.facebook.comment.reply": 30,
        "engagement.google.review.classify": 12, "engagement.google.review.reply": 10,
        "conversation.owner.assistant": 100, "marketing.campaign.plan": 1,
        "marketing.campaign.creatives": 1, "business.insights.generate": 4,
        "editorial.calendar.suggest": 1,
    },
    "ALTO": {
        "website.initial.design": 2, "website.edit.simple": 10, "website.edit.complex": 2,
        "conversation.intent.classify": 10, "website.image.generate": 8,
        "social.facebook.post.compose": 10, "social.facebook.image.generate": 5,
        "engagement.facebook.comment.classify": 100, "engagement.facebook.comment.reply": 80,
        "engagement.google.review.classify": 20, "engagement.google.review.reply": 20,
        "conversation.owner.assistant": 300, "marketing.campaign.plan": 2,
        "marketing.campaign.creatives": 2, "business.insights.generate": 8,
        "editorial.calendar.suggest": 2,
    },
    "ABUSO": {
        "website.initial.design": 3, "website.edit.simple": 20, "website.edit.complex": 4,
        "conversation.intent.classify": 20, "website.image.generate": 12,
        "social.facebook.post.compose": 30, "social.facebook.image.generate": 10,
        "engagement.facebook.comment.classify": 750, "engagement.facebook.comment.reply": 600,
        "engagement.google.review.classify": 60, "engagement.google.review.reply": 60,
        "conversation.owner.assistant": 500, "marketing.campaign.plan": 5,
        "marketing.campaign.creatives": 5, "business.insights.generate": 30,
        "editorial.calendar.suggest": 4,
    },
}

# Casos NO interactivos elegibles para Batch (−50%); nunca respuestas/comentarios/asistente.
BATCH_ELIGIBLE = {"marketing.campaign.plan", "business.insights.generate", "editorial.calendar.suggest"}
# Caché de prefijo (HIPÓTESIS): 70% del input cacheable en asistente y diseño; 0% en clasificación
# de un solo turno; los demás casos NO se modelan con caché (0%).
CACHE_FRACTION = {"conversation.owner.assistant": 0.70, "website.initial.design": 0.70}

# ----------------------------------------------------------------------------
# 3. Mixes de proveedor (en papel; precios directos verificados)
# ----------------------------------------------------------------------------
# fuente: MEDIDA | PERFIL§7 | PROXY (con factor y modelo de origen)
MIXES = {
    "MIX-DEV": {   # DEC-0073 (desarrollo): OpenAI Sol/Luna + gpt-image-2 + Jev
        "website.initial.design": ("sol", "luna", RATIO_TOKENS_MEDIO),   # candidata Sol (cat. 0.25)
        "website.edit.complex": ("sol", "luna", RATIO_TOKENS_MEDIO),     # candidata Sol (cat. 0.2)
        "website.edit.simple": ("luna", "luna", "MEDIDA lab-traces (incluye reparaciones)"),
        "social.facebook.post.compose": ("luna", "luna", "MEDIDA lab-traces (incluye reparaciones)"),
        "marketing.campaign.creatives": ("luna", "luna", "MEDIDA lab-traces (incluye reparaciones)"),
        "marketing.campaign.plan": ("luna", "luna", "MEDIDA lab-traces (incluye reparaciones)"),
        "business.insights.generate": ("luna", "luna", "MEDIDA lab-traces (incluye reparaciones)"),
        "conversation.owner.assistant": ("luna", "luna", "MEDIDA lab-traces (incluye reparaciones)"),
        "engagement.facebook.comment.reply": ("luna", "luna", "MEDIDA lab-traces (incluye reparaciones)"),
        "engagement.google.review.reply": ("luna", "luna", "MEDIDA lab-traces (incluye reparaciones)"),
        "editorial.calendar.suggest": ("luna", "luna", "MEDIDA lab-traces (incluye reparaciones)"),
        "website.image.generate": ("gpt-image-2-web", None, "HECHO VERIFICADO openai.md §1.4 (por imagen); NO MEDIDO en uso real"),
        "social.facebook.image.generate": ("gpt-image-2-social", None, "HECHO VERIFICADO openai.md §1.4; NO MEDIDO en uso real"),
    },
    "MIX-CANON": {  # DEC-0069: Anthropic Haiku/Sonnet + gpt-image-2 + Jev
        "website.initial.design": ("sonnet", "haiku", "PROXY: tokens medidos de Haiku ×1.0 (mismo tokenizador; Sonnet 0 éxitos por guardrail — NO MEDIDO)"),
        "website.edit.simple": ("haiku", "haiku", "PERFIL §7 anthropic.md (5,000/600) — sin éxitos Haiku en lab (bad_request 17 uniones); esquema aplanado asumido"),
        "website.edit.complex": ("haiku", "haiku", "PERFIL §7 anthropic.md (7,000/3,500) — idem"),
        "social.facebook.post.compose": ("haiku", "haiku", "MEDIDA lab-traces (incluye reparaciones)"),
        "marketing.campaign.creatives": ("haiku", "haiku", "MEDIDA lab-traces (incluye reparaciones)"),
        "marketing.campaign.plan": ("haiku", "haiku", "MEDIDA lab-traces (incluye reparaciones; 1.00 tasa de reparación)"),
        "business.insights.generate": ("haiku", "haiku", "MEDIDA lab-traces (incluye reparaciones)"),
        "conversation.owner.assistant": ("haiku", "haiku", "MEDIDA lab-traces (incluye reparaciones)"),
        "engagement.facebook.comment.reply": ("haiku", "haiku", "MEDIDA lab-traces (incluye reparaciones)"),
        "engagement.google.review.reply": ("haiku", "haiku", "MEDIDA lab-traces (incluye reparaciones)"),
        "editorial.calendar.suggest": ("haiku", "haiku", "PROXY: tokens medidos de compose Haiku (caso medido más cercano; probable sobreestimación)"),
        "website.image.generate": ("gpt-image-2-web", None, "HECHO VERIFICADO openai.md §1.4 (DEC-0069 imágenes OpenAI)"),
        "social.facebook.image.generate": ("gpt-image-2-social", None, "HECHO VERIFICADO openai.md §1.4 (DEC-0069 imágenes OpenAI)"),
    },
    "MIX-OPT": {   # optimización en papel: Terra/Luna + Nano Banana/Seedream + Jev
        "website.initial.design": ("terra", "luna", RATIO_TOKENS_MEDIO),
        "website.edit.complex": ("terra", "luna", RATIO_TOKENS_MEDIO),
        "marketing.campaign.plan": ("terra", "luna", RATIO_TOKENS_MEDIO),
        "website.edit.simple": ("luna", "luna", "MEDIDA lab-traces (incluye reparaciones)"),
        "social.facebook.post.compose": ("luna", "luna", "MEDIDA lab-traces (incluye reparaciones)"),
        "marketing.campaign.creatives": ("luna", "luna", "MEDIDA lab-traces (incluye reparaciones)"),
        "business.insights.generate": ("luna", "luna", "MEDIDA lab-traces (incluye reparaciones)"),
        "conversation.owner.assistant": ("luna", "luna", "MEDIDA lab-traces (incluye reparaciones)"),
        "engagement.facebook.comment.reply": ("luna", "luna", "MEDIDA lab-traces (incluye reparaciones)"),
        "engagement.google.review.reply": ("luna", "luna", "MEDIDA lab-traces (incluye reparaciones)"),
        "editorial.calendar.suggest": ("luna", "luna", "MEDIDA lab-traces (incluye reparaciones)"),
        "website.image.generate": ("nano-banana-web", None, "HECHO VERIFICADO image-providers §2.1 (requeriría nueva cuenta Gemini: decisión del propietario)"),
        "social.facebook.image.generate": ("seedream-social", None, "HECHO VERIFICADO image-providers §4.1 (términos BytePlus SIN VERIFICAR — bloqueante DEC-0067)"),
    },
}
JEV_CASES = {"conversation.intent.classify", "engagement.facebook.comment.classify", "engagement.google.review.classify"}


def profile_for(case, mix):
    """Devuelve (modelo, tokens_in, tokens_out, fuente) para un caso de texto/clasificación."""
    if case in JEV_CASES:
        return "jev", JEV_TOKENS_IN[case], None, "MEDIDA lab-traces (TypeSafe directo; fallos no facturan)"
    modelo, modelo_medido, fuente = MIXES[mix][case]
    key = (case, modelo_medido)
    if key in MEASURED:
        t_in, t_out = MEASURED[key]
        return modelo, t_in, t_out, fuente
    if key in PROFILE_V7:
        t_in, t_out = PROFILE_V7[key]
        return modelo, t_in, t_out, fuente
    if key == ("editorial.calendar.suggest", "haiku"):
        t_in, t_out = PROXY_COMPOSE_HAIKU
        return modelo, t_in, t_out, fuente
    raise KeyError(f"Sin perfil para {case}/{modelo}")


def text_unit_cost(modelo, t_in, t_out, batch=False, cache=0.0):
    """Costo USD de una invocación de texto. cache = fracción del input leída de caché.
    Regimen estacionario (sin cargo de escritura); la escritura única se reporta aparte."""
    pr = PRICES[modelo]
    pin, pout = pr["batch"] if (batch and pr["batch"]) else (pr["pin"], pr["pout"])
    cread = pr["cread"] if (batch and pr["batch"]) else pr["cread"]
    if cread is None:  # Jev: solo entrada facturada
        return t_in * pr["pin"] / 1e6
    cacheable = cache * t_in
    if pr["cmin"] is not None and cacheable > 0 and cacheable < pr["cmin"]:
        cache = 0.0  # por debajo del mínimo cacheable
        cacheable = 0.0
    cost = ((t_in - cacheable) * pin + cacheable * (cread if cread is not None else pin)) / 1e6
    cost += (t_out or 0.0) * pout / 1e6
    return cost


def cache_write_surcharge(modelo, t_in, cache):
    """Sobrecoste ÚNICO de la primera escritura de caché (regimen 5min/30min)."""
    pr = PRICES[modelo]
    if pr["cwrite"] is None:
        return 0.0
    cacheable = cache * t_in
    if pr["cmin"] is not None and cacheable < pr["cmin"]:
        return 0.0
    return cacheable * (pr["cwrite"] - pr["pin"]) / 1e6


def image_unit_cost(im_key, mix, batch=False):
    pr = IMAGE_PRICES[im_key]
    base = pr["batch"] if (batch and pr["batch"] is not None) else pr["base"]
    cost = base
    if im_key.startswith("gpt-image-2"):  # solo gpt-image-2 factura el prompt de texto (5 USD/M)
        cost += PROMPT_TOKENS_IMG * P_TEXT_IMG * (0.5 if batch else 1.0)
    return cost * IMAGE_RETRY_K


def case_unit_cost(case, mix, batch=False):
    """(costo_usd, modelo_display, t_in, t_out, fuente, cache_frac, lat) por evento."""
    if case in JEV_CASES:
        _, t_in, t_out, fuente = profile_for(case, mix)
        return text_unit_cost("jev", t_in, t_out), "jev-1.14.0", t_in, t_out, fuente, 0.0, LAT.get((case, "jev"))
    if CASE_MODALITY[case] == "imagen":
        im_key = MIXES[mix][case][0]
        return (image_unit_cost(im_key, mix, batch), IMAGE_PRICES[im_key]["modelo"], None, None,
                MIXES[mix][case][2], 0.0, None)
    modelo, t_in, t_out, fuente = profile_for(case, mix)
    cache = CACHE_FRACTION.get(case, 0.0)
    lat_key = (case, modelo)
    if lat_key not in LAT:
        lat_key = (case, "luna") if modelo in ("sol", "terra") else (case, "haiku")
    return (text_unit_cost(modelo, t_in, t_out, batch=batch),
            modelo, t_in, t_out, fuente, cache, LAT.get(lat_key))


# ----------------------------------------------------------------------------
# 4. Ejecución del modelo y escritura del CSV
# ----------------------------------------------------------------------------
def fmt(x, nd=6):
    if x is None:
        return ""
    return f"{x:.{nd}f}"


def r9(x):
    """Redondeo a 9 decimales para eliminar ruido de punto flotante sin perder magnitud."""
    return None if x is None else round(x, 9)


def main():
    rows = []
    monthly = {}   # (mix, escenario) -> total USD std
    monthly_b = {}  # variante Batch aplicada a elegibles
    for mix in sorted(MIXES):
        for escenario in ["BAJO", "MEDIO", "ALTO", "ABUSO"]:
            total = total_b = 0.0
            for case, _mod, _ctl in CASES:
                freq = SCENARIOS[escenario][case]
                if freq == 0:
                    continue
                unit, modelo, t_in, t_out, fuente, cache, lat = case_unit_cost(case, mix, batch=False)
                unit_b = case_unit_cost(case, mix, batch=True)[0] if case in BATCH_ELIGIBLE else None
                cost, cost_b = unit * freq, (unit_b * freq if unit_b is not None else None)
                total += cost
                total_b += cost_b if cost_b is not None else cost
                if case in JEV_CASES:
                    pr_rep = 0.0   # TypeSafe: sin reparación; fallos no facturan
                elif CASE_MODALITY[case] == "imagen":
                    pr_rep = None  # sin reparación en imágenes (dispatcher); reintento modelado con k=1.3
                else:
                    pr_rep = P_REPAIR.get((case, modelo), 0.0)  # solo si hay MEDICIÓN del modelo resuelto
                rows.append({
                    "mix_id": mix, "use_case_id": case, "escenario": escenario,
                    "modelo": modelo,
                    "tokens_in": "" if t_in is None else int(t_in),
                    "tokens_out": "" if t_out is None else int(t_out),
                    "unidad": "invocación" if CASE_MODALITY[case] != "imagen" else "imagen",
                    "fuente_perfil": fuente,
                    "frecuencia_mensual": freq,
                    "p_repair_medida": pr_rep,
                    "costo_unitario_usd": r9(unit),
                    "costo_unitario_cache_usd": r9(text_unit_cost(modelo, t_in, t_out, cache=cache) if (case not in JEV_CASES and CASE_MODALITY[case] != "imagen" and cache > 0) else None),
                    "costo_unitario_batch_usd": r9(unit_b),
                    "costo_mensual_usd": r9(cost),
                    "costo_mensual_batch_usd": r9(cost_b),
                    "costo_mensual_mx": r9(cost * FIX_MXN_USD),
                    "latencia_p50_ms": lat[0] if lat else None,
                    "latencia_p95_ms": lat[1] if lat else None,
                    "control_techo": CASE_CONTROL[case],
                    "nota_reparaciones": "los tokens medidos YA incluyen reparaciones — no se duplican",
                })
            monthly[(mix, escenario)] = total
            monthly_b[(mix, escenario)] = total_b

    with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    with open(CSV_PATH, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()

    # ---- Resumen stdout (determinista) ----
    L = []
    L.append("== Costo IA por cliente/mes por escenario × mix (USD; MXN al FIX %.4f) ==" % FIX_MXN_USD)
    for mix in sorted(MIXES):
        for esc in ["BAJO", "MEDIO", "ALTO", "ABUSO"]:
            t, tb = monthly[(mix, esc)], monthly_b[(mix, esc)]
            L.append(f"{mix:9s} {esc:6s} std ${t:8.4f}  (MXN {t*FIX_MXN_USD:9.2f})   con-Batch-en-elegibles ${tb:8.4f}  (MXN {tb*FIX_MXN_USD:9.2f})")
    L.append("")
    L.append("== Costo unitario por caso de uso × mix (USD/evento, escenario MEDIO) ==")
    for mix in sorted(MIXES):
        for case, _m, _c in CASES:
            unit, modelo, t_in, t_out, fuente, cache, _lat = case_unit_cost(case, mix)
            ucache = text_unit_cost(modelo, t_in, t_out, cache=cache) if cache > 0 else None
            ub = case_unit_cost(case, mix, batch=True)[0] if case in BATCH_ELIGIBLE else None
            L.append(f"{mix:9s} {case:38s} {modelo:14s} unit ${unit:.6f}"
                     + (f"  cache ${ucache:.6f}" if ucache is not None else "")
                     + (f"  batch ${ub:.6f}" if ub is not None else ""))
    L.append("")
    L.append("== Margen bruto por plan (USD; neto − PSP Openpay nacional − infra %.2f − IA std) ==" % INFRA_USD_CLIENTE)
    for plan, precio in sorted(PLANS_MXN.items(), key=lambda kv: float(kv[0])):
        neto_usd = PLAN_NETO_MXN[plan] / FIX_MXN_USD
        psp_mxn = (PSP_PCT * precio + PSP_FIXED) * PSP_IVA
        psp_usd = psp_mxn / FIX_MXN_USD
        L.append(f"Plan MXN {plan}: neto ${neto_usd:7.3f}  PSP ${psp_usd:5.3f}")
        for mix in sorted(MIXES):
            for esc in ["BAJO", "MEDIO", "ALTO", "ABUSO"]:
                ia = monthly[(mix, esc)]
                margen = neto_usd - psp_usd - INFRA_USD_CLIENTE - ia
                L.append(f"   {mix:9s} {esc:6s} IA ${ia:7.4f} → margen ${margen:7.3f} ({margen/neto_usd*100:5.1f}%)")
    L.append("")
    L.append("== Unidades financiadas por plan con el presupuesto variable completo (mix, unitario MEDIO) ==")
    for plan, precio in sorted(PLANS_MXN.items(), key=lambda kv: float(kv[0])):
        neto_usd = PLAN_NETO_MXN[plan] / FIX_MXN_USD
        psp_usd = (PSP_PCT * precio + PSP_FIXED) * PSP_IVA / FIX_MXN_USD
        presupuesto = neto_usd - psp_usd - INFRA_USD_CLIENTE
        for mix in sorted(MIXES):
            u_post = case_unit_cost("social.facebook.post.compose", mix)[0]
            u_img = case_unit_cost("website.image.generate", mix)[0]
            u_des = case_unit_cost("website.initial.design", mix)[0]
            u_rep = case_unit_cost("engagement.facebook.comment.reply", mix)[0]
            L.append(f"Plan {plan} {mix}: presupuesto ${presupuesto:6.2f} → "
                     f"{presupuesto/u_post:9,.0f} posts | {presupuesto/u_img:7,.0f} imágenes web | "
                     f"{presupuesto/u_des:8,.0f} rediseños | {presupuesto/u_rep:9,.0f} respuestas")
    L.append("")
    L.append("== Caché (asistente y diseño, 70% del input; mínimos Anthropic 512 / OpenAI 1,024) ==")
    for mix in sorted(MIXES):
        for esc in ["BAJO", "MEDIO", "ALTO", "ABUSO"]:
            ahorro = 0.0
            escritura = 0.0
            for case in CACHE_FRACTION:
                if case in JEV_CASES or CASE_MODALITY[case] == "imagen":
                    continue
                modelo, t_in, t_out, _f = profile_for(case, mix)
                frac = CACHE_FRACTION[case]
                freq = SCENARIOS[esc][case]
                unit_std, _, _, _, _, _, _ = case_unit_cost(case, mix)
                unit_c = text_unit_cost(modelo, t_in, t_out, cache=frac)
                ahorro += freq * (unit_std - unit_c)
                escritura += cache_write_surcharge(modelo, t_in, frac)
            L.append(f"{mix:9s} {esc:6s} ahorro-caché ${ahorro:8.5f}/mes (escritura inicial única ${escritura:.6f})")
    L.append("")
    L.append("== Sensibilidad sobre el escenario MEDIO (costo IA std por cliente/mes, USD) ==")
    for mix in sorted(MIXES):
        base = monthly[(mix, "MEDIO")]
        img_extra = sum(SCENARIOS["MEDIO"][c] * case_unit_cost(c, mix)[0]
                        for c in SCENARIOS["MEDIO"] if CASE_MODALITY[c] == "imagen")
        rep_extra = 0.0
        for c, _m, _ctl in CASES:
            if c in JEV_CASES or CASE_MODALITY[c] == "imagen":
                continue
            u = case_unit_cost(c, mix)[0]
            pr = P_REPAIR.get((c, MIXES[mix].get(c, ("",))[0]), P_REPAIR.get((c, "haiku"), P_REPAIR.get((c, "luna"), 0.0)))
            rep_extra += SCENARIOS["MEDIO"][c] * u * pr
        L.append(f"{mix:9s} base ${base:7.4f} | precios +25% ${base*1.25:7.4f} | −25% ${base*0.75:7.4f} | "
                 f"imágenes×2 ${base+img_extra:7.4f} | reparaciones×2 ${base+rep_extra:7.4f} | mix ALTO ${monthly[(mix,'ALTO')]:7.4f}")
    L.append("")
    L.append("== FX ±10% (margen USD del plan 500, escenario MEDIO) ==")
    for mix in sorted(MIXES):
        for fx in (FIX_MXN_USD * 0.9, FIX_MXN_USD, FIX_MXN_USD * 1.1):
            neto_usd = PLAN_NETO_MXN["500"] / fx
            psp_usd = (PSP_PCT * 500 + PSP_FIXED) * PSP_IVA / fx
            margen = neto_usd - psp_usd - INFRA_USD_CLIENTE - monthly[(mix, "MEDIO")]
            L.append(f"{mix:9s} FX {fx:8.4f} margen ${margen:7.3f}")
    L.append("")
    L.append(f"CSV filas={len(rows)}  sha256={digest}")
    print("\n".join(L))


if __name__ == "__main__":
    main()
