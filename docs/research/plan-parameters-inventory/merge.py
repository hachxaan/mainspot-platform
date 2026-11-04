#!/usr/bin/env python3
"""Fusión determinista del inventario de parámetros por plan de MainSpot.

Lee los cinco slices verificados de `slices/` (no se modifican), los árboles git fijados por
commit en los que se verificó su evidencia y el registro de plan del incremento, y escribe:

  docs/research/plan-parameters-inventory.json   fuente consolidada (una fila por definición)
  docs/research/plan-parameters-inventory.csv    una fila por definición, columnas planas
  docs/research/plan-parameters-inventory.md     informe en español

Uso (desde cualquier directorio):
  python3 docs/research/plan-parameters-inventory/merge.py           regenera los tres archivos
  python3 docs/research/plan-parameters-inventory/merge.py --check   no escribe; falla si difieren

Determinista: sin marcas de tiempo, orden estable, entradas fijadas por commit (base de los slices,
handoff y repositorios externos). Solo biblioteca estándar. Sale con código 1 si queda alguna
referencia `ruta:línea` rota o sin resolver, o si un candidato a parámetro no tiene disposición.

Variables opcionales: MAINSPOT_DOCUMENTATION_REPO y CANONFLOW_KEYSTONE_REPO (rutas a esos
repositorios si no están junto al de la plataforma).
"""

import csv
import hashlib
import io
import json
import os
import posixpath
import re
import subprocess
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
SLICES_REL = 'docs/research/plan-parameters-inventory/slices'
SCRIPT_REL = 'docs/research/plan-parameters-inventory/merge.py'
OUTPUTS = (
    ('json', 'docs/research/plan-parameters-inventory.json'),
    ('csv', 'docs/research/plan-parameters-inventory.csv'),
    ('md', 'docs/research/plan-parameters-inventory.md'),
)
SLICE_FILES = (
    'V1-web-media-brand.json',
    'V2-ai.json',
    'V3-engagement-social.json',
    'V4-platform-core.json',
    'V5-canon-governance.json',
)
BASE_SHA = '95f9436084fccd4c3ae83b0dbde62bcdbaa1274b'
HANDOFF_REF = 'origin/docs/handoff-plan-policy-catalog-20261104'
HANDOFF_SHA = '585017b7930bb003272357d7f058f3f63cd2cec8'
HANDOFF_DIR = 'docs/handoffs/plan-policy-catalog-2026-11-04/'
# (prefijo usado en las citas, nombre, variable de entorno, ruta por defecto relativa a ROOT, commit fijado)
EXTERNAL_REPOS = (
    ('mainspot-documentation/', 'mainspot-documentation', 'MAINSPOT_DOCUMENTATION_REPO',
     '../mainspot-documentation', '571a4d25cb331330026c3eeafc7b2e769ef8afca'),
    ('canonflow-keystone@70ff601/', 'canonflow-keystone', 'CANONFLOW_KEYSTONE_REPO',
     '../../canonflow-keystone', '70ff6015a603c517d3a60c8d7f454596ee23b773'),
)
REGISTRY_REL = 'src/plans/registry.ts'
# Registro canónico de las respuestas del propietario (lo escribe el registro canónico de la sesión).
CANON_RECORD_FILES = (
    '.canonflow/sources/SRC-0013-plan-catalog-directive.md',
    '.canonflow/decision-records/DEC-0075.json',
    '.canonflow/decision-records/DEC-0075.md',
)
ENTITLEMENTS_REL = 'src/subscriptions/entitlements.ts'
COVERAGE_DIRS = ('src', 'migrations', 'scripts', 'tests')

CONTRACT_FIELDS = (
    'key', 'description', 'sources', 'check', 'current_value', 'unit', 'type', 'scope', 'semantics',
    'period_reset', 'hard_upper_bound', 'dependencies', 'enforcement_points', 'ui_consumers',
    'error_or_copy', 'risks', 'classification', 'proposed_decision', 'evidence_status',
)
LIST_FIELDS = ('sources', 'dependencies', 'enforcement_points', 'ui_consumers', 'error_or_copy')
SCALAR_FIELDS = tuple(f for f in CONTRACT_FIELDS if f not in LIST_FIELDS and f != 'key')
CLASSIFICATIONS = (
    'commercial_plan', 'tenant_preference', 'platform_operational', 'security', 'legal_retention',
    'provider_contract', 'quality_evidence', 'technical_format',
)
DECISION_KINDS = (
    'plan_parameter', 'tenant_preference_bounded_by_plan', 'platform_config', 'keep_hardcoded',
    'normalize', 'out_of_scope',
)
CANDIDATE_CLASSES = ('commercial_plan', 'tenant_preference')
CANDIDATE_KINDS = ('plan_parameter', 'tenant_preference_bounded_by_plan')

# Slice dueño de una clave repetida (por dominio); si no aplica, gana el primer slice en orden.
PREFIX_OWNER = (
    ('website.', 'V1-web-media-brand'),
    ('ai.', 'V2-ai'),
    ('jev.', 'V2-ai'),
    ('analytics.', 'V2-ai'),
    ('reputation.', 'V3-engagement-social'),
    ('retention.', 'V3-engagement-social'),
    ('quota.', 'V4-platform-core'),
    ('subscription.', 'V4-platform-core'),
    ('platform.', 'V4-platform-core'),
    ('plan.', 'V4-platform-core'),
)

# ---------------------------------------------------------------------------------------------
# Decisiones del propietario de esta sesión (respuestas literales; se registran como SRC-0013 /
# DEC-0075 en el canon). Este inventario las cita; no las crea ni las interpreta como canon.
# ---------------------------------------------------------------------------------------------
OWNER_DECISIONS_DATE = '2026-11-04'
OWNER_DECISIONS = (
    {
        'id': 'authority',
        'question': '¿Quién mantiene el catálogo de planes y dónde? (modifica la matriz de roles de BR-0007)',
        'options': ['Ingeniería con permisos explícitos', 'Igual, con cuatro ojos', 'Solo platform_admin'],
        'answer': 'Ingeniería con permisos explícitos',
        'answer_detail': 'Pestaña Planes en /ingenieria. plans.read: ai_engineer, platform_admin, platform_support. '
                         'plans.edit (crear/clonar/editar borrador/confirmar valores): ai_engineer, platform_admin. '
                         'plans.publish (publicar, rollback, habilitar/deshabilitar; step-up + motivo): ai_engineer, '
                         'platform_admin. Asignar planes a negocios sigue solo en /plataforma (platform_admin).',
    },
    {
        'id': 'publish_meaning',
        'question': '¿Qué significa publicar una revisión de plan frente a Q-004 (DEC-0010: nombres, precios y límites '
                    'comprometidos con clientes siguen pospuestos)?',
        'options': ['Configuración operativa', 'Requiere DEC por publicación'],
        'answer': 'Configuración operativa',
        'answer_detail': 'Publicar aplica los límites al enforcement, pero no aprueba nombres, precios ni paquetes '
                         'comerciales; cada plan muestra «Sin aprobación comercial» y sigue sin precio ni cobro.',
    },
    {
        'id': 'revision_policy',
        'question': 'Al publicar una revisión nueva de un plan, ¿qué pasa con las suscripciones vigentes?',
        'options': ['Fijadas a su revisión', 'Siguen la publicada'],
        'answer': 'Fijadas a su revisión',
        'answer_detail': 'Cada suscripción queda fijada a la revisión con la que se asignó; publicar no cambia a clientes '
                         'vigentes. Migrarlas es una acción explícita con vista previa de afectados, step-up y motivo. '
                         'Los tenants actuales quedan en la revisión 1 (valores actuales).',
    },
    {
        'id': 'periodic',
        'question': 'Cuotas periódicas (DEC-0010 reserva ciclo, rollover y excedentes a HDC-MSP-06): ¿qué hago ahora?',
        'options': ['Mecanismo sin activar', 'Decidir ciclo ahora'],
        'answer': 'Mecanismo sin activar',
        'answer_detail': 'Implemento y pruebo el mecanismo periódico (ciclo mensual anclado al inicio de la suscripción, '
                         'UTC, reserva/commit/liberación, sin rollover), pero ningún plan real lo usa hasta HDC-MSP-06. '
                         'Las 6 capacidades conservan su semántica actual (acumulada).',
    },
    {
        'id': 'self_assign',
        'question': 'Hoy el rol de negocio administration puede autoasignarse cualquier plan '
                    '(POST /api/backoffice/subscriptions/assign). ¿Qué hago?',
        'options': ['Retirarla', 'Mantener restringida'],
        'answer': 'Retirarla',
        'answer_detail': 'La ruta del negocio responde 403; asignar queda exclusivo de platform_admin en /plataforma con '
                         'step-up, motivo e historial. El panel conserva plan y consumo en solo lectura. Ajusto los '
                         'tests que la usan.',
    },
    {
        'id': 'scope',
        'question': '¿Qué parámetros nuevos entran en este incremento? Todos con los valores vigentes actuales, sin '
                    'beneficios nuevos.',
        'options': ['Biblioteca de medios', 'Elegibilidad de IA', 'Plan Trial (DEC-0018)', 'Techo de autorrespuestas'],
        'answer': '(ninguna opción seleccionada)',
        'answer_detail': 'Selección múltiple vacía ⇒ ningún parámetro nuevo en este incremento.',
    },
    {
        'id': 'registration',
        'question': '¿Cómo se registran tus respuestas en el canon?',
        'options': ['SRC + DEC', 'Sesión HDC'],
        'answer': 'SRC + DEC',
        'answer_detail': 'Directiva explícita del propietario: SRC-0013 literal con sha256, DEC-0075 y deltas de '
                         'BR-0007/FR-0010/FR-0018/FR-0019, mismo precedente que DEC-0073/DEC-0074.',
    },
)
OWNER_DECISION_EXCLUDED = ('harness', 'Configuración del arnés OMP («Solo esta sesión»): no es producto y no va al canon.')

OD_STATUS_LABELS = {
    'cerrada': 'Cerrada por respuesta del propietario',
    'cerrada_incremento': 'Cerrada para este incremento',
    'parcial': 'Parcial',
    'abierta': 'Abierta',
}
# OD (slice V5) -> (estado tras las respuestas, respuestas que la tocan, evidencia, nota)
OD_SESSION_STATUS = {
    'OD-01': ('parcial', ('periodic',), 'HECHO',
              'El mecanismo periódico (ciclo mensual anclado al inicio de la suscripción, UTC, sin rollover) se '
              'construye y prueba sin activar; las 6 capacidades conservan la semántica acumulada. Ciclo real, rollover '
              'y excedentes siguen reservados a HDC-MSP-06 (DEC-0010).'),
    'OD-02': ('abierta', ('publish_meaning',), 'HECHO',
              'Publicar es configuración operativa y no aprueba nombres, precios ni paquetes («Sin aprobación '
              'comercial»); Q-004 sigue pospuesta.'),
    'OD-03': ('cerrada', ('revision_policy',), 'HECHO',
              'Suscripciones fijadas a su revisión; migrar es una acción explícita con vista previa, step-up y motivo; '
              'los tenants actuales quedan en la revisión 1.'),
    'OD-04': ('cerrada', ('authority',), 'HECHO',
              'plans.edit y plans.publish para ai_engineer y platform_admin; plans.read además para platform_support; '
              'sin regla de cuatro ojos.'),
    'OD-05': ('cerrada', ('authority',), 'HECHO',
              'Catálogo en la pestaña Planes de /ingenieria; asignar planes a negocios sigue en /plataforma '
              '(platform_admin).'),
    'OD-06': ('cerrada', ('authority',), 'HECHO', 'Permisos explícitos plans.read, plans.edit y plans.publish.'),
    'OD-07': ('cerrada', ('publish_meaning',), 'HECHO',
              'Publicar = configuración operativa (aplica límites al enforcement), no aprobación comercial.'),
    'OD-08': ('cerrada_incremento', ('scope',), 'HECHO',
              'Selección vacía: ningún parámetro nuevo en este incremento (no se eligieron biblioteca de medios, '
              'elegibilidad de IA, plan Trial ni techo de autorrespuestas). Sigue abierta para incrementos futuros.'),
    'OD-09': ('abierta', (), 'HECHO',
              'Sin respuesta en esta sesión. El registro conserva el statu quo: sin «ilimitado», ausente ⇒ deny, 0 ⇒ deny.'),
    'OD-10': ('abierta', (), 'HECHO',
              'Sin respuesta en esta sesión; el registro mantiene agents como no aplicado (DEC-0006/DEC-0017).'),
    'OD-11': ('abierta', ('scope',), 'HECHO',
              '«Plan Trial (DEC-0018)» se ofreció y no se seleccionó: DEC-0018/DEC-0039 siguen decididas y sin '
              'implementar (CF-07, CF-16).'),
    'OD-12': ('abierta', ('revision_policy',), 'INFERENCIA',
              'La fijación de revisión y la migración explícita con vista previa evitan cambios inadvertidos, pero no '
              'deciden qué ocurre con el uso por encima de un límite nuevo al cambiar de plan.'),
    'OD-13': ('abierta', ('scope',), 'HECHO',
              'Ningún parámetro de IA en este incremento; el presupuesto por negocio sigue como control de plataforma.'),
    'OD-14': ('abierta', ('scope',), 'HECHO', '«Elegibilidad de IA» se ofreció y no se seleccionó.'),
    'OD-15': ('abierta', ('scope',), 'HECHO',
              '«Techo de autorrespuestas» se ofreció y no se seleccionó; el umbral de reseñas sigue por entorno.'),
    'OD-16': ('cerrada', ('self_assign',), 'HECHO',
              'Autoasignación retirada: la ruta del negocio responde 403; asignar es exclusivo de platform_admin en '
              '/plataforma con step-up, motivo e historial.'),
    'OD-17': ('abierta', ('periodic',), 'HECHO',
              'Las 6 capacidades conservan su semántica actual (acumulada); la unidad de consumo no se redefinió.'),
    'OD-18': ('parcial', ('revision_policy', 'registration'), 'INFERENCIA',
              'El propietario fijó la política de revisión (tenants actuales en la revisión 1) y el canal de registro '
              '(SRC + DEC); las respuestas no incluyen una aprobación del modelo de datos ligada a bytes (patrón APR).'),
    'OD-19': ('parcial', ('publish_meaning', 'revision_policy'), 'INFERENCIA',
              'Los planes existentes conservan sus valores vigentes en la revisión 1 y se muestran «Sin aprobación '
              'comercial»; renombrarlos o retirarlos no se decidió.'),
    'OD-20': ('abierta', ('scope',), 'HECHO',
              '«Biblioteca de medios» se ofreció y no se seleccionó; sin techo de almacenamiento por plan.'),
    'OD-21': ('abierta', (), 'HECHO',
              'Sin respuesta; el registro fija el techo de website en 1 (client_website.tenant_id UNIQUE).'),
    'OD-22': ('cerrada', ('registration',), 'HECHO',
              'Canal elegido: SRC-0013 literal con sha256 + DEC-0075 y deltas de BR-0007/FR-0010/FR-0018/FR-0019 '
              '(precedente DEC-0073/DEC-0074).'),
    'OD-23': ('abierta', (), 'INFERENCIA',
              'No se invocó: las decisiones T3–T4 de este incremento se tomaron con respuestas directas del '
              'propietario; la pregunta general no se respondió.'),
    'OD-24': ('abierta', ('scope',), 'HECHO', 'Sin parámetros nuevos; los recursos del contenedor no se tratan aquí.'),
    'OD-25': ('abierta', ('self_assign',), 'INFERENCIA',
              'self_assign conserva plan y consumo del panel en solo lectura; la exigencia de diseño HDC (DEC-0040) '
              'para cambios del panel no se decidió.'),
}

