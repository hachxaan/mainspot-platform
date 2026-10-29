/* =====================================================================
   MainSpot · Prototipo · Teléfonos por integración (contrato compartido §A)
   - Un teléfono principal editable en «Mi negocio».
   - Cada integración (Página web, Google Maps, Facebook) guarda su propio
     modo own|other y su PROPIO «otro número». No existe un número alternativo global.
   - effective(ch) = principal si mode=own; si no, el otro número de ese canal.
   - Validación E.164 con libphonenumber-js (local, sin red).
   ===================================================================== */
(function () {
  'use strict';
  var MS = window.MS;
  var esc = MS.esc, icon = MS.icon;
  var LP = window.libphonenumber;
  var S = function () { return MS.S; };

  var CH = {
    website: { label: 'Página web', where: 'tu página web', short: 'Página web', ic: 'globe' },
    google: { label: 'Google Maps', where: 'tu ficha de Google Maps', short: 'Google', ic: 'map-pin' },
    facebook: { label: 'Facebook', where: 'tu página de Facebook', short: 'Facebook', ic: 'message-square-text' }
  };
  var ORDER = ['website', 'google', 'facebook'];

  var PH = (MS.ph = { CH: CH, ORDER: ORDER });

  /* ---------- Países ---------- */
  var countries = null;
  PH.countries = function () {
    if (countries) return countries;
    var names;
    try { names = new Intl.DisplayNames(['es-MX', 'es'], { type: 'region' }); } catch (e) { names = null; }
    countries = LP.getCountries().map(function (iso) {
      var n = iso;
      try { n = names ? names.of(iso) : iso; } catch (e) { n = iso; }
      return { iso: iso, name: n, cc: '+' + LP.getCountryCallingCode(iso) };
    }).sort(function (a, b) { return a.name.localeCompare(b.name, 'es'); });
    return countries;
  };
  PH.country = function (iso) { return PH.countries().filter(function (c) { return c.iso === iso; })[0] || { iso: iso, name: iso, cc: '' }; };

  PH.options = function (selected) {
    var fav = ['MX', 'US', 'CA', 'GT', 'BZ', 'CO', 'ES'];
    var list = PH.countries();
    function opt(c) { return '<option value="' + c.iso + '"' + (c.iso === selected ? ' selected' : '') + '>' + esc(c.name) + ' ' + c.cc + '</option>'; }
    return '<optgroup label="Frecuentes">' + fav.map(function (i) { return opt(PH.country(i)); }).join('') + '</optgroup>' +
      '<optgroup label="Todos los países">' + list.filter(function (c) { return fav.indexOf(c.iso) < 0; }).map(opt).join('') + '</optgroup>';
  };

  /* ---------- Validación ---------- */
  PH.parse = function (iso, nat) {
    var raw = String(nat || '').trim();
    if (!raw) return { ok: false, error: 'Escribe el número.' };
    if (/[a-z]/i.test(raw)) return { ok: false, error: 'Usa solo números, espacios o guiones.' };
    var p = null;
    try { p = LP.parsePhoneNumberFromString(raw, iso); } catch (e) { p = null; }
    if (!p || !p.isValid()) return { ok: false, error: 'Este número no es válido para ' + PH.country(iso).name + '. Revisa los dígitos y el país.' };
    if (p.country && p.country !== iso && raw.charAt(0) === '+') return { ok: false, error: 'El prefijo que escribiste es de otro país. Elige ' + PH.country(p.country).name + ' en la lista o quita el prefijo.' };
    return { ok: true, iso: p.country || iso, nat: String(p.nationalNumber), e164: p.number, intl: p.formatInternational(), cc: '+' + p.countryCallingCode };
  };
  PH.fmt = function (ph) {
    if (!ph) return '';
    var r = PH.parse(ph.iso, ph.nat);
    return r.ok ? r.intl : ph.nat;
  };
  PH.national = function (ph) {
    try { var p = LP.parsePhoneNumberFromString(ph.nat, ph.iso); return p ? p.formatNational() : ph.nat; } catch (e) { return ph.nat; }
  };
  PH.e164 = function (ph) { var r = ph ? PH.parse(ph.iso, ph.nat) : null; return r && r.ok ? r.e164 : null; };

  /* ---------- Número efectivo por canal ---------- */
  PH.effective = function (ch) {
    var c = S().phones[ch];
    if (c.mode === 'other') return c.other ? { ph: c.other, intl: PH.fmt(c.other), e164: PH.e164(c.other), source: 'other' } : null;
    var p = S().primary;
    return p ? { ph: p, intl: PH.fmt(p), e164: PH.e164(p), source: 'own' } : null;
  };

  /* Borrador de edición por canal: vive en memoria para sobrevivir a redibujos. */
  MS.mem.phDraft = MS.mem.phDraft || {};
  PH.draft = function (ch) {
    var d = MS.mem.phDraft[ch];
    if (!d) {
      if (ch === 'primary') {
        var p = S().primary;
        d = { mode: 'own', iso: p ? p.iso : 'MX', nat: p ? PH.national(p) : '', error: '' };
      } else {
        var c = S().phones[ch];
        d = { mode: c.mode, iso: c.other ? c.other.iso : (S().primary ? S().primary.iso : 'MX'), nat: c.other ? PH.national(c.other) : '', error: '' };
      }
      MS.mem.phDraft[ch] = d;
    }
    return d;
  };
  PH.resetDraft = function (ch) { delete MS.mem.phDraft[ch]; };

  /* ---------- Guardar ---------- */
  PH.saveChannel = function (ch) {
    var d = PH.draft(ch), c = S().phones[ch];
    if (d.mode === 'own') {
      if (!S().primary) { d.error = 'Primero agrega tu número principal en Mi negocio.'; return { ok: false }; }
      c.mode = 'own'; // el «otro número» se conserva para poder retomarlo (TEL-04)
    } else {
      var r = PH.parse(d.iso, d.nat);
      if (!r.ok) { d.error = r.error; return { ok: false }; }
      c.mode = 'other';
      c.other = { iso: r.iso, nat: r.nat };
    }
    d.error = '';
    c.savedAt = Date.now();
    PH.resetDraft(ch);
    PH.propagate([ch]);
    return { ok: true };
  };

  PH.clearOther = function (ch) {
    var c = S().phones[ch];
    c.other = null;
    if (c.mode === 'other') c.mode = 'own';
    PH.resetDraft(ch);
    PH.propagate([ch]);
  };

  PH.savePrimary = function () {
    var d = PH.draft('primary');
    var r = PH.parse(d.iso, d.nat);
    if (!r.ok) { d.error = r.error; return { ok: false }; }
    S().primary = { iso: r.iso, nat: r.nat };
    d.error = '';
    PH.resetDraft('primary');
    var own = ORDER.filter(function (ch) { return S().phones[ch].mode === 'own'; });
    PH.propagate(own);
    return { ok: true, changed: own, kept: ORDER.filter(function (ch) { return own.indexOf(ch) < 0; }) };
  };

  /* Lleva el número efectivo a cada canal afectado y SOLO a esos. */
  PH.propagate = function (channels) {
    channels.forEach(function (ch) {
      var eff = PH.effective(ch);
      if (ch === 'website') PH.applyWebsite(eff);
      else PH.syncProvider(ch, eff);
    });
  };

  /* Página web: lo visible pasa por vista previa y aprobación (RULE-003). */
  PH.applyWebsite = function (eff) {
    var intl = eff ? eff.intl : '';
    S().biz.phone = intl;
    var pub = S().site.published;
    if (!pub) return; // aún no hay página publicada: la primera versión ya usa el número nuevo
    var pending = S().requests.filter(function (r) { return r.kind === 'phone' && (r.status === 'preview_ready' || r.status === 'expired'); })[0];
    if (pub.phone === intl) { if (pending) { pending.status = 'cancelled'; MS.addEvent(pending, 'Ya no hace falta: tu página tiene ese número', 'MainSpot'); } return; }
    if (pending) {
      pending.changes = [{ field: 'phone', label: 'Teléfono', before: pub.phone, after: intl }];
      pending.status = 'preview_ready';
      pending.revision = (pending.revision || 1) + 1;
      pending.preview = { readyAt: Date.now(), expiresAt: Date.now() + 3600000, rev: pending.revision };
      MS.addEvent(pending, 'Actualizamos la vista previa con el número nuevo', 'MainSpot');
      return;
    }
    var r = {
      id: MS.id('r'), kind: 'phone', title: 'Teléfono de tu página', channel: 'panel', text: '', by: MS.me().name,
      changes: [{ field: 'phone', label: 'Teléfono', before: pub.phone, after: intl }], status: 'preview_ready', createdAt: Date.now(), revision: 1, events: [],
      preview: { readyAt: Date.now(), expiresAt: Date.now() + 3600000, rev: 1 }
    };
    MS.addEvent(r, '[Cambiaste|Cambió] el teléfono de la página web', MS.me().name);
    MS.addEvent(r, 'Preparamos la vista previa', 'MainSpot');
    S().requests.unshift(r);
    MS.notify('approval', 'Tienes un cambio esperando tu aprobación', 'Teléfono de tu página', '#/vista-previa/' + r.id);
  };

  /* Google y Facebook: sincronización SIMULADA; nada cambia fuera de este prototipo. */
  PH.syncProvider = function (ch, eff) {
    var c = S().phones[ch], prov = S().prov[ch];
    if (!prov.connected) { c.sync = { state: 'waiting', at: Date.now(), intl: eff ? eff.intl : '' }; return; }
    if (prov.down) { c.sync = { state: 'failed', at: Date.now(), intl: eff ? eff.intl : '' }; return; }
    c.sync = { state: 'syncing', at: Date.now(), intl: eff ? eff.intl : '' };
    MS.later('sync-' + ch, 1600, function () {
      if (S().prov[ch].down) c.sync = { state: 'failed', at: Date.now(), intl: c.sync.intl };
      else c.sync = { state: 'ok', at: Date.now(), intl: c.sync.intl };
      MS.emit();
    });
  };
  PH.retrySync = function (ch) { PH.syncProvider(ch, PH.effective(ch)); };

  PH.syncLine = function (ch) {
    if (ch === 'website') {
      var pub = S().site.published, eff = PH.effective(ch);
      if (!pub) return { tone: 'neutral', text: 'Se mostrará cuando publiques tu página.' };
      var pend = S().requests.filter(function (r) { return r.kind === 'phone' && r.status === 'preview_ready'; })[0];
      if (pend) return { tone: 'rosa', text: 'Tu página aún muestra ' + pub.phone + '. Revisa la vista previa para publicar el número nuevo.', href: '#/vista-previa/' + pend.id, cta: 'Revisar vista previa' };
      var pubPend = S().site.pub && S().site.pub.state !== 'done';
      if (pubPend) return { tone: 'ocre', text: 'Estamos actualizando tu página.' };
      return { tone: 'nopal', text: eff && pub.phone === eff.intl ? 'Así aparece hoy en tu página.' : 'Tu página muestra ' + pub.phone + '.' };
    }
    var c = S().phones[ch], sy = c.sync, name = CH[ch].label;
    if (!S().prov[ch].connected) return { tone: 'neutral', text: 'Se aplicará cuando conectes ' + CH[ch].where + '.' };
    if (!sy) return { tone: 'nopal', text: 'Coincide con ' + name + ' (simulado).' };
    if (sy.state === 'syncing') return { tone: 'ocre', text: 'Actualizando en ' + name + '… (simulado)' };
    if (sy.state === 'failed') return { tone: 'alerta', text: name + ' no respondió. Tu número quedó guardado aquí y lo intentaremos de nuevo.', action: 'ph-retry', cta: 'Intentar de nuevo' };
    if (sy.state === 'waiting') return { tone: 'neutral', text: 'Se aplicará cuando conectes ' + CH[ch].where + '.' };
    return { tone: 'nopal', text: 'Actualizado en ' + name + ' ' + MS.when(sy.at) + ' (simulado).' };
  };

  /* ---------- Componentes ---------- */
  function numberFields(key, d) {
    return '<div class="phone-input">' +
      '<div class="field"><label for="ph-cc-' + key + '">País</label><select class="select" id="ph-cc-' + key + '" data-ph="' + key + '" data-ph-part="iso">' + PH.options(d.iso) + '</select></div>' +
      '<div class="field' + (d.error ? ' has-error' : '') + '" id="f-ph-num-' + key + '"><label for="ph-num-' + key + '">Número</label>' +
      '<div class="cc-wrap"><span class="cc" id="ph-ccl-' + key + '" aria-hidden="true">' + PH.country(d.iso).cc + '</span><input class="input" id="ph-num-' + key + '" data-ph="' + key + '" data-ph-part="nat" inputmode="tel" autocomplete="tel-national" value="' + esc(d.nat) + '"' + (d.error ? ' aria-invalid="true" aria-describedby="ph-err-' + key + '"' : '') + '></div>' +
      (d.error ? '<div class="field-error" id="ph-err-' + key + '">' + icon('circle-alert') + '<span>' + esc(d.error) + '</span></div>' : '') +
      '</div></div>';
  }

  PH.numberFields = numberFields;

  PH.previewText = function (key) {
    var d = PH.draft(key);
    if (key !== 'primary' && d.mode === 'own') return S().primary ? PH.fmt(S().primary) : 'Sin número principal';
    var r = PH.parse(d.iso, d.nat);
    return r.ok ? r.intl : (d.nat ? 'Número incompleto' : 'Escribe el número');
  };

  PH.isDirty = function (ch) {
    var d = MS.mem.phDraft[ch];
    if (!d) return false;
    if (ch === 'primary') { var p = S().primary; return !p || d.iso !== p.iso || d.nat.replace(/\D/g, '') !== p.nat; }
    var c = S().phones[ch];
    if (d.mode !== c.mode) return true;
    if (d.mode === 'other') return !c.other || d.iso !== c.other.iso || d.nat.replace(/\D/g, '') !== c.other.nat;
    return false;
  };

  /* Tarjeta de teléfono de UNA integración. */
  PH.card = function (ch, opts) {
    opts = opts || {};
    var info = CH[ch], c = S().phones[ch], d = PH.draft(ch);
    var canEdit = MS.can('editData');
    var prim = S().primary;
    var eff = PH.effective(ch);
    var line = PH.syncLine(ch);
    var html = '<section class="card phone-card" id="phone-' + ch + '" aria-labelledby="ph-t-' + ch + '">' +
      '<div class="section-title"><h2 id="ph-t-' + ch + '">Teléfono en ' + esc(info.label) + '</h2>' + MS.ui.tag(c.mode === 'other' ? 'Otro número' : 'Tu número', c.mode === 'other' ? 'lila' : 'neutral') + '</div>' +
      '<p class="muted small">Es el número que verán tus clientes en ' + esc(info.where) + '. No cambia los otros canales.</p>';
    if (!canEdit) {
      html += '<p class="eff-line">' + icon('phone', 'ic-sm') + '<strong>' + esc(eff ? eff.intl : 'Sin número') + '</strong></p><p class="tiny">Tu perfil puede ver este número, pero no cambiarlo.</p></section>';
      return html;
    }
    html += '<fieldset class="fieldset ph-modes"><legend class="sr-only">¿Qué número se muestra en ' + esc(info.label) + '?</legend>' +
      '<label class="radio-row' + (d.mode === 'own' ? ' is-on' : '') + '"><input type="radio" name="ph-mode-' + ch + '" value="own" data-ph="' + ch + '" data-ph-part="mode"' + (d.mode === 'own' ? ' checked' : '') + '><span><span class="rr-t">Usar mi número</span><span class="rr-s">' + (prim ? esc(PH.fmt(prim)) + ', tu número principal' : 'Aún no tienes número principal') + '</span></span></label>' +
      '<label class="radio-row' + (d.mode === 'other' ? ' is-on' : '') + '"><input type="radio" name="ph-mode-' + ch + '" value="other" data-ph="' + ch + '" data-ph-part="mode"' + (d.mode === 'other' ? ' checked' : '') + '><span><span class="rr-t">Otro número</span><span class="rr-s">Solo para ' + esc(info.label) + '</span></span></label>' +
      '</fieldset>';
    if (d.mode === 'other') html += numberFields(ch, d);
    if (d.mode === 'own' && !prim) {
      html += '<div class="banner banner-ocre">' + icon('info') + '<span><strong>Primero agrega tu número principal</strong>No inventamos un número: escríbelo en Mi negocio o elige «Otro número».<br>' + MS.ui.btn('Agregar mi número principal', { href: '#/negocio?ir=principal', sm: true, style: 'secondary' }) + '</span></div>';
    }
    if (d.mode === 'own' && c.other) {
      html += '<p class="tiny kept">Guardamos tu otro número de ' + esc(info.label) + ' (' + esc(PH.fmt(c.other)) + ') por si vuelves a usarlo. <button type="button" class="link-btn" style="min-height:auto;padding:0" data-action="ph-clear" data-arg="' + ch + '">Borrarlo</button></p>';
    }
    if (d.error && d.mode === 'own') html += '<div class="field-error">' + icon('circle-alert') + '<span>' + esc(d.error) + '</span></div>';
    html += '<div class="eff-box"><span class="k">Se verá en ' + esc(info.label) + '</span><strong id="ph-eff-' + ch + '">' + esc(PH.previewText(ch)) + '</strong></div>';
    html += '<div class="btn-row">' + MS.ui.btn('Guardar', { action: 'ph-save', arg: ch, style: PH.isDirty(ch) ? 'primary' : 'secondary', id: 'ph-save-' + ch }) +
      (PH.isDirty(ch) ? MS.ui.btn('Cancelar', { action: 'ph-cancel', arg: ch, style: 'ghost' }) : '') + '</div>';
    html += '<p class="sync-line sync-' + line.tone + '">' + icon(line.tone === 'nopal' ? 'circle-check' : (line.tone === 'alerta' ? 'triangle-alert' : (line.tone === 'ocre' ? 'hourglass' : 'info')), 'ic-sm') + '<span>' + esc(line.text) +
      (line.href ? ' <a href="' + line.href + '">' + esc(line.cta) + '</a>' : '') + (line.action ? ' <button type="button" class="link-btn" style="min-height:auto;padding:0" data-action="' + line.action + '" data-arg="' + ch + '">' + esc(line.cta) + '</button>' : '') + '</span></p>';
    if (ch !== 'website') html += MS.ui.note('Sincronización simulada: no se cambia nada en ' + info.label + '.');
    return html + '</section>';
  };

  /* Editor del número principal (Mi negocio). */
  PH.primaryCard = function () {
    var d = PH.draft('primary'), prim = S().primary;
    var html = '<section class="card phone-card" id="principal" aria-labelledby="ph-t-primary">' +
      '<div class="section-title"><h2 id="ph-t-primary">Tu número principal</h2></div>' +
      '<p class="muted small">Lo usan los canales donde elegiste «Usar mi número». No es el número de tu chat de Telegram.</p>';
    if (!MS.can('editData')) return html + '<p class="eff-line">' + icon('phone', 'ic-sm') + '<strong>' + esc(prim ? PH.fmt(prim) : 'Sin número principal') + '</strong></p></section>';
    if (!prim) html += '<div class="banner banner-ocre">' + icon('info') + '<span><strong>Aún no tienes número principal</strong>Escríbelo para que los canales con «Usar mi número» lo muestren.</span></div>';
    html += numberFields('primary', d) +
      '<div class="btn-row">' + MS.ui.btn('Guardar número principal', { action: 'ph-save', arg: 'primary', style: PH.isDirty('primary') ? 'primary' : 'secondary', id: 'ph-save-primary' }) + (PH.isDirty('primary') ? MS.ui.btn('Cancelar', { action: 'ph-cancel', arg: 'primary', style: 'ghost' }) : '') + '</div></section>';
    return html;
  };

  /* Resumen: qué número se ve en cada canal. */
  PH.overview = function () {
    return '<section class="card card-flush" aria-labelledby="ph-ov-t"><div class="section-title" style="padding:16px 16px 0"><h2 id="ph-ov-t">Qué número ve cada canal</h2></div><ul class="list">' +
      ORDER.map(function (ch) {
        var eff = PH.effective(ch), c = S().phones[ch];
        var href = (ch === 'website' ? '#/pagina' : '#/' + ch) + '?ir=phone-' + ch;
        return '<li><a class="list-row" href="' + href + '" data-ph-row="' + ch + '"><span class="lead">' + icon(CH[ch].ic) + '</span><span class="grow"><span class="title" style="display:block">' + esc(CH[ch].label) + '</span><span class="sub" style="display:block"><span data-ph-value="' + ch + '">' + esc(eff ? eff.intl : 'Sin número') + '</span>, ' + (c.mode === 'other' ? 'otro número' : 'tu número principal') + '</span></span>' + icon('chevron-right', 'chev') + '</a></li>';
      }).join('') + '</ul></section>';
  };

  /* ---------- Eventos de edición (sin redibujar mientras se escribe) ---------- */
  function onEdit(e) {
    var el = e.target;
    if (!el.dataset || !el.dataset.ph) return;
    var key = el.dataset.ph, part = el.dataset.phPart, d = PH.draft(key);
    if (part === 'mode') {
      d.mode = el.value; d.error = '';
      if (d.mode === 'other' && !d.nat) { d.iso = (S().phones[key].other || S().primary || { iso: 'MX' }).iso; }
      if (d.mode === 'other' && S().phones[key].other && !d.nat) d.nat = PH.national(S().phones[key].other);
      MS.render(false);
      var f = document.getElementById(d.mode === 'other' ? 'ph-num-' + key : el.id);
      var radio = document.querySelector('input[name="ph-mode-' + key + '"][value="' + d.mode + '"]');
      (radio || f) && (radio || f).focus({ preventScroll: true });
      return;
    }
    if (part === 'iso') { d.iso = el.value; var l = document.getElementById('ph-ccl-' + key); if (l) l.textContent = PH.country(d.iso).cc; }
    if (part === 'nat') d.nat = el.value;
    var out = document.getElementById('ph-eff-' + key);
    if (out) out.textContent = PH.previewText(key);
    var btn = document.getElementById('ph-save-' + key);
    if (btn && PH.isDirty(key)) { btn.classList.remove('btn-secondary'); btn.classList.add('btn-primary'); }
  }
  document.addEventListener('input', function (e) { if (e.target.dataset && e.target.dataset.ph && e.target.dataset.phPart === 'nat') onEdit(e); });
  document.addEventListener('change', function (e) { if (e.target.dataset && e.target.dataset.ph && (e.target.dataset.phPart === 'mode' || e.target.dataset.phPart === 'iso')) onEdit(e); });
})();