CF_STATUS_LABELS = {
    'resuelto': 'Resuelto por decisión del propietario',
    'resuelto_sin_activar': 'Resuelto sin activar',
    'abierto': 'Sigue abierto',
    'rechazado': 'No es conflicto (rechazado por V5)',
}
CF_SESSION_STATUS = {
    'CF-01': ('resuelto', ('authority', 'registration'), 'HECHO',
              'Planes en /ingenieria por decisión explícita; el delta de FR-0019 se registra con DEC-0075.'),
    'CF-02': ('resuelto', ('authority', 'registration'), 'HECHO',
              'plans.edit/plans.publish para ai_engineer y platform_admin; delta de BR-0007 en DEC-0075.'),
    'CF-03': ('resuelto', ('authority',), 'HECHO',
              'Catálogo en /ingenieria y asignación en /plataforma (platform_admin), por decisión explícita.'),
    'CF-04': ('resuelto', ('publish_meaning',), 'HECHO',
              'Publicar no es aprobación comercial: aplica límites operativos sin nombres, precios ni paquetes; '
              'Q-004 sigue abierta.'),
    'CF-05': ('resuelto_sin_activar', ('periodic',), 'HECHO',
              'El mecanismo periódico existe sin activar; ningún plan lo usa hasta HDC-MSP-06.'),
    'CF-06': ('resuelto', ('registration',), 'HECHO', 'Mandato registrado como SRC-0013 + DEC-0075 por orden del propietario.'),
    'CF-07': ('abierto', ('scope',), 'HECHO', 'Trial no seleccionado en este incremento: la deriva DEC-0018 → código persiste.'),
    'CF-08': ('resuelto', ('self_assign',), 'HECHO',
              'Autoasignación retirada (403 para todos los roles del negocio); panel en solo lectura.'),
    'CF-09': ('abierto', (), 'HECHO', 'OD-10 sin decidir; agents sigue sin enforcement y cuenta usuarios internos.'),
    'CF-10': ('rechazado', (), 'HECHO', 'V5 lo descartó como conflicto vigente (DEC-024 y DEC-0010 desbloquean la infraestructura).'),
    'CF-11': ('abierto', (), 'HECHO', 'Fuera de las respuestas de esta sesión (autoridad sobre presupuestos de IA).'),
    'CF-12': ('rechazado', (), 'HECHO', 'V5 lo descartó (duplicado de CF-01/OD-18).'),
    'CF-13': ('abierto', ('scope',), 'HECHO',
              '«Techo de autorrespuestas» no seleccionado: sin cambios en el consentimiento ni en el tope por hora.'),
    'CF-14': ('abierto', (), 'HECHO', 'Deriva documental del repositorio upstream; fuera del alcance de este incremento.'),
    'CF-15': ('resuelto', ('authority', 'self_assign'), 'HECHO',
              'authority crea permisos plans.read/plans.edit/plans.publish distintos de subscription.admin; la '
              'autoasignación con subscription.admin se retira (self_assign).'),
    'CF-16': ('abierto', ('scope',), 'HECHO',
              'El alta sigue asignando plan_piloto_1 por omisión (ahora exige plan habilitado con revisión '
              'publicada); Trial no seleccionado.'),
}

# ---------------------------------------------------------------------------------------------
# Capacidades del libro de cuotas y disposición de cada candidato a parámetro de plan.
# ---------------------------------------------------------------------------------------------
CAPABILITIES = (
    # capacidad, clave del registro, filas del inventario (fila con valores sembrados primero), línea base del conteo
    ('website', 'quota.website.max', ('plan.limit.website.max', 'website.sites.max_per_tenant'), 80),
    ('social_posts', 'quota.social_posts.max', ('plan.limit.social_posts.max', 'quota.social_posts.max'), 81),
    ('social_ads', 'quota.social_ads.max', ('plan.limit.social_ads.max', 'quota.social_ads.max'), 82),
    ('reviews_managed', 'quota.reviews_managed.max', ('plan.limit.reviews_managed.max', 'quota.reviews_managed.max'), 83),
    ('agents', 'quota.agents.max', ('plan.limit.agents.max', 'quota.agents.enforcement'), 84),
    ('conversations', 'quota.conversations.max', ('plan.limit.conversations.max', 'quota.conversations.max'), 85),
)
SEEDED_PLANS = ('plan_piloto_1', 'plan_basico', 'plan_completo')

D_INC = 'incorporado'
D_SCOPE = 'alcance_vacio'
D_CANON = 'canon_difiere'
D_CEIL = 'techo_tecnico'
D_NOPARAM = 'no_es_parametro'
DISPOSITION_ORDER = (D_INC, D_SCOPE, D_CANON, D_CEIL, D_NOPARAM)
DISPOSITION_LABELS = {
    D_INC: 'Incorporado al registro de plan (capacidad existente; valores vigentes en la revisión 1)',
    D_SCOPE: 'Excluido: decisión del propietario de alcance vacío (ningún parámetro nuevo en este incremento)',
    D_CANON: 'Excluido: el canon lo difiere, lo reserva a otra decisión o lo prohíbe',
    D_CEIL: 'Excluido: techo técnico o de esquema (no configurable por plan)',
    D_NOPARAM: 'Fuera del registro: no define un valor por plan (semántica, contrato, presentación o gobierno)',
}
_AI_SCOPE = (D_SCOPE, ('scope',), ('OD-14',),
             'Opción «Elegibilidad de IA» ofrecida y no seleccionada; hoy ninguna capacidad de IA depende del plan.')
_AI_PERIODIC = (D_CANON, ('scope', 'periodic'), ('DEC-0010', 'OD-01', 'OD-13'),
                'Cuota periódica de IA: el ciclo está reservado a HDC-MSP-06 y no entra ningún parámetro de IA.')
_TRIAL = (D_SCOPE, ('scope',), ('DEC-0018', 'OD-11', 'CF-07'),
          'Opción «Plan Trial (DEC-0018)» ofrecida y no seleccionada; DEC-0018 sigue decidida y sin implementar.')
_AUTO_REPLY = (D_SCOPE, ('scope',), ('BR-0007', 'OD-15', 'CF-13'),
               'Opción «Techo de autorrespuestas» ofrecida y no seleccionada; el tope 1..60 por hora sigue como '
               'preferencia del negocio dentro del consentimiento.')
_DEFAULT_PLAN = (D_SCOPE, ('scope',), ('DEC-0018', 'DEC-0039', 'CF-16'),
                 '«Plan Trial (DEC-0018)» no seleccionado: el alta sigue asignando plan_piloto_1 por omisión.')
PREFIX_DISPOSITIONS = (
    ('ai.use_case.', '.gating', _AI_SCOPE),
    ('ai.quota.', '.units_per_cycle', _AI_PERIODIC),
    ('subscription.trial.', '', _TRIAL),
)
DISPOSITIONS = {
    'ai.capability.enabled_by_plan': _AI_SCOPE,
    'ai.editorial.frequency.enum': (D_SCOPE, ('scope',), (),
                                    'Preferencia del negocio ya acotada por enum; V2 propone mantenerla fija.'),
    'analytics.range.unbounded': (D_SCOPE, ('scope',), ('OD-08',),
                                  'Candidato a ventana de historial por plan (acotada por la retención legal).'),
    'billing.invoice_without_price': (D_CANON, ('publish_meaning',), ('BR-0006', 'DEC-024'),
                                      'Invariante canónico: facturar sin precio está prohibido; los planes siguen sin '
                                      'precio ni cobro.'),
    'candidate.engagement.auto_replies_quota': (D_CANON, ('scope', 'periodic'), ('DEC-0010', 'OD-01', 'OD-15'),
                                                'Cupo periódico: el ciclo está reservado a HDC-MSP-06 y el techo de '
                                                'autorrespuestas no se seleccionó.'),
    'candidate.social.scheduled_posts': (D_SCOPE, ('scope',), ('OD-08',),
                                         'Parámetro nuevo sin regla en el código.'),
    'commercial.landing.proposed_limits': (D_CANON, ('publish_meaning',), ('RULE-006', 'Q-004', 'OD-02'),
                                           'Valores PROPOSED de la landing: solo el propietario puede adoptarlos y '
                                           'publicar no los aprueba.'),
    'commercial.landing.proposed_prices': (D_CANON, ('publish_meaning',), ('Q-004', 'BR-0006', 'OD-02'),
                                           'Precios PROPOSED, prohibidos en el piloto; publicar no aprueba precios.'),
    'connectors.eligibility_per_plan': (D_SCOPE, ('scope',), ('OD-08',),
                                        'Elegibilidad nueva (hoy solo RBAC y prerrequisitos de entorno).'),
    'domain.subdomains.max_per_tenant': (D_CEIL, (), ('OD-21',),
                                         'Un subdominio por sitio y un sitio por negocio (UNIQUE); el dominio propio '
                                         'no existe.'),
    'engagement.auto_reply.feature_eligibility': (D_SCOPE, ('scope',), ('BR-0007', 'OD-15'),
                                                  'Elegibilidad nueva de la función; «Techo de autorrespuestas» no '
                                                  'seleccionado.'),
    'engagement.auto_reply.hourly_limit': _AUTO_REPLY,
    'engagement.ingest.facebook_comment.quota': (D_SCOPE, ('scope',), ('OD-08',),
                                                 'Cuota nueva de casos de atención por comentario.'),
    'engagement.policy.max_auto_replies_per_hour': _AUTO_REPLY,
    'engagement.policy.max_auto_replies_per_hour.default': _AUTO_REPLY,
    'engagement.policy.max_auto_replies_per_hour.range': _AUTO_REPLY,
    'engagement.policy.rate_window.counting': (D_SCOPE, ('scope',), ('OD-15',),
                                               'Depende del techo de autorrespuestas no seleccionado; la dimensión del '
                                               'conteo es un hueco aparte.'),
    'engagement.worker.tenant_scope': (D_SCOPE, ('scope',), ('FR-0010',),
                                       'Elegibilidad por suscripción en el observador: regla nueva no incluida.'),
    'media.library.max_active_assets': (D_SCOPE, ('scope',), ('OD-08', 'OD-20'),
                                        'Opción «Biblioteca de medios» ofrecida y no seleccionada; el cupo 300 sigue '
                                        'fijo en código.'),
    'media.storage.max_bytes_per_tenant': (D_SCOPE, ('scope',), ('OD-20',),
                                           'Opción «Biblioteca de medios» no seleccionada; sin cuota de bytes.'),
    'panel.ui.plan_view': (D_NOPARAM, ('self_assign',), (), 'Presentación del plan en el panel (solo lectura).'),
    'pilot.business_count': (D_NOPARAM, (), (), 'Gobierno del piloto (canon); no configurable por plan.'),
    'plan.active.flag': (D_NOPARAM, ('authority',), (),
                         'Atributo del plan: en el catálogo es «habilitado» (plans.publish); solo los planes '
                         'habilitados con revisión publicada son asignables.'),
    'plan.catalog.seeded_plans': (D_NOPARAM, ('publish_meaning', 'revision_policy'), ('OD-02', 'OD-19'),
                                  'Identidad de los planes: se conservan como revisión 1 con sus valores vigentes, '
                                  'sin aprobación comercial.'),
    'plan.direction.monthly_token_quota': (D_CANON, ('scope', 'periodic'), ('DEC-0010', 'OD-01', 'OD-13'),
                                           'Dirección no canónica; el ciclo mensual está reservado a HDC-MSP-06.'),
    'plan.direction.structure': (D_CANON, (), ('DEC-0010', 'Q-004', 'OD-02'),
                                 'La estructura A/B/C/Personalizado es dirección no canónica.'),
    'plan.is_pilot.flag': (D_NOPARAM, (), (), 'Marca de plan piloto: solo ordena el listado.'),
    'plan.limit.value_domain': (D_NOPARAM, (), ('OD-09',),
                                'Dominio del valor: lo declara cada definición del registro (rango y techo; ausente ⇒ '
                                'deny; sin «ilimitado»).'),
    'plan.price.price_cents': (D_CANON, ('publish_meaning',), ('Q-004', 'DEC-0010', 'BR-0006'),
                               'Precio pospuesto (Q-004); los planes siguen sin precio ni cobro.'),
    'plan.unlimited.implicit': (D_CANON, (), ('OD-09',),
                                'Prohibido por canon; un «ilimitado» explícito sigue sin decidir.'),
    'quota.capability.consumption_points': (D_NOPARAM, (), ('OD-17',),
                                            'Unidad de consumo de las capacidades: se conserva la actual; '
                                            'redefinirla es OD-17.'),
    'quota.limit_absent_or_zero.semantics': (D_NOPARAM, (), ('OD-09',),
                                             'Semántica de ausencia y 0: el backfill convierte ausencias en 0 '
                                             '(mismo efecto deny).'),
    'quota.limit_exceeded.copy': (D_NOPARAM, (), (), 'Mensaje al usuario; no es un valor por plan.'),
    'quota.period.anchor': (D_CANON, ('periodic',), ('DEC-0010', 'OD-01'),
                            'Ciclo reservado a HDC-MSP-06: el mecanismo periódico existe sin activar.'),
    'quota.subscription_required.gate': (D_NOPARAM, (), ('FR-0010',),
                                         'Requisito base de suscripción activa; su extensión a otros puntos de efecto '
                                         'es un hueco de enforcement.'),
    'quota.usage.counting_basis': (D_NOPARAM, ('periodic',), ('OD-17',),
                                   'Base de conteo acumulada conservada por decisión del propietario.'),
    'quota.usage_display.platform_month': (D_NOPARAM, (), ('OD-17',),
                                           'Presentación del uso en la consola; no es un valor por plan.'),
    'reputation.review_threshold': (D_SCOPE, ('scope',), ('OD-15',),
                                    'Umbral por entorno; la preferencia por negocio acotada por plan no entra (V3 y V5 '
                                    'lo tratan como configuración de plataforma).'),
    'reputation.sync.batch_all_or_nothing': (D_NOPARAM, (), ('FR-0010',),
                                             'Lote atómico canónico (FR-0010); se conserva.'),
    'scope.segment': (D_NOPARAM, (), ('DEC-0012',), 'Gobierno del alcance (solo nivel 1 en v0.1).'),
    'social.schedule.timezone': (D_SCOPE, ('scope',), (),
                                 'Candidato a preferencia del negocio (zona IANA), no comercial.'),
    'storage.media.bytea_growth': (D_SCOPE, ('scope',), ('OD-20',),
                                   '«Biblioteca de medios» no seleccionada; el almacenamiento queda además acotado por '
                                   'el diseño de respaldos (OD-20).'),
    'subscription.assign.requires_active_plan': (D_NOPARAM, ('self_assign', 'authority'), ('OD-16',),
                                                 'Regla de asignación: solo planes habilitados con revisión publicada; '
                                                 'autoasignación retirada.'),
    'subscription.dates.started_at_updated_at': (D_NOPARAM, (), (), 'Dato estructural de la suscripción.'),
    'subscription.default_plan.onboarding': _DEFAULT_PLAN,
    'subscription.default_plan_on_onboarding': _DEFAULT_PLAN,
    'subscription.entitlements.read_contract': (D_NOPARAM, (), (), 'Contrato de lectura de entitlements.'),
    'subscription.plans.list_visibility': (D_NOPARAM, (), (), 'Visibilidad del catálogo para el negocio.'),
    'subscription.required.status': (D_NOPARAM, (), (), 'Estado de suscripción requerido; no es un valor por plan.'),
    'ui.engagement.rules.rate_control': (D_SCOPE, ('scope',), ('OD-15',),
                                         'Depende del techo de autorrespuestas no seleccionado.'),
    'ui.plan.capability_labels': (D_NOPARAM, (), (), 'Presentación: el registro declara etiqueta y unidad por definición.'),
    'website.ai_generation.quota_per_cycle': _AI_PERIODIC,
    'website.changes.requires_active_subscription': (D_SCOPE, ('scope',), ('FR-0010',),
                                                     'Elegibilidad por acción nueva; requiere decisión humana.'),
    'website.proposal.counts_as_conversation': (D_NOPARAM, (), ('OD-17',),
                                                'Unidad de conversations: se conserva el conteo actual; redefinirla es '
                                                'OD-17.'),
    'website.serving.requires_active_subscription': (D_SCOPE, ('scope',), (),
                                                     'Elegibilidad nueva para servir la página; requiere decisión humana.'),
}
INCORPORATED_NOTES = {
    'quota.website.max': 'Techo de sistema 1: client_website.tenant_id es UNIQUE.',
    'quota.agents.max': 'Registrado como no aplicado (DEC-0006/DEC-0017); cuenta usuarios internos, no agentes de IA.',
}
# Claves distintas que describen la misma definición (no se fusionan: la fusión es solo por key).
EQUIVALENT_KEYS = (
    ('Plan por omisión en el alta', ('subscription.default_plan.onboarding', 'subscription.default_plan_on_onboarding')),
    ('Respuestas automáticas por hora', ('engagement.policy.max_auto_replies_per_hour',
                                         'engagement.policy.max_auto_replies_per_hour.default',
                                         'engagement.policy.max_auto_replies_per_hour.range',
                                         'engagement.auto_reply.hourly_limit')),
    ('Consumo mostrado en la consola de plataforma', ('platform.console.usage_month', 'quota.usage_display.platform_month')),
)


# =============================================================================================
# Utilidades
# =============================================================================================
def run_git(repo, *args, stdin=None):
    proc = subprocess.run(['git', '-C', repo, *args], input=stdin, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError('git %s (%s): %s' % (' '.join(args), repo, proc.stderr.decode('utf-8', 'replace').strip()))
    return proc.stdout


def line_stats(data):
    n = data.count(b'\n')
    ends = data.endswith(b'\n')
    if data and not ends:
        n += 1
    return n, ends


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


class TreeIndex:
    """Archivos de un árbol git fijado por commit: ruta -> (líneas, termina en salto de línea)."""

    def __init__(self, name, repo, sha, display_prefix='', path_prefix=''):
        self.name = name
        self.repo = repo
        self.sha = sha
        self.display_prefix = display_prefix
        self.files = {}
        entries = []
        for rec in run_git(repo, 'ls-tree', '-r', '-z', '--full-tree', sha).split(b'\0'):
            if not rec:
                continue
            meta, path = rec.split(b'\t', 1)
            _mode, typ, obj = meta.split(b' ')
            path = path.decode('utf-8')
            if typ != b'blob' or (path_prefix and not path.startswith(path_prefix)):
                continue
            entries.append((path, obj.decode('ascii')))
        if entries:
            out = run_git(repo, 'cat-file', '--batch', stdin=''.join(o + '\n' for _, o in entries).encode('ascii'))
            pos = 0
            for path, _obj in entries:
                nl = out.index(b'\n', pos)
                size = int(out[pos:nl].split(b' ')[2])
                data = out[nl + 1:nl + 1 + size]
                pos = nl + 1 + size + 1
                self.files[path] = line_stats(data)
        self.by_base = {}
        for p in sorted(self.files):
            self.by_base.setdefault(posixpath.basename(p), []).append(p)

    def display(self, path):
        return self.display_prefix + path


class FsIndex:
    """Dependencias instaladas (no rastreadas por git; versión fijada por package-lock.json)."""

    def __init__(self, root, prefix):
        self.name = 'node_modules'
        self.root = root
        self.prefix = prefix
        self.files = {}
        self.display_prefix = ''

    def get(self, path):
        if not path.startswith(self.prefix):
            return None
        if path not in self.files:
            full = os.path.join(self.root, path)
            if os.path.isfile(full):
                with open(full, 'rb') as fh:
                    self.files[path] = line_stats(fh.read())
            else:
                self.files[path] = None
        return self.files[path]

    def display(self, path):
        return path


class AbsIndex:
    """Rutas absolutas fuera de los repositorios fijados (no versionadas por commit)."""

    def __init__(self):
        self.name = 'absolute_unpinned'
        self.files = {}
        self.display_prefix = ''

    def get(self, path):
        if path not in self.files:
            if os.path.isfile(path):
                with open(path, 'rb') as fh:
                    self.files[path] = line_stats(fh.read())
            else:
                self.files[path] = None
        return self.files[path]

    def display(self, path):
        return path


def brace_expand(pattern):
    m = re.search(r'\{([^{}]*)\}', pattern)
    if not m:
        return [pattern]
    out = []
    for alt in m.group(1).split(','):
        out.extend(brace_expand(pattern[:m.start()] + alt + pattern[m.end():]))
    return out


def glob_regex(pattern):
    out, i = [], 0
    while i < len(pattern):
        if pattern.startswith('**', i):
            out.append('.*')
            i += 2
        elif pattern[i] == '*':
            out.append('[^/]*')
            i += 1
        elif pattern[i] == '?':
            out.append('[^/]')
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile(''.join(out) + r'\Z')


def decision_kind(text):
    t = (text or '').strip()
    for k in DECISION_KINDS:
        if t.startswith(k):
            return k
    return 'other'


def as_list(value):
    if isinstance(value, list):
        return list(value)
    if value is None or value == '':
        return []
    return [value]


def union(*lists):
    seen, out = set(), []
    for lst in lists:
        for item in lst:
            k = json.dumps(item, ensure_ascii=False, sort_keys=True)
            if k not in seen:
                seen.add(k)
                out.append(item)
    return out


def walk(obj, path=()):
    if isinstance(obj, str):
        yield path, obj
    elif isinstance(obj, dict):
        for k, v in obj.items():
            yield from walk(v, path + (k,))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from walk(v, path + (i,))


def path_str(path):
    out = ''
    for p in path:
        out += '[%d]' % p if isinstance(p, int) else ('.' + p if out else p)
    return out


def record_key(path):
    for i, p in enumerate(path):
        if isinstance(p, int):
            return path[:i + 1]
    return path[:2]


def get_at(obj, path):
    for p in path:
        obj = obj[p]
    return obj


# =============================================================================================
# Comprobación de referencias ruta:línea
# =============================================================================================
LINESPEC = r'\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*'
CANON_ID = r'(?:FR|BR|NFR|DEC|QS|RUN|SRC|OPS|DAT|SEC|API|ARC|APR|ANS|INC)-\d{4}'
FILE_EXT = r'(?:ts|js|mjs|cjs|sql|md|json|yaml|yml|py|sh|html|css|conf|service|timer|txt|toml|lock|mmd|example|template)'
REF_RE = re.compile(
    r'(?P<git>git:(?P<gref>[\w./-]+):(?P<gpath>[\w./@+-]+\.\w+):(?P<glines>' + LINESPEC + r'))'
    r'|(?<![\w/.@~+-])(?P<abs>/(?:[\w.@~+-]+/)+[\w.@~+-]+):(?P<alines>' + LINESPEC + r')'
    r'|(?<![\w/.@~+-])(?P<path>(?:[\w.@~+-]+/)+[\w.@~+-]+):(?P<lines>' + LINESPEC + r')'
    r'|(?<![\w/.@~+-])(?P<bare>[\w.+-]*[A-Za-z_][\w.+-]*\.' + FILE_EXT + r'):(?P<blines>' + LINESPEC + r')'
    r'|(?<![\w/.@~+-])(?P<cid>' + CANON_ID + r'):(?P<clines>' + LINESPEC + r')'
    r'|(?<![\w/.@~+-])(?P<mig>\d{4}):(?P<mlines>' + LINESPEC + r')'
    r'|(?<=[\s(;,\[])(?P<cont>:)(?P<colines>' + LINESPEC + r')'
)
MENTION_RE = re.compile(r'(?<![\w/.@~+-])((?:[\w.@~+-]+/)+[\w.@~+-]+\.\w+)(?![\w/])')
IDEXT_RE = re.compile(r'^(' + CANON_ID + r')\.(md|json|yaml)$')
CANON_DIRS = {
    'FR': ('.canonflow/canon/functional/items/',), 'BR': ('.canonflow/canon/functional/items/',),
    'NFR': ('.canonflow/canon/functional/items/',), 'OPS': ('.canonflow/canon/technical/items/',),
    'DAT': ('.canonflow/canon/technical/items/',), 'SEC': ('.canonflow/canon/technical/items/',),
    'API': ('.canonflow/canon/technical/items/',), 'ARC': ('.canonflow/canon/technical/items/',),
    'DEC': ('.canonflow/decision-records/',), 'APR': ('.canonflow/decision-records/',),
    'QS': ('.canonflow/decision-sessions/archived/', '.canonflow/decision-sessions/pending/'),
    'RUN': ('.canonflow/skill-runs/',), 'SRC': ('.canonflow/sources/',), 'INC': ('.canonflow/increments/',),
    'ANS': (),
}
OK_STATUSES = ('ok', 'ok_context', 'ambiguous_all', 'ambiguous_some')
BROKEN_STATUSES = ('out_of_range', 'unresolved')


def parse_lines(spec):
    items = []
    for part in spec.split(','):
        part = part.strip()
        if '-' in part:
            a, b = part.split('-', 1)
            items.append((int(a), int(b)))
        else:
            items.append((int(part), int(part)))
    return items


class Resolver:
    def __init__(self, repo, externals, handoff, node_modules, absolute, declared_by_slice):
        self.repo = repo
        self.externals = externals          # prefijo -> TreeIndex
        self.handoff = handoff
        self.nm = node_modules
        self.abs = absolute
        self.declared = declared_by_slice   # slice -> set(rutas del repo)
        self.git_refs = {HANDOFF_REF: handoff}

    # -- candidatos: (índice, ruta interna, líneas, termina en salto)
    def full(self, path):
        for prefix, idx in self.externals.items():
            if path.startswith(prefix):
                rest = path[len(prefix):]
                if idx is not None and rest in idx.files:
                    return (idx, rest) + idx.files[rest]
                return None
        if path in self.repo.files:
            return (self.repo, path) + self.repo.files[path]
        if path.startswith(self.nm.prefix):
            st = self.nm.get(path)
            return (self.nm, path) + st if st else None
        return None

    def absolute(self, path):
        if path.startswith(ROOT + '/'):
            return self.full(path[len(ROOT) + 1:])
        st = self.abs.get(path)
        return (self.abs, path) + st if st else None

    @staticmethod
    def matches(cand_path, token, tk):
        if tk == 'cid':
            b = posixpath.basename(cand_path)
            return b.startswith(token + '.') or b.startswith(token + '-')
        if tk == 'idext':
            ident, ext = IDEXT_RE.match(token).groups()
            b = posixpath.basename(cand_path)
            return (b.startswith(ident + '.') or b.startswith(ident + '-')) and b.endswith('.' + ext)
        if tk == 'mig':
            return cand_path.startswith('migrations/' + token + '_')
        return cand_path == token or cand_path.endswith('/' + token)

    def convention(self, token, tk):
        if tk == 'mig':
            return [(self.repo, p) + self.repo.files[p] for p in sorted(self.repo.files)
                    if p.startswith('migrations/' + token + '_')]
        if tk in ('cid', 'idext'):
            ident = token if tk == 'cid' else IDEXT_RE.match(token).group(1)
            dirs = CANON_DIRS.get(ident.split('-')[0], ())
            out = []
            for p in sorted(self.repo.files):
                for d in dirs:
                    if p.startswith(d) and '/' not in p[len(d):] and self.matches(p, token, tk):
                        out.append((self.repo, p) + self.repo.files[p])
            return out
        if tk == 'bare' and token in ('HANDOFF.md', 'BOOTSTRAP-PROMPT.md'):
            return [(self.handoff, p) + self.handoff.files[p] for p in sorted(self.handoff.files)
                    if p == HANDOFF_DIR + token]
        return []

    def suffix(self, idx, token):
        base = posixpath.basename(token)
        return [(idx, p) + idx.files[p] for p in idx.by_base.get(base, []) if p == token or p.endswith('/' + token)]

    def abbreviated(self, token, tk, str_full, rec_full, slices):
        for c in reversed(str_full):
            if self.matches(c[1], token, tk):
                return [c], 'context_string'
        cc = [c for c in rec_full if self.matches(c[1], token, tk)]
        if cc:
            return cc, 'context_record'
        if tk == 'bare' and token in self.repo.files:
            return [(self.repo, token) + self.repo.files[token]], 'repo_exact'
        cc = self.convention(token, tk)
        if cc:
            return cc, 'convention'
        if tk in ('bare', 'partial'):
            cc = self.suffix(self.repo, token)
            if len(cc) > 1:
                declared = set()
                for s in slices:
                    declared |= self.declared.get(s, set())
                narrowed = [c for c in cc if c[1] in declared]
                if len(narrowed) == 1:
                    return narrowed, 'repo_suffix_declared'
            if cc:
                return cc, 'repo_suffix'
            ext = []
            for idx in list(self.externals.values()) + [self.handoff]:
                if idx is not None:
                    ext.extend(self.suffix(idx, token))
            if ext:
                return ext, 'external_suffix'
            if tk == 'partial' and '/' in token:
                return self.abbreviated(token.rsplit('/', 1)[1], 'bare', str_full, rec_full, slices)
        return [], None

    def check_document(self, doc, slice_ids):
        strings = list(walk(doc))
        records = {}
        for path, text in strings:
            records.setdefault(record_key(path), []).append((path, text))
        results = []
        for rkey, items in records.items():
            slices = self.record_slices(doc, rkey, slice_ids)
            rec_full = []
            for _path, text in items:
                for m in MENTION_RE.finditer(text):
                    c = self.full(m.group(1))
                    if c:
                        rec_full.append(c)
                for m in REF_RE.finditer(text):
                    c = None
                    if m.group('git'):
                        idx = self.git_refs.get(m.group('gref'))
                        if idx is not None and m.group('gpath') in idx.files:
                            c = (idx, m.group('gpath')) + idx.files[m.group('gpath')]
                    elif m.group('abs'):
                        c = self.absolute(m.group('abs'))
                    elif m.group('path'):
                        c = self.full(m.group('path'))
                    if c:
                        rec_full.append(c)
            rec_full = list(dict.fromkeys(rec_full))
            for path, text in items:
                results.extend(self.check_string(path, text, rkey, rec_full, slices))
        return results

    @staticmethod
    def record_slices(doc, rkey, slice_ids):
        found = [p for p in rkey if isinstance(p, str) and p in slice_ids]
        try:
            root = get_at(doc, rkey)
        except (KeyError, IndexError, TypeError):
            root = None
        if isinstance(root, dict):
            for field in ('slice', 'id'):
                if isinstance(root.get(field), str) and root[field] in slice_ids:
                    found.append(root[field])
            for a in root.get('also_reported_by', []) or []:
                if isinstance(a, dict) and isinstance(a.get('slice'), str):
                    found.append(a['slice'])
        return tuple(dict.fromkeys(found))

    def check_string(self, path, text, rkey, rec_full, slices):
        out = []
        str_files = []      # archivos resueltos en esta cadena (orden de aparición)
        last = None
        for m in REF_RE.finditer(text):
            res = {'location': path_str(path), 'record': path_str(rkey), 'token': m.group(0)}
            cands, how, spec, kind = [], None, None, None
            if m.group('git'):
                kind, spec = 'git', m.group('glines')
                idx = self.git_refs.get(m.group('gref'))
                if idx is not None and m.group('gpath') in idx.files:
                    cands, how = [(idx, m.group('gpath')) + idx.files[m.group('gpath')]], 'git_ref'
            elif m.group('abs'):
                kind, spec = 'absolute', m.group('alines')
                c = self.absolute(m.group('abs'))
                if c:
                    cands, how = [c], 'absolute'
            elif m.group('path'):
                kind, spec = 'path', m.group('lines')
                c = self.full(m.group('path'))
                if c:
                    cands, how = [c], 'full_path'
                else:
                    token = m.group('path')
                    mm = re.match(r'^migrations/(\d{4})$', token)
                    if mm:
                        cands, how = self.abbreviated(mm.group(1), 'mig', str_files, rec_full, slices)
                    else:
                        cands, how = self.abbreviated(token, 'partial', str_files, rec_full, slices)
            elif m.group('bare'):
                kind, spec = 'bare', m.group('blines')
                token = m.group('bare')
                cands, how = self.abbreviated(token, 'bare', str_files, rec_full, slices)
                if not cands and IDEXT_RE.match(token):
                    cands, how = self.abbreviated(token, 'idext', str_files, rec_full, slices)
            elif m.group('cid'):
                kind, spec = 'canon_id', m.group('clines')
                cands, how = self.abbreviated(m.group('cid'), 'cid', str_files, rec_full, slices)
            elif m.group('mig'):
                kind, spec = 'migration_number', m.group('mlines')
                cands, how = self.abbreviated(m.group('mig'), 'mig', str_files, rec_full, slices)
            else:
                kind, spec = 'continuation', m.group('colines')
            items = parse_lines(spec)

            def fits(c):
                return all(1 <= a <= b <= c[2] for a, b in items)

            if kind == 'continuation':
                ordered = ([last] if last else []) + [c for c in reversed(str_files) if c is not last] + \
                          [c for c in rec_full if c not in str_files]
                ordered = list(dict.fromkeys(ordered))
                chosen = next((c for c in ordered if fits(c)), None)
                if not ordered:
                    status = 'unresolved'
                elif chosen is None:
                    status, cands = 'out_of_range', [ordered[0]]
                else:
                    cands = [chosen]
                    how = 'continuation_last' if chosen is last else 'continuation_context'
                    status = 'ok_context'
            else:
                ok = [c for c in cands if fits(c)]
                if not cands:
                    status = 'unresolved'
                elif len(cands) == 1:
                    status = ('ok' if how in ('full_path', 'git_ref', 'absolute') else 'ok_context') if ok else 'out_of_range'
                else:
                    status = 'ambiguous_all' if len(ok) == len(cands) else ('ambiguous_some' if ok else 'out_of_range')
            res.update({
                'kind': kind, 'lines': spec, 'resolution': how, 'status': status,
                'candidates': [{'index': c[0].name, 'path': c[0].display(c[1]), 'line_count': c[2], 'in_range': fits(c)}
                               for c in cands],
                '_cands': cands, '_items': items,
            })
            out.append(res)
            if len(cands) == 1:
                last = cands[0]
                if cands[0] not in str_files:
                    str_files.append(cands[0])
        return out


def off_by_one_corrections(results):
    """Rangos `a-(N+1)` a archivos de N líneas que terminan en salto: la línea N+1 no existe."""
    corrections = {}
    for r in results:
        if r['status'] != 'out_of_range' or r['kind'] not in ('path', 'git') or len(r['_cands']) != 1:
            continue
        c = r['_cands'][0]
        n, ends = c[2], c[3]
        if not ends:
            continue
        fixed, changed, valid = [], False, True
        for a, b in r['_items']:
            if a <= b <= n:
                fixed.append((a, b))
            elif a < b == n + 1:
                fixed.append((a, n))
                changed = True
            else:
                valid = False
        if not (valid and changed):
            continue
        spec = ','.join('%d-%d' % (a, b) if a != b else '%d' % a for a, b in fixed)
        token = r['token']
        new_token = token[:len(token) - len(r['lines'])] + spec
        corrections[token] = {
            'path': c[0].display(c[1]),
            'original_lines': r['lines'],
            'corrected_lines': spec,
            'line_count': n,
            'locations': [],
        }
        corrections[token]['_new'] = new_token
    for r in results:
        if r['token'] in corrections:
            corrections[r['token']]['locations'].append(r['location'])
    return corrections


def apply_corrections(obj, corrections):
    if not corrections:
        return obj
    pattern = re.compile('|'.join(re.escape(t) + r'(?![\d,-])' for t in sorted(corrections, key=len, reverse=True)))

    def fix(text):
        return pattern.sub(lambda m: corrections[m.group(0)]['_new'], text)

    def rec(o):
        if isinstance(o, str):
            return fix(o)
        if isinstance(o, list):
            return [rec(v) for v in o]
        if isinstance(o, dict):
            return {k: rec(v) for k, v in o.items()}
        return o
    return rec(obj)


# =============================================================================================
# Cobertura
# =============================================================================================
TOKEN_RE = re.compile(r'[\w.@~+*/-]*\{[^}]*\}[\w.@~+*/-]*|[\w.@~+*/-]+')


def declared_paths(entry, all_paths):
    if isinstance(entry, dict):
        text = '%s %s' % (entry.get('path', ''), entry.get('ranges', ''))
    else:
        text = entry.split(' — ', 1)[0]
    found, cur_dir, prev_base = [], None, None
    for tok in TOKEN_RE.findall(text):
        tok = tok.rstrip('.,;:')
        if not tok:
            continue
        if '/' in tok:
            pats = brace_expand(tok)
            first = pats[0]
            if '*' in first:
                prefix = first.split('*', 1)[0]
                cur_dir = prefix.rstrip('/') if prefix.endswith('/') else posixpath.dirname(prefix)
                prev_base = None
            else:
                cur_dir, prev_base = posixpath.dirname(first), posixpath.basename(first)
            for pat in pats:
                if '*' in pat or '?' in pat:
                    rx = glob_regex(pat)
                    found.extend(p for p in all_paths if rx.match(p))
                elif pat in all_paths:
                    found.append(pat)
        elif cur_dir and re.search(r'\.\w+$', tok):
            for pat in brace_expand(tok):
                cand = cur_dir + '/' + pat
                if cand not in all_paths and prev_base and len(prev_base) > len(pat):
                    # Variante abreviada de un hermano: «x.v1.json, v2.json» ⇒ «x.v2.json».
                    cand = cur_dir + '/' + prev_base[:len(prev_base) - len(pat)] + pat
                if cand in all_paths:
                    found.append(cand)
    return sorted(set(found))


# =============================================================================================
# Registro de plan del incremento
# =============================================================================================
def parse_registry(text):
    def grab(pattern, src):
        m = re.search(pattern, src)
        return m.group(1) if m else None

    version = grab(r'export const PLAN_REGISTRY_VERSION = (\d+);', text)
    sanity = grab(r'export const COUNT_SANITY_MAX = ([\d_]+);', text)
    start = text.index('export const PLAN_PARAMETERS = [')
    end = text.index('] as const', start)
    sanity_value = int(sanity.replace('_', '')) if sanity else None

    def num(tok):
        if tok is None:
            return None
        if tok == 'COUNT_SANITY_MAX':
            return sanity_value
        if tok in ('true', 'false'):
            return tok == 'true'
        return int(tok.replace('_', ''))

    params = []
    for chunk in re.split(r'\n  \{\n', text[start:end])[1:]:
        usage = re.search(r"usageSql: (?:'([^']*)'|\"([^\"]*)\")", chunk)
        params.append({
            'key': grab(r"key: '([^']+)'", chunk),
            'capability': grab(r"capability: '([^']+)'", chunk),
            'label': grab(r"label: '([^']+)'", chunk),
            'unit': grab(r"unit: '([^']+)'", chunk),
            'value_type': grab(r"valueType: '([^']+)'", chunk),
            'semantics': grab(r"semantics: '([^']+)'", chunk),
            'period': grab(r"period: \{ kind: '([^']+)'", chunk),
            'min': num(grab(r'\bmin: ([\w]+)', chunk)),
            'max': num(grab(r'\bmax: ([\w]+)', chunk)),
            'suggested': num(grab(r'\bsuggested: ([\w]+)', chunk)),
            'enforcement': grab(r"enforcement: \{ state: '([^']+)'", chunk),
            'usage_sql': (usage.group(1) if usage.group(1) is not None else usage.group(2)) if usage else None,
        })
    return {'registry_version': int(version) if version else None, 'count_sanity_max': sanity_value,
            'parameters': params}


def parse_seeded_values(text):
    out = {}
    for plan, val in re.findall(r'(plan_\w+)=(\d+|sin fila)', text or ''):
        out[plan] = int(val) if val.isdigit() else None
    return out


# =============================================================================================
# Construcción del documento
# =============================================================================================
def load_slices():
    slices = []
    for fname in SLICE_FILES:
        rel = SLICES_REL + '/' + fname
        with open(os.path.join(ROOT, rel), 'rb') as fh:
            raw = fh.read()
        data = json.loads(raw.decode('utf-8'))
        slices.append({'file': rel, 'sha256': sha256_bytes(raw), 'data': data, 'id': data['slice']})
    return slices


def owner_slice(key, reporters):
    for prefix, sid in PREFIX_OWNER:
        if key.startswith(prefix) and sid in reporters:
            return sid
    return reporters[0]


def normalize_row(row):
    out, notes = {}, []
    for f in CONTRACT_FIELDS:
        v = row.get(f)
        if f == 'current_value' and not isinstance(v, str):
            notes.append('current_value')
            v = json.dumps(v, ensure_ascii=False)
        if f in LIST_FIELDS and not isinstance(v, list):
            notes.append(f)
            v = as_list(v)
        out[f] = v
    return out, notes


def disposition_for(key):
    if key in DISPOSITIONS:
        return DISPOSITIONS[key]
    for prefix, suffix, value in PREFIX_DISPOSITIONS:
        if key.startswith(prefix) and key.endswith(suffix):
            return value
    return None


def build(git_root):
    slices = load_slices()
    slice_ids = tuple(s['id'] for s in slices)
    order = {sid: i for i, sid in enumerate(slice_ids)}

    repo = TreeIndex('repo', git_root, BASE_SHA)
    handoff = TreeIndex('handoff', git_root, HANDOFF_SHA, 'git:%s:' % HANDOFF_REF, HANDOFF_DIR)
    externals, external_meta = {}, []
    for prefix, name, env, default, sha in EXTERNAL_REPOS:
        path = os.environ.get(env) or os.path.normpath(os.path.join(ROOT, default))
        idx = None
        try:
            idx = TreeIndex(name, path, sha, prefix)
        except (RuntimeError, OSError):
            idx = None
        externals[prefix] = idx
        external_meta.append({'prefix': prefix, 'repository': name, 'commit': sha, 'available': idx is not None})

    # ---------------- filas
    reports = {}
    type_norm = Counter()
    for s in slices:
        for i, row in enumerate(s['data']['rows']):
            norm, notes = normalize_row(row)
            for n in notes:
                type_norm[n] += 1
            reports.setdefault(row['key'], []).append((s['id'], i, norm, row['verification']))
    rows, duplicates = [], []
    for key in sorted(reports):
        reps = sorted(reports[key], key=lambda r: (order[r[0]], r[1]))
        primary_id = owner_slice(key, [r[0] for r in reps])
        primary = next(r for r in reps if r[0] == primary_id)
        others = [r for r in reps if r is not primary]
        merged = dict(primary[2])
        for f in LIST_FIELDS:
            merged[f] = union(primary[2][f], *[o[2][f] for o in others])
        merged['verification'] = primary[3]
        merged['slice'] = primary_id
        also = []
        for sid, _i, norm, verif in others:
            differing = {f: norm[f] for f in SCALAR_FIELDS if norm[f] != primary[2][f]}
            contributed = {f: [x for x in norm[f] if x not in primary[2][f]] for f in LIST_FIELDS}
            contributed = {f: v for f, v in contributed.items() if v}
            also.append({'slice': sid, 'verification': verif, 'differing_fields': differing,
                         'contributed_list_items': contributed})
        merged['also_reported_by'] = also
        if also:
            duplicates.append({
                'key': key, 'primary': primary_id, 'also': [a['slice'] for a in also],
                'differing_fields': sorted({f for a in also for f in a['differing_fields']}),
                'classification': [primary[2]['classification']] + [a['differing_fields'].get(
                    'classification', primary[2]['classification']) for a in also],
            })
        rows.append(merged)
    row_by_key = {r['key']: r for r in rows}

    # ---------------- candidatos y disposición
    registry_key_of = {}
    for cap, rkey, inv_rows, _line in CAPABILITIES:
        for k in inv_rows:
            registry_key_of[k] = (cap, rkey)
    candidates, missing_disposition = [], []
    for r in rows:
        classes = [r['classification']] + [a['differing_fields'].get('classification', r['classification'])
                                           for a in r['also_reported_by']]
        kinds = [decision_kind(r['proposed_decision'])] + [decision_kind(a['differing_fields'].get(
            'proposed_decision', r['proposed_decision'])) for a in r['also_reported_by']]
        is_candidate = any(c in CANDIDATE_CLASSES for c in classes) or any(k in CANDIDATE_KINDS for k in kinds)
        cap = registry_key_of.get(r['key'])
        consolidation = {
            'proposed_decision_kind': decision_kind(r['proposed_decision']),
            'capability': cap[0] if cap else None,
            'registry_key': cap[1] if cap else None,
            'plan_candidate': is_candidate,
            'disposition': None,
        }
        if is_candidate:
            if cap:
                code, owners, refs, note = D_INC, ('scope', 'periodic'), (), INCORPORATED_NOTES.get(
                    cap[1], 'Capacidad existente con su semántica acumulada y sus valores vigentes.')
            else:
                disp = disposition_for(r['key'])
                if disp is None:
                    missing_disposition.append(r['key'])
                    continue
                code, owners, refs, note = disp
            consolidation['disposition'] = code
            candidates.append({
                'key': r['key'], 'slice': r['slice'], 'also_reported_by': [a['slice'] for a in r['also_reported_by']],
                'classification': classes, 'proposed_decision_kind': kinds, 'evidence_status': r['evidence_status'],
                'current_value': r['current_value'], 'semantics': r['semantics'],
                'disposition': code, 'disposition_label': DISPOSITION_LABELS[code],
                'registry_key': cap[1] if cap else None,
                'owner_decisions': list(owners), 'canon_refs': list(refs), 'note': note,
            })
        r['consolidation'] = consolidation
    for r in rows:
        r.setdefault('consolidation', {
            'proposed_decision_kind': decision_kind(r['proposed_decision']), 'capability': None,
            'registry_key': None, 'plan_candidate': False, 'disposition': None})

    # ---------------- inconsistencias, huecos, conteo de capacidades, canon
    inconsistencies, gaps = [], []
    for n, s in enumerate(slices, 1):
        for i, item in enumerate(s['data'].get('inconsistencies', []), 1):
            inconsistencies.append(dict({'id': 'V%d-INC-%02d' % (n, i), 'slice': s['id']}, **item))
        for i, item in enumerate(s['data'].get('enforcement_gaps', []), 1):
            gaps.append(dict({'id': 'V%d-GAP-%02d' % (n, i), 'slice': s['id']}, **item))
    detail = []
    for s in slices:
        for item in s['data'].get('capability_counting', []):
            detail.append(dict({'slice': s['id']}, **item))
    detail_by_cap = {d['capability']: d for d in detail}
    base_ent = run_git(git_root, 'show', '%s:%s' % (BASE_SHA, ENTITLEMENTS_REL)).decode('utf-8').split('\n')
    known_line = next(i for i, ln in enumerate(base_ent, 1) if 'export const KNOWN_CAPABILITIES' in ln)
    known_caps = re.findall(r"'([a-z_]+)'", base_ent[known_line - 1])
    capabilities = []
    for cap, rkey, inv_rows, line in CAPABILITIES:
        sql = re.search(r"%s: ['\"](.*)['\"],\s*$" % cap, base_ent[line - 1])
        d = detail_by_cap.get(cap)
        rows_info = [{'key': k, 'slice': row_by_key[k]['slice'], 'semantics': row_by_key[k]['semantics'],
                      'period_reset': row_by_key[k]['period_reset'], 'evidence_status': row_by_key[k]['evidence_status']}
                     for k in inv_rows]
        seeded = parse_seeded_values(row_by_key[inv_rows[0]]['current_value'])
        capabilities.append({
            'capability': cap,
            'registry_key': rkey,
            'inventory_rows': rows_info,
            'counted_today': {
                'sql': sql.group(1) if sql else None,
                'path_line': '%s:%d' % (ENTITLEMENTS_REL, line),
                'evidence_status': 'HECHO',
            },
            'seeded_values': {p: seeded.get(p) for p in SEEDED_PLANS},
            'seeded_values_text': row_by_key[inv_rows[0]]['current_value'],
            'detail_slice': d['slice'] if d else None,
            'consumption_moment': d['consumption_moment'] if d else None,
            'release': d['release'] if d else None,
            'period': d['period'] if d else None,
            'units_per_event': d['units_per_event'] if d else None,
            'enforcement_points': row_by_key[inv_rows[0]]['enforcement_points'],
            'check': row_by_key[inv_rows[0]]['check'],
            'risks': row_by_key[inv_rows[0]]['risks'],
        })
    v5 = next(s for s in slices if s['id'] == 'V5-canon-governance')['data']
    od_list = []
    for od in v5.get('open_decisions', []):
        st = OD_SESSION_STATUS.get(od['id'])
        item = dict({'slice': 'V5-canon-governance'}, **od)
        item['consolidation_session_status'] = None if st is None else {
            'status': st[0], 'label': OD_STATUS_LABELS[st[0]], 'owner_decisions': list(st[1]),
            'evidence_status': st[2], 'note': st[3]}
        od_list.append(item)
    cf_list = []
    for cf in v5.get('conflicts', []):
        st = CF_SESSION_STATUS.get(cf['id'])
        item = dict({'slice': 'V5-canon-governance'}, **cf)
        item['consolidation_session_status'] = None if st is None else {
            'status': st[0], 'label': CF_STATUS_LABELS[st[0]], 'owner_decisions': list(st[1]),
            'evidence_status': st[2], 'note': st[3]}
        cf_list.append(item)
    canon = {
        'items': [dict({'slice': 'V5-canon-governance'}, **x) for x in v5.get('canon_items', [])],
        'tier_rules': [dict({'slice': 'V5-canon-governance'}, **x) for x in v5.get('tier_rules', [])],
        'open_decisions': od_list,
        'conflicts': cf_list,
        'owner_decisions_session': {
            'date': OWNER_DECISIONS_DATE,
            'source': 'Respuestas literales del propietario en la conversación OMP de esta sesión; registro canónico '
                      'SRC-0013 + DEC-0075 (a cargo del registro canónico de la sesión, no de este inventario).',
            'canonical_record_files': [p for p in CANON_RECORD_FILES if os.path.isfile(os.path.join(ROOT, p))],
            'decisions': [dict(d) for d in OWNER_DECISIONS],
            'excluded': {'id': OWNER_DECISION_EXCLUDED[0], 'reason': OWNER_DECISION_EXCLUDED[1]},
        },
        'registration_precedent': v5.get('registration_precedent'),
        'owner_decisions_required_v5': v5.get('owner_decisions_required'),
    }

    # ---------------- registro del incremento
    registry = None
    reg_path = os.path.join(ROOT, REGISTRY_REL)
    if os.path.isfile(reg_path):
        with open(reg_path, encoding='utf-8') as fh:
            parsed = parse_registry(fh.read())
        params = []
        for p in parsed['parameters']:
            cap_entry = next((c for c in capabilities if c['capability'] == p['capability']), None)
            seeded = cap_entry['seeded_values'] if cap_entry else {}
            params.append(dict(p, **{
                'inventory_rows': [x['key'] for x in cap_entry['inventory_rows']] if cap_entry else [],
                'revision_1_values': {k: (v if v is not None else 0) for k, v in seeded.items()},
                'revision_1_absent_deny': [k for k, v in seeded.items() if v is None],
                'suggested_equals_pilot_value': (p['suggested'] == seeded.get('plan_piloto_1')) if seeded else None,
            }))
        registry = {
            'source': REGISTRY_REL,
            'source_note': 'Árbol de trabajo del incremento (no forma parte del commit base); se lee al generar.',
            'registry_version': parsed['registry_version'],
            'count_sanity_max': parsed['count_sanity_max'],
            'parameters': params,
            'base_known_capabilities': known_caps,
            'base_known_capabilities_path_line': '%s:%d' % (ENTITLEMENTS_REL, known_line),
            'capabilities_equal_base': sorted(p['capability'] for p in params) == sorted(known_caps),
            'new_parameters': [p['key'] for p in params if p['capability'] not in known_caps],
        }

    # ---------------- cobertura
    all_paths = sorted(repo.files)
    declared_by_slice, per_slice = {}, []
    declared_full, declared_partial = set(), set()

    def in_universe(paths):
        return sorted(p for p in paths if p.split('/', 1)[0] in COVERAGE_DIRS)

    for s in slices:
        d = s['data']
        full = set()
        for e in d.get('files_read', []):
            full.update(declared_paths(e, all_paths))
        partial = set()
        for e in d.get('files_partially_read', []):
            partial.update(declared_paths(e, all_paths))
        not_read = set()
        for e in d.get('files_not_read', []):
            not_read.update(declared_paths(e, all_paths))
        declared_by_slice[s['id']] = full | partial
        declared_full |= full
        declared_partial |= partial
        per_slice.append({
            'slice': s['id'],
            'files_read': d.get('files_read', []),
            'files_partially_read': d.get('files_partially_read', []),
            'files_not_read': d.get('files_not_read', []),
            'resolved_tracked_files': {
                'read': len(full), 'partially_read': len(partial - full), 'declared_not_read': len(not_read),
                'read_in_coverage_dirs': len(in_universe(full)),
                'partially_read_in_coverage_dirs': len(in_universe(partial - full)),
            },
        })

    # ---------------- documento (sin la comprobación de referencias)
    resolver = Resolver(repo, externals, handoff, FsIndex(ROOT, 'node_modules/'), AbsIndex(), declared_by_slice)
    doc = {
        'schema': 'mainspot.plan-parameters-inventory/consolidated-v1',
        'generated_by': SCRIPT_REL,
        'base_sha': BASE_SHA,
        'evidence_trees': {
            'repository_base': BASE_SHA,
            'handoff': {'ref': HANDOFF_REF, 'commit': HANDOFF_SHA, 'directory': HANDOFF_DIR},
            'external': external_meta,
            'node_modules': 'Dependencias instaladas en el árbol de trabajo (no rastreadas; versión fijada por '
                            'package-lock.json).',
        },
        'slices': [{
            'id': s['id'], 'file': s['file'], 'sha256': s['sha256'], 'base_sha': s['data'].get('base_sha'),
            'scope': s['data'].get('scope'), 'seed_summary': s['data'].get('seed_summary'),
            'seed_summary_extended': s['data'].get('seed_summary_extended'),
            'rows': len(s['data']['rows']), 'inconsistencies': len(s['data'].get('inconsistencies', [])),
            'enforcement_gaps': len(s['data'].get('enforcement_gaps', [])),
            'verification_status_counts': dict(sorted(Counter(r['verification']['status']
                                                               for r in s['data']['rows']).items())),
            'notes': s['data'].get('notes'),
        } for s in slices],
        'method': {},
        'summary': {},
        'rows': rows,
        'duplicates': duplicates,
        'equivalent_keys': [{'concept': c, 'keys': list(k), 'slices': [row_by_key[x]['slice'] for x in k]}
                            for c, k in EQUIVALENT_KEYS],
        'inconsistencies': inconsistencies,
        'enforcement_gaps': gaps,
        'capability_counting': {'capabilities': capabilities, 'detail': detail},
        'canon': canon,
        'plan_registry': registry,
        'plan_candidates': candidates,
        'slice_extras': {s['id']: {k: s['data'][k] for k in (
            'readers_writers', 'injection_points', 'platform_route_matrix', 'third_party_uncommitted')
            if k in s['data']} for s in slices},
        'coverage': {'per_slice': per_slice},
        'reference_check': {},
    }

    # ---------------- referencias: comprobar, corregir rangos N+1 y volver a comprobar
    first = resolver.check_document(doc, slice_ids)
    corrections = off_by_one_corrections(first)
    doc = apply_corrections(doc, corrections)
    results = resolver.check_document(doc, slice_ids)

    # ---------------- cobertura (necesita las referencias resueltas)
    # Universo: archivos rastreados (git ls-files) que existen en el commit base de los slices; las rutas que el
    # incremento agregue al índice no forman parte del inventario y no lo desestabilizan.
    tracked = {p for p in run_git(git_root, 'ls-files', '-z', '--', *COVERAGE_DIRS).decode('utf-8').split('\0') if p}
    universe = sorted(p for p in all_paths if p.split('/', 1)[0] in COVERAGE_DIRS and p in tracked)
    cited = set()
    for r in results:
        # Solo citas resueltas a un único archivo del repositorio (las ambiguas no cuentan como cobertura).
        if r['status'] in ('ok', 'ok_context') and len(r['_cands']) == 1 and r['_cands'][0][0] is repo:
            cited.add(r['_cands'][0][1])
    uni = set(universe)
    full_u = uni & declared_full
    partial_u = (uni & declared_partial) - full_u
    cited_only = (uni & cited) - full_u - partial_u
    not_covered = sorted(uni - full_u - partial_u - cited_only)
    by_dir = lambda paths: {d: sum(1 for p in paths if p.split('/', 1)[0] == d) for d in COVERAGE_DIRS}
    doc['coverage'] = {
        'universe': {
            'definition': 'git ls-files -- %s, limitado a las rutas presentes en el commit base %s (las rutas '
                          'nuevas del incremento no forman parte del inventario).' % (' '.join(COVERAGE_DIRS), BASE_SHA),
            'count': len(universe), 'by_dir': by_dir(universe),
        },
        'read_fully': {'count': len(full_u), 'by_dir': by_dir(full_u)},
        'read_partially': {'count': len(partial_u), 'by_dir': by_dir(partial_u)},
        'cited_only': {'count': len(cited_only), 'by_dir': by_dir(cited_only), 'files': sorted(cited_only)},
        'not_covered': {'count': len(not_covered), 'by_dir': by_dir(not_covered), 'files': not_covered},
        'per_slice': doc['coverage']['per_slice'],
    }

    # ---------------- resumen de la comprobación de referencias
    status_counts = Counter(r['status'] for r in results)
    ref_summary = {
        'definition': 'Toda cita ruta:línea (también rangos y listas «a-b,c») de cualquier cadena de este JSON. '
                      'Rutas completas: se resuelven contra el árbol fijado (commit base, handoff, repositorios '
                      'externos por commit, node_modules instalado). Abreviaturas (nombre de archivo, ID de canon, '
                      'número de migración, «:N» tras otra cita): por contexto de la misma cadena o registro, '
                      'convención declarada por los slices y sufijo único.',
        'total': len(results),
        'by_kind': dict(sorted(Counter(r['kind'] for r in results).items())),
        'by_index': dict(sorted(Counter(r['candidates'][0]['index'] if r['candidates'] else 'none'
                                        for r in results).items())),
        'by_status': {k: status_counts.get(k, 0) for k in OK_STATUSES + BROKEN_STATUSES},
        'broken': sum(status_counts.get(k, 0) for k in BROKEN_STATUSES),
        'corrections_applied': [{k: v for k, v in c.items() if not k.startswith('_')}
                                for _t, c in sorted(corrections.items())],
        'before_corrections': {
            'total': len(first),
            'by_status': {k: Counter(r['status'] for r in first).get(k, 0) for k in OK_STATUSES + BROKEN_STATUSES},
        },
        'ambiguous': [{'location': r['location'], 'kind': r['kind'], 'lines': r['lines'], 'status': r['status'],
                       'candidates': r['candidates']} for r in results if r['status'].startswith('ambiguous')],
        'broken_list': [{'location': r['location'], 'kind': r['kind'], 'lines': r['lines'], 'status': r['status'],
                         'candidates': r['candidates']} for r in results if r['status'] in BROKEN_STATUSES],
        'unpinned': [{'location': r['location'], 'lines': r['lines'], 'candidates': r['candidates']}
                     for r in results if r['candidates'] and r['candidates'][0]['index'] in ('absolute_unpinned',)],
    }
    doc['reference_check'] = ref_summary

    # ---------------- método y resumen
    seed_tot = Counter()
    for s in slices:
        for k in ('seed_rows', 'confirmed', 'corrected', 'rejected', 'new'):
            seed_tot[k] += s['data']['seed_summary'].get(k, 0)
    doc['method'] = {
        'merge_rule': 'Una fila por key. Si varios slices reportan la misma key, la fila primaria es la del slice '
                      'dueño del dominio (prefix_owner) y, si no aplica, la del primer slice en orden V1..V5. '
                      'Las listas (sources, dependencies, enforcement_points, ui_consumers, error_or_copy) se unen '
                      'sin duplicados (primero la primaria). Los campos escalares distintos y la verificación de cada '
                      'slice secundario quedan en also_reported_by.',
        'prefix_owner': [{'prefix': p, 'slice': s} for p, s in PREFIX_OWNER],
        'type_normalization': {
            'description': 'Solo tipos: current_value numérico → texto; dependencies y error_or_copy en texto → '
                           'lista de un elemento. Ningún valor cambia.',
            'counts_in_slice_rows': dict(sorted(type_norm.items())),
        },
        'candidate_rule': 'Candidato a parámetro de plan: alguna clasificación commercial_plan/tenant_preference o '
                          'alguna proposed_decision plan_parameter/tenant_preference_bounded_by_plan entre los '
                          'slices que reportan la key.',
        'evidence_markers': {'HECHO': 'leído y comprobado en el árbol', 'INFERENCIA': 'deducido, marcado',
                             'PROPUESTA': 'no existe hoy en el código'},
    }
    doc['summary'] = {
        'slices': len(slices),
        'rows_in_slices': sum(len(s['data']['rows']) for s in slices),
        'definitions': len(rows),
        'duplicate_keys': len(duplicates),
        'duplicate_keys_by_report_count': dict(sorted(Counter(1 + len(d['also']) for d in duplicates).items())),
        'seed_totals': dict(seed_tot),
        'verification_status_rows_in_slices': dict(sorted(Counter(
            r['verification']['status'] for s in slices for r in s['data']['rows']).items())),
        'by_classification': {c: sum(1 for r in rows if r['classification'] == c) for c in CLASSIFICATIONS},
        'by_evidence_status': dict(sorted(Counter(r['evidence_status'] for r in rows).items())),
        'by_proposed_decision_kind': {k: sum(1 for r in rows if r['consolidation']['proposed_decision_kind'] == k)
                                      for k in DECISION_KINDS + ('other',)},
        'by_slice': {sid: sum(1 for r in rows if r['slice'] == sid) for sid in slice_ids},
        'inconsistencies': {'total': len(inconsistencies),
                            'by_assessment': dict(sorted(Counter(i['assessment'] for i in inconsistencies).items()))},
        'enforcement_gaps': {'total': len(gaps),
                             'by_severity': {k: sum(1 for g in gaps if g['severity'] == k) for k in ('high', 'medium', 'low')}},
        'plan_candidates': {'total': len(candidates),
                            'by_disposition': {k: sum(1 for c in candidates if c['disposition'] == k)
                                               for k in DISPOSITION_ORDER}},
        'reference_check': {'total': ref_summary['total'], 'broken': ref_summary['broken'],
                            'corrected_off_by_one': len(corrections)},
    }
    # Limpieza de campos internos
    for r in results:
        r.pop('_cands', None)
        r.pop('_items', None)
    diagnostics = {
        'missing_disposition': missing_disposition,
        'resolver': resolver,
    }
    return doc, diagnostics


# =============================================================================================
# Salidas
# =============================================================================================
CSV_COLUMNS = (
    'key', 'slice', 'also_reported_by', 'classification', 'proposed_decision_kind', 'proposed_decision',
    'evidence_status', 'verification_status', 'seed_key', 'description', 'current_value', 'unit', 'type', 'scope',
    'semantics', 'period_reset', 'hard_upper_bound', 'check', 'sources', 'dependencies', 'enforcement_points',
    'ui_consumers', 'error_or_copy', 'risks', 'verification_notes', 'capability', 'registry_key', 'plan_candidate',
    'disposition',
)


def render_json(doc):
    return json.dumps(doc, ensure_ascii=False, indent=1) + '\n'


def render_csv(doc):
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator='\n')
    w.writerow(CSV_COLUMNS)
    for r in doc['rows']:
        v = r['verification'] or {}
        c = r['consolidation']
        w.writerow([
            r['key'], r['slice'],
            ' | '.join('%s (%s)' % (a['slice'], (a['verification'] or {}).get('status')) for a in r['also_reported_by']),
            r['classification'], c['proposed_decision_kind'], r['proposed_decision'], r['evidence_status'],
            v.get('status'), v.get('seed_key') or '', r['description'], r['current_value'], r['unit'], r['type'],
            r['scope'], r['semantics'], r['period_reset'], r['hard_upper_bound'], r['check'],
            ' | '.join(r['sources']), ' | '.join(map(str, r['dependencies'])),
            ' | '.join(map(str, r['enforcement_points'])), ' | '.join(map(str, r['ui_consumers'])),
            ' | '.join(map(str, r['error_or_copy'])), r['risks'], v.get('notes', ''),
            c['capability'] or '', c['registry_key'] or '', 'sí' if c['plan_candidate'] else 'no',
            c['disposition'] or '',
        ])
    return buf.getvalue()


def cell(text, limit=None):
    t = '' if text is None else str(text)
    t = t.replace('\r', ' ').replace('\n', ' ').replace('|', '\\|').strip()
    if limit and len(t) > limit:
        t = t[:limit - 1].rstrip() + '…'
    return t


def table(header, rows):
    out = ['| ' + ' | '.join(header) + ' |', '|' + '|'.join('---' for _ in header) + '|']
    for r in rows:
        out.append('| ' + ' | '.join(r) + ' |')
    return '\n'.join(out)


def short_slice(sid):
    return sid.split('-', 1)[0]


def render_md(doc):
    S = doc['summary']
    rc = doc['reference_check']
    cov = doc['coverage']
    out = []
    add = out.append
    add('# Inventario consolidado de parámetros por plan — MainSpot')
    add('')
    add('Generado por `%s` (determinista, solo biblioteca estándar) a partir de los cinco slices verificados de `%s/`. '
        'No se edita a mano: se regenera con `python3 %s` y se comprueba con `--check`. Datos completos: '
        '`plan-parameters-inventory.json` (fuente consolidada) y `plan-parameters-inventory.csv` (una fila por '
        'definición).' % (SCRIPT_REL, SLICES_REL, SCRIPT_REL))
    add('')
    add('Marcas de evidencia, como en los slices: **HECHO** = leído y comprobado en el árbol; **INFERENCIA** = '
        'deducido; **PROPUESTA** = no existe hoy en el código. Este documento no contiene cifras comerciales nuevas: '
        'los únicos valores por plan son los sembrados en `migrations/0009_subscriptions_plans.sql` (sin precio ni '
        'aprobación comercial) y los valores PROPOSED de la landing solo se citan como excluidos.')
    add('')

    # 1 -------------------------------------------------------------------------------------
    add('## 1. Método y cobertura')
    add('')
    add('- **HECHO** Base de evidencia: commit `%s`. Las citas `ruta:línea` del inventario apuntan a ese commit '
        '(`git show %s:<ruta>`), al handoff `%s` fijado en `%s` y a los repositorios externos fijados por commit '
        '(%s).' % (doc['base_sha'], doc['base_sha'][:7], HANDOFF_REF, HANDOFF_SHA[:7],
                   ', '.join('`%s` en `%s`' % (e['repository'], e['commit'][:7]) for e in doc['evidence_trees']['external'])))
    add('- **HECHO** La semilla de la sesión anterior (`inventory-S1..S4.json` y `canon-S5.json`, producida por otra '
        'sesión y tratada solo como lista de hipótesis) se re-verificó fila por fila contra el árbol base en esta '
        'sesión por cinco investigadores (Claude Opus 5.5, esfuerzo máximo), uno por slice. Resultado (filas de '
        'parámetros):')
    add('')
    seed_rows = []
    for s in doc['slices']:
        ss = s['seed_summary']
        seed_rows.append([s['id'], str(ss['seed_rows']), str(ss['confirmed']), str(ss['corrected']),
                          str(ss['rejected']), str(ss['new']), str(s['rows']), '`%s`' % s['sha256'][:12]])
    t = S['seed_totals']
    seed_rows.append(['**Total**', '**%d**' % t['seed_rows'], '**%d**' % t['confirmed'], '**%d**' % t['corrected'],
                      '**%d**' % t['rejected'], '**%d**' % t['new'], '**%d**' % S['rows_in_slices'], ''])
    add(table(['Slice', 'Filas semilla', 'CONFIRMED', 'CORRECTED', 'REJECTED', 'NEW', 'Filas del slice',
               'sha256 del slice'], seed_rows))
    add('')
    v5 = next(s for s in doc['slices'] if s['id'] == 'V5-canon-governance')
    ext = v5.get('seed_summary_extended') or {}
    if ext:
        add('- **HECHO** V5 re-verificó además las secciones de canon de su semilla:')
        add('')
        ext_rows = []
        for name, label in (('canon_items', 'Ítems de canon'), ('tier_rules', 'Reglas de tier'),
                            ('open_decisions', 'Decisiones abiertas'), ('conflicts', 'Conflictos'),
                            ('inconsistencies', 'Inconsistencias'), ('enforcement_gaps', 'Huecos de enforcement')):
            e = ext.get(name, {})
            ext_rows.append([label, str(e.get('seed', 0)), str(e.get('CONFIRMED', 0)), str(e.get('CORRECTED', 0)),
                             str(e.get('REJECTED', 0)), str(e.get('NEW', 0)), str(e.get('total', 0))])
        add(table(['Sección', 'Semilla', 'CONFIRMED', 'CORRECTED', 'REJECTED', 'NEW', 'Total'], ext_rows))
        add('')
    add('- **HECHO** Fusión: %d filas de los slices → **%d definiciones** (una por `key`). %d claves aparecen en más '
        'de un slice (%s). La fila primaria es la del slice dueño del dominio (tabla `method.prefix_owner` del JSON) '
        'y, si no aplica, la del primer slice; las listas (`sources`, `dependencies`, `enforcement_points`, '
        '`ui_consumers`, `error_or_copy`) se unen sin perder elementos y los campos escalares distintos quedan en '
        '`also_reported_by[].differing_fields`.' % (
            S['rows_in_slices'], S['definitions'], S['duplicate_keys'],
            ', '.join('%d en %d slices' % (n, k) for k, n in sorted(S['duplicate_keys_by_report_count'].items()))))
    tn = doc['method']['type_normalization']['counts_in_slice_rows']
    add('- **HECHO** Normalización solo de tipos (sin cambiar valores): %s.' % (
        '; '.join('`%s` en %d filas' % (k, v) for k, v in tn.items()) or 'ninguna'))
    disc = [d for d in doc['duplicates'] if d['differing_fields']]
    add('- **HECHO** Claves repetidas con campos distintos entre slices (%d de %d); se conserva la primaria y la otra '
        'lectura queda en `also_reported_by`:' % (len(disc), len(doc['duplicates'])))
    add('')
    add(table(['Clave', 'Primaria', 'También', 'Campos distintos', 'Clasificaciones'],
              [[cell('`%s`' % d['key']), short_slice(d['primary']), ', '.join(short_slice(a) for a in d['also']),
                cell(', '.join(d['differing_fields'])), cell(' / '.join(d['classification']))] for d in doc['duplicates']]))
    add('')
    add('- **HECHO** Claves distintas que describen la misma definición (no se fusionan; la fusión es solo por `key`): '
        'las 6 capacidades (ver §4) y %s.' % '; '.join(
            '%s: %s' % (e['concept'], ', '.join('`%s` (%s)' % (k, short_slice(s)) for k, s in zip(e['keys'], e['slices'])))
            for e in doc['equivalent_keys']))
    add('')
    add('### Comprobación mecánica de referencias `ruta:línea`')
    add('')
    bs = rc['by_status']
    add('- **HECHO** %d referencias detectadas en el JSON consolidado (%s). Resultado: %d resueltas de forma única '
        'por ruta completa, %d abreviadas resueltas por contexto o convención, %d ambiguas en rango en todos sus '
        'candidatos, %d ambiguas en rango en al menos uno, **%d fuera de rango** y **%d sin resolver**.' % (
            rc['total'], ', '.join('%s %d' % (k, v) for k, v in rc['by_kind'].items()), bs['ok'], bs['ok_context'],
            bs['ambiguous_all'], bs['ambiguous_some'], bs['out_of_range'], bs['unresolved']))
    before = rc['before_corrections']['by_status']
    if rc['corrections_applied']:
        add('- **HECHO** Antes de consolidar había %d fuera de rango y %d sin resolver: %d citas de rango hasta el '
            'final de archivo usaban la línea N+1 (archivos de N líneas que terminan en salto). En la salida se acotan '
            'a N (lista en `reference_check.corrections_applied`); los slices no se modifican:' % (
                before['out_of_range'], before['unresolved'], len(rc['corrections_applied'])))
        add('')
        add(table(['Archivo', 'Líneas en el slice', 'Líneas consolidadas', 'Líneas del archivo', 'Apariciones'],
                  [['`%s`' % c['path'], c['original_lines'], c['corrected_lines'], str(c['line_count']),
                    str(len(c['locations']))] for c in rc['corrections_applied']]))
        add('')
    add('- **HECHO** Índices usados: %s. Las abreviaturas `:N` y los nombres cortos se resuelven por contexto (la cita previa '
        'de la misma cadena o un archivo del mismo registro) y quedan marcados como tales en '
        '`reference_check`; una cita ambigua no es rota si cae en rango en algún candidato, pero no queda '
        'verificada de forma única [INFERENCIA sobre la intención del autor].' % ', '.join(
            '%s %d' % (k, v) for k, v in rc['by_index'].items()))
    if rc['unpinned']:
        add('- **HECHO** %d citas apuntan a %s, fuera de los árboles fijados por commit (metadatos git compartidos por '
            'los worktrees): se comprobaron contra el archivo actual, solo lectura, sin fijación por commit.' % (
                len(rc['unpinned']), ', '.join(sorted({'`%s`' % u['candidates'][0]['path'] for u in rc['unpinned']}))))
    add('- **HECHO** Las referencias con ruta completa de este MD se vuelven a comprobar al generarlo: `merge.py` sale '
        'con código 1 si alguna referencia del JSON o del MD queda fuera de rango o sin resolver.')
    add('')
    add('### Cobertura de archivos rastreados')
    add('')
    u = cov['universe']
    add('- **HECHO** Universo: %d archivos rastreados bajo `src/`, `migrations/`, `scripts/` y `tests/` (%s): '
        '`git ls-files -- src migrations scripts tests`, limitado a las rutas presentes en el commit base `%s` '
        '(las rutas nuevas del incremento no forman parte del inventario).' % (
            u['count'], ', '.join('%s %d' % (k, v) for k, v in u['by_dir'].items()), doc['base_sha'][:7]))
    add('- **HECHO** Declarados leídos completos por algún slice: %d; leídos parcialmente (rangos o grep): %d; solo '
        'citados por alguna referencia resuelta: %d; **no cubiertos por ningún slice: %d** (%s).' % (
            cov['read_fully']['count'], cov['read_partially']['count'], cov['cited_only']['count'],
            cov['not_covered']['count'], ', '.join('%s %d' % (k, v) for k, v in cov['not_covered']['by_dir'].items())))
    add('')
    add(table(['Slice', 'Entradas leídas', 'Entradas parciales', 'Entradas no leídas', 'Archivos resueltos (completos)',
               'Archivos resueltos (parciales)'],
              [[p['slice'], str(len(p['files_read'])), str(len(p['files_partially_read'])),
                str(len(p['files_not_read'])), str(p['resolved_tracked_files']['read']),
                str(p['resolved_tracked_files']['partially_read'])] for p in cov['per_slice']]))
    add('')
    if cov['not_covered']['files']:
        add('Archivos rastreados no cubiertos por ningún slice (ni leídos ni citados):')
        add('')
        for d in COVERAGE_DIRS:
            files = [f for f in cov['not_covered']['files'] if f.split('/', 1)[0] == d]
            if files:
                add('- `%s/` (%d): %s' % (d, len(files), ', '.join('`%s`' % f for f in files)))
        add('')

    # 2 -------------------------------------------------------------------------------------
    add('## 2. Resumen por clasificación')
    add('')
    add('**HECHO** Definiciones consolidadas por clasificación (fila primaria) y slice:')
    add('')
    slice_ids = [s['id'] for s in doc['slices']]
    cls_rows = []
    for c in CLASSIFICATIONS:
        counts = [sum(1 for r in doc['rows'] if r['classification'] == c and r['slice'] == sid) for sid in slice_ids]
        cls_rows.append(['`%s`' % c] + [str(n) for n in counts] + ['**%d**' % sum(counts)])
    cls_rows.append(['**Total**'] + ['**%d**' % S['by_slice'][sid] for sid in slice_ids] + ['**%d**' % S['definitions']])
    add(table(['Clasificación'] + [short_slice(s) for s in slice_ids] + ['Total'], cls_rows))
    add('')
    add('- Evidencia de las definiciones: %s.' % ', '.join('%s %d' % (k, v) for k, v in S['by_evidence_status'].items()))
    add('- Decisión propuesta (tipo): %s (`other` = valores fuera del vocabulario del contrato, p. ej. «keep» o '
        '«decisión del propietario» en V5).' % ', '.join('%s %d' % (k, v) for k, v in S['by_proposed_decision_kind'].items()))
    add('- Verificación de las %d filas de los slices: %s.' % (
        S['rows_in_slices'], ', '.join('%s %d' % (k, v) for k, v in S['verification_status_rows_in_slices'].items())))
    add('')

    # 3 -------------------------------------------------------------------------------------
    add('## 3. Candidatos `commercial_plan` / `tenant_preference`')
    add('')
    add('**HECHO** %d definiciones son candidatas: alguna clasificación `commercial_plan`/`tenant_preference` o alguna '
        'decisión propuesta `plan_parameter`/`tenant_preference_bounded_by_plan` entre los slices que las reportan. '
        'Valores completos y propuestas en el JSON (`plan_candidates`, `rows`). «Disposición» usa los códigos de §11: '
        '`%s` (§10), `%s`, `%s`, `%s` y `%s`.' % ((len(doc['plan_candidates']),) + DISPOSITION_ORDER))
    add('')
    cand_rows = []
    for c in doc['plan_candidates']:
        value = c['current_value']
        if c['key'].startswith('commercial.landing.'):
            value = 'PROPOSED de la landing (no contractual; cifras solo en el JSON)'
        cand_rows.append([
            '`%s`' % c['key'], ', '.join(short_slice(x) for x in [c['slice']] + c['also_reported_by']),
            cell(' / '.join(dict.fromkeys(c['classification']))), cell(value, 140), c['semantics'],
            c['evidence_status'], cell(' / '.join(dict.fromkeys(c['proposed_decision_kind']))), c['disposition']])
    add(table(['Clave', 'Slice', 'Clasificación', 'Valor vigente', 'Semántica', 'Evidencia', 'Decisión propuesta',
               'Disposición'], cand_rows))
    add('')

    # 4 -------------------------------------------------------------------------------------
    add('## 4. Conteo actual de las 6 capacidades')
    add('')
    caps = doc['capability_counting']['capabilities']
    add('**HECHO** En el commit base el uso de cada capacidad es `count(*)` de filas de dominio del negocio más las '
        'reservas vivas del libro de cuotas, sin período (acumulado de por vida); `fitsLimit` deniega sin límite '
        'configurado. Consulta exacta por capacidad (`src/subscriptions/entitlements.ts`, base):')
    add('')
    cap_rows = []
    for c in caps:
        sv = c['seeded_values']
        cap_rows.append([
            '`%s`' % c['capability'], cell('`%s`' % c['counted_today']['sql']), c['counted_today']['path_line'],
            ' / '.join('—' if sv[p] is None else str(sv[p]) for p in SEEDED_PLANS),
            cell(c['period'] or ', '.join(sorted({r['period_reset'] for r in c['inventory_rows']}))),
            ', '.join('`%s` (%s, %s)' % (r['key'], short_slice(r['slice']), r['semantics']) for r in c['inventory_rows'])])
    add(table(['Capacidad', 'Uso contado hoy', 'Ruta', 'Sembrado piloto / básico / completo (— = sin fila ⇒ deny)',
               'Período', 'Filas del inventario (slice, semántica)'], cap_rows))
    add('')
    mixed = [c for c in caps if len({r['semantics'] for r in c['inventory_rows']}) > 1]
    if mixed:
        reg = doc['plan_registry']
        reg_sem = {p['capability']: p['semantics'] for p in reg['parameters']} if reg else {}
        add('- **HECHO** Las filas del inventario discrepan en la semántica de %s; el registro del incremento declara %s '
            '(§10). El uso contado es el mismo en ambas filas: filas de dominio de por vida, sin ruta de borrado que '
            'libere cupo.' % (
                ', '.join('`%s` (%s)' % (c['capability'], ', '.join('%s %s' % (short_slice(r['slice']), r['semantics'])
                                                                   for r in c['inventory_rows'])) for c in mixed),
                ', '.join('`%s` = `%s`' % (c['capability'], reg_sem.get(c['capability'], '—')) for c in mixed)))
        add('')
    for c in caps:
        add('### `%s` → `%s`' % (c['capability'], c['registry_key']))
        add('')
        add('- **HECHO** Valores sembrados (0009): %s' % cell(c['seeded_values_text']))
        if c['consumption_moment']:
            add('- **HECHO** Momento de consumo (%s): %s' % (short_slice(c['detail_slice']), cell(c['consumption_moment'])))
            add('- **HECHO** Unidades por evento: %s. Liberación: %s' % (cell(c['units_per_event']), cell(c['release'])))
        else:
            add('- **HECHO** Comprobación (%s): %s' % (short_slice(c['inventory_rows'][0]['slice']), cell(c['check'])))
            add('- **HECHO** Puntos de enforcement: %s' % cell('; '.join(map(str, c['enforcement_points']))))
            add('- **HECHO** Riesgos: %s' % cell(c['risks']))
        add('')
    det = [d for d in doc['capability_counting']['detail'] if d.get('entrypoints')]
    if det:
        add('**HECHO** Entradas por capacidad (V3): si pasan por el libro de cuotas y si el deny se audita.')
        add('')
        ent_rows = []
        for d in det:
            for e in d['entrypoints']:
                ent_rows.append(['`%s`' % d['capability'], cell(e.get('entrypoint')), cell(e.get('path_line')),
                                 cell(e.get('passes_quota_ledger')), cell(e.get('deny_audited', 'n/a'))])
        add(table(['Capacidad', 'Entrada', 'Ruta', 'QuotaLedger', 'Deny auditado'], ent_rows))
        add('')
    nocap = [d for d in doc['capability_counting']['detail'] if d.get('activities')]
    for d in nocap:
        add('**HECHO** Actividad con coste o efecto externo que hoy no consume ninguna capacidad (V3):')
        add('')
        add(table(['Actividad', 'Ruta', 'Nota'], [[cell(a['activity']), cell(a['path_line']), cell(a.get('notes'))]
                                                 for a in d['activities']]))
        add('')

    # 5 -------------------------------------------------------------------------------------
    add('## 5. Inconsistencias')
    add('')
    inc = doc['inconsistencies']
    add('**HECHO** %d inconsistencias reportadas por los slices (%s). `drift` = mismo concepto con valores distintos '
        '(normalizar); `distinct_concepts` = conceptos distintos que solo comparten nombre o cifra; `unclear` = sin '
        'evidencia suficiente para decidir.' % (len(inc), ', '.join(
            '%s %d' % (k, v) for k, v in S['inconsistencies']['by_assessment'].items())))
    add('')
    for assess in ('drift', 'distinct_concepts', 'unclear'):
        items = [i for i in inc if i['assessment'] == assess]
        if not items:
            continue
        add('### `%s` (%d)' % (assess, len(items)))
        add('')
        add(table(['ID', 'Concepto', 'Valores (valor — ruta)', 'Evidencia'],
                  [[i['id'], cell(i['concept']),
                    cell('; '.join('%s — %s' % (v.get('value'), v.get('path_line')) if isinstance(v, dict) else str(v)
                                   for v in i['values'])), cell(i['evidence_status'])] for i in items]))
        add('')

    # 6 -------------------------------------------------------------------------------------
    add('## 6. Huecos de enforcement por severidad')
    add('')
    g = doc['enforcement_gaps']
    add('**HECHO** %d huecos (%s).' % (len(g), ', '.join('%s %d' % (k, v) for k, v in S['enforcement_gaps']['by_severity'].items())))
    add('')
    for sev in ('high', 'medium', 'low'):
        items = [x for x in g if x['severity'] == sev]
        add('### `%s` (%d)' % (sev, len(items)))
        add('')
        add(table(['ID', 'Descripción', 'Ruta', 'Evidencia'],
                  [[x['id'], cell(x['description']), cell(x['path_line']), cell(x['evidence_status'])] for x in items]))
        add('')

    # 7 -------------------------------------------------------------------------------------
    od = doc['canon']['owner_decisions_session']
    add('## 7. Decisiones del propietario ya tomadas (%s)' % od['date'])
    add('')
    files = od.get('canonical_record_files') or []
    add('**HECHO** Respuestas literales del propietario en esta sesión (conversación OMP). Su registro canónico es '
        'SRC-0013 (fuente literal con sha256) + DEC-0075 con deltas de BR-0007/FR-0010/FR-0018/FR-0019, a cargo del '
        'registro canónico de la sesión (%s); este inventario las cita y no crea ni edita canon.' % (
            ', '.join('`%s`' % f for f in files) if files else 'archivos aún no presentes en el árbol de trabajo'))
    add('')
    add(table(['ID', 'Pregunta', 'Opciones', 'Respuesta', 'Efecto declarado en la opción elegida'],
              [['`%s`' % d['id'], cell(d['question']), cell(' · '.join(d['options'])), '**%s**' % cell(d['answer']),
                cell(d['answer_detail'])] for d in od['decisions']]))
    add('')
    add('- **HECHO** `%s`: %s' % (od['excluded']['id'], od['excluded']['reason']))
    add('- **HECHO** La selección vacía de `scope` no rechaza ni aprueba sus cuatro opciones: solo las deja fuera de '
        'este incremento (así lo registra DEC-0075). Por eso en §11 figuran como «ofrecida y no seleccionada».')
    add('')

    # 8 -------------------------------------------------------------------------------------
    add('## 8. Decisiones abiertas (OD) tras estas respuestas')
    add('')
    ods = doc['canon']['open_decisions']
    st_count = Counter(o['consolidation_session_status']['status'] for o in ods if o['consolidation_session_status'])
    add('Correspondencia de las %d decisiones abiertas de V5 con las respuestas: **HECHO** cuando la respuesta literal '
        'contesta la misma pregunta; **INFERENCIA** cuando solo la toca en parte. Recuento: %s.' % (
            len(ods), ', '.join('%s %d' % (OD_STATUS_LABELS[k], st_count.get(k, 0)) for k in OD_STATUS_LABELS)))
    add('')
    add(table(['OD', 'Pregunta', 'Tier', 'Estado', 'Respuestas', 'Evidencia', 'Nota'],
              [[o['id'], cell(o['question_es'], 220), cell(o['tier'], 60),
                o['consolidation_session_status']['label'] if o['consolidation_session_status'] else 'sin evaluar',
                ', '.join('`%s`' % x for x in (o['consolidation_session_status'] or {}).get('owner_decisions', [])),
                (o['consolidation_session_status'] or {}).get('evidence_status', ''),
                cell((o['consolidation_session_status'] or {}).get('note', ''))] for o in ods]))
    add('')
    still = [o['id'] for o in ods if o['consolidation_session_status'] and o['consolidation_session_status']['status'] in ('abierta', 'parcial')]
    add('Siguen abiertas o parciales: %s.' % ', '.join(still))
    add('')

    # 9 -------------------------------------------------------------------------------------
    add('## 9. Conflictos canon/handoff y cómo quedan')
    add('')
    cfs = doc['canon']['conflicts']
    add('Estado de los %d conflictos de V5 tras las respuestas del propietario (**HECHO** cuando la respuesta literal '
        'resuelve el conflicto; los rechazados lo fueron en la verificación de V5).' % len(cfs))
    add('')
    add(table(['CF', 'Conflicto', 'Verificación V5', 'Cambio de canon', 'Cómo queda', 'Respuestas', 'Evidencia', 'Nota'],
              [[c['id'], cell(c['description_es'], 260), c['status'], cell(c['requires_canon_change'], 80),
                c['consolidation_session_status']['label'] if c['consolidation_session_status'] else 'sin evaluar',
                ', '.join('`%s`' % x for x in (c['consolidation_session_status'] or {}).get('owner_decisions', [])),
                (c['consolidation_session_status'] or {}).get('evidence_status', ''),
                cell((c['consolidation_session_status'] or {}).get('note', ''))] for c in cfs]))
    add('')

    # 10 ------------------------------------------------------------------------------------
    add('## 10. Qué entró al registro de plan en este incremento')
    add('')
    reg = doc['plan_registry']
    if reg is None:
        add('**HECHO** `%s` no existe en el árbol de trabajo: no hay registro que describir.' % REGISTRY_REL)
    else:
        add('**HECHO** Registro tipado `%s` (versión %s; leído del árbol de trabajo del incremento al generar): %d '
            'parámetros, uno por capacidad existente. Capacidades del registro = `KNOWN_CAPABILITIES` del commit base '
            '(`%s`): **%s**; parámetros nuevos: %s.' % (
                reg['source'], reg['registry_version'], len(reg['parameters']), reg['base_known_capabilities_path_line'],
                'sí' if reg['capabilities_equal_base'] else 'no',
                ', '.join('`%s`' % k for k in reg['new_parameters']) or 'ninguno'))
        add('')
        add(table(['Clave', 'Capacidad', 'Etiqueta', 'Semántica', 'Período', 'Rango', 'Sugerido', '¿= plan_piloto_1?',
                   'Enforcement', 'Revisión 1 piloto / básico / completo', 'Filas del inventario'],
                  [['`%s`' % p['key'], p['capability'], cell(p['label']), p['semantics'], p['period'],
                    '%s..%s' % (p['min'], '{:,}'.format(p['max']) if isinstance(p['max'], int) else p['max']),
                    str(p['suggested']), 'sí' if p['suggested_equals_pilot_value'] else 'no', p['enforcement'],
                    ' / '.join(str(p['revision_1_values'].get(x, '')) + ('*' if x in p['revision_1_absent_deny'] else '')
                               for x in SEEDED_PLANS),
                    ', '.join('`%s`' % k for k in p['inventory_rows'])] for p in reg['parameters']]))
        add('')
        add('- **HECHO** `*` = sin fila en `plan_limit`: la migración `migrations/0034_plan_policy_catalog.sql` la '
            'explicita como 0 con origen `backfill_absent_deny` (mismo efecto deny que hoy). Todas las suscripciones '
            'vigentes quedan fijadas a la revisión 1 de su plan (decisión `revision_policy`).')
        add('- **HECHO** Los sugeridos son los valores vigentes de `plan_piloto_1`, sin aprobación comercial '
            '(decisión `publish_meaning`). Techos: `quota.website.max` = 1 por `client_website.tenant_id` UNIQUE; el '
            'resto = %s como límite de validación (no es oferta ni «ilimitado»).' % '{:,}'.format(reg['count_sanity_max']))
        add('- **HECHO** El registro declara las 6 definiciones como `%s`; el libro de cuotas admite además `stock`, '
            '`periodic`, `rate_window` y `eligibility` como mecanismo, pero ningún parámetro real las usa (decisión '
            '`periodic`: sin activar hasta HDC-MSP-06).' % '/'.join(sorted({p['semantics'] for p in reg['parameters']})))
    add('')

    # 11 ------------------------------------------------------------------------------------
    add('## 11. Exclusiones con motivo')
    add('')
    cands = doc['plan_candidates']
    bd = S['plan_candidates']['by_disposition']
    add('**HECHO** De %d candidatos, %d filas corresponden a las 6 capacidades incorporadas y %d quedan fuera del '
        'registro. Los motivos de exclusión son tres (alcance vacío decidido por el propietario, canon que lo difiere, '
        'techo técnico); además, %d candidatos no definen un valor por plan (semántica, contrato, presentación o '
        'gobierno) y por eso no son parámetros del registro. Las respuestas y el canon citados son **HECHO** (literal '
        'del propietario o verificado por V5); la asignación de cada fila a un motivo es criterio de esta consolidación '
        '(**INFERENCIA** razonada en la columna «Motivo»). La columna «Evidencia» es la de la fila del inventario.' % (
            len(cands), bd[D_INC], len(cands) - bd[D_INC], bd[D_NOPARAM]))
    add('')
    add(table(['Disposición', 'Filas'], [[DISPOSITION_LABELS[k], str(bd[k])] for k in DISPOSITION_ORDER]))
    add('')
    for code in DISPOSITION_ORDER[1:]:
        items = [c for c in cands if c['disposition'] == code]
        if not items:
            continue
        add('### %s (%d)' % (DISPOSITION_LABELS[code], len(items)))
        add('')
        add(table(['Clave', 'Slice', 'Evidencia', 'Respuestas del propietario', 'Canon / OD / CF', 'Motivo'],
                  [['`%s`' % c['key'], ', '.join(short_slice(x) for x in [c['slice']] + c['also_reported_by']),
                    c['evidence_status'], ', '.join('`%s`' % x for x in c['owner_decisions']) or '—',
                    ', '.join(c['canon_refs']) or '—', cell(c['note'])] for c in items]))
        add('')

    # 12 ------------------------------------------------------------------------------------
    add('## 12. Límites del inventario')
    add('')
    limits = [
        '**HECHO** Las citas `ruta:línea` valen para el commit base `%s`. Este incremento modifica en el árbol de '
        'trabajo archivos citados (p. ej. `src/subscriptions/quota.ts`, `src/subscriptions/entitlements.ts`, '
        '`src/api/platform-routes.ts`, `src/api/subscription-routes.ts`, `src/rbac/matrix.ts`, '
        '`src/identity/onboarding.ts`, `src/retention/service.ts`, vistas del panel y la consola, `README.md` y los '
        'archivos de `.canonflow/` con los deltas de DEC-0075): ahí las líneas pueden estar desplazadas; léanse con '
        '`git show %s:<ruta>`.' % (doc['base_sha'][:7], doc['base_sha'][:7]),
        '**HECHO** Los archivos nuevos del incremento (`src/plans/*`, `src/platform/permissions.ts`, '
        '`src/api/plan-catalog-routes.ts`, `migrations/0034_plan_policy_catalog.sql`, pruebas nuevas) no forman parte '
        'del inventario; solo se lee `%s` para la §10.' % REGISTRY_REL,
        '**HECHO** Ningún slice ejecutó la app, las pruebas, las migraciones ni la red; los valores vigentes en una BD '
        'existente pueden diferir de las semillas (p. ej. `ensureAiCatalog` no sobrescribe casos de uso, presupuestos '
        'ni rutas existentes, y los presupuestos globales se editan por API).',
        '**HECHO** Las lecturas parciales (rangos o grep) están declaradas por slice; ningún slice declara '
        'exhaustividad por grep. %d archivos rastreados de `src/`, `migrations/`, `scripts/` y `tests/` no se '
        'leyeron ni se citan (§1).' % cov['not_covered']['count'],
        '**INFERENCIA** Las abreviaturas `:N` y los nombres de archivo cortos se resolvieron por contexto; %d citas '
        'quedan ambiguas aunque en rango (§1).' % (bs['ambiguous_all'] + bs['ambiguous_some']),
        '**HECHO** La fusión es solo por `key`: definiciones equivalentes con claves distintas siguen separadas '
        '(§1, §4).',
        '**HECHO** Los cambios sin commitear del checkout de terceros (`/home/administrador/codeart/mainspoot/'
        'mainspot-platform`) no se inventariaron; varios slices los listan sin leerlos (`slice_extras.*.'
        'third_party_uncommitted`), entre ellos las migraciones 0032/0033 sin seguimiento.',
        '**HECHO** HDC-MSP-06 y ROADMAP-MVP-REAL-20261020 v0.4 no existen como archivos en los repositorios revisados '
        '(V5); solo se nombran en DEC-0010 y QS-0004.',
        '**INFERENCIA** La zona horaria de la sesión PostgreSQL (día de `tenant_day`, mes de la consola) no se '
        'observó; los límites de proveedores (Telegram, Google, Meta) no están codificados.',
        '**INFERENCIA** La correspondencia OD/CF ↔ respuestas (§8, §9) es una lectura de la consolidación; el registro '
        'canónico (DEC-0075) prevalece.',
    ]
    for item in limits:
        add('- ' + item)
    add('')
    return '\n'.join(out)


def main(argv):
    check_only = '--check' in argv
    git_root = ROOT
    doc, diag = build(git_root)
    if diag['missing_disposition']:
        print('ERROR: candidatos sin disposición: %s' % ', '.join(diag['missing_disposition']), file=sys.stderr)
        return 1
    outputs = {'json': render_json(doc), 'csv': render_csv(doc), 'md': render_md(doc)}
    # Referencias completas del MD: deben resolverse en rango (las abreviadas se comprobaron en el JSON).
    md_refs = [r for r in diag['resolver'].check_string(('md',), outputs['md'], ('md',), [], ())
               if r['kind'] in ('path', 'git', 'absolute')]
    md_broken = sorted({r['token'] for r in md_refs if r['status'] not in ('ok', 'ok_context')})
    rc = doc['reference_check']
    status = 0
    if rc['broken']:
        print('ERROR: %d referencias rotas o sin resolver' % rc['broken'], file=sys.stderr)
        status = 1
    if md_broken:
        print('ERROR: referencias del MD fuera de rango o sin resolver: %s' % ', '.join(md_broken), file=sys.stderr)
        status = 1
    if check_only:
        for kind, rel in OUTPUTS:
            path = os.path.join(ROOT, rel)
            current = open(path, encoding='utf-8').read() if os.path.isfile(path) else None
            if current != outputs[kind]:
                print('DIFIERE: %s' % rel, file=sys.stderr)
                status = 1
        if status == 0:
            print('OK: las tres salidas coinciden con lo generado')
        return status
    for kind, rel in OUTPUTS:
        with open(os.path.join(ROOT, rel), 'w', encoding='utf-8', newline='\n') as fh:
            fh.write(outputs[kind])
    s = doc['summary']
    print('definiciones=%d filas_slices=%d duplicadas=%d referencias=%d rotas=%d corregidas=%d candidatos=%d '
          'no_cubiertos=%d referencias_md_completas=%d rotas_md=%d' % (
              s['definitions'], s['rows_in_slices'], s['duplicate_keys'], rc['total'], rc['broken'],
              len(rc['corrections_applied']), len(doc['plan_candidates']),
              doc['coverage']['not_covered']['count'], len(md_refs), len(md_broken)))
    return status


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
