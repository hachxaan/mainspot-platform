/* MainSpot commercial landing: self-contained illustrative interactions. No network calls. */
(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  const menuButton = $('.menu-toggle');
  const mobileNav = $('#mobile-nav');
  menuButton.addEventListener('click', () => {
    const isOpen = menuButton.getAttribute('aria-expanded') === 'true';
    menuButton.setAttribute('aria-expanded', String(!isOpen));
    menuButton.setAttribute('aria-label', isOpen ? 'Abrir menú' : 'Cerrar menú');
    mobileNav.hidden = isOpen;
  });
  $$('.mobile-nav a').forEach(a => a.addEventListener('click', () => {
    mobileNav.hidden = true;
    menuButton.setAttribute('aria-expanded', 'false');
    menuButton.setAttribute('aria-label', 'Abrir menú');
  }));

  const previewButton = $('#preview-toggle');
  const preview = $('#preview-result');
  previewButton.addEventListener('click', () => {
    const isOpen = previewButton.getAttribute('aria-expanded') === 'true';
    previewButton.setAttribute('aria-expanded', String(!isOpen));
    preview.hidden = isOpen;
    previewButton.firstChild.textContent = isOpen ? 'Ver cómo revisaría un cambio ' : 'Ocultar vista previa ';
  });

  const scenarios = {
    positive: {
      name: 'José M.', stars: 5,
      review: '“El café delicioso y me atendieron con mucha amabilidad. ¡Volveremos!”',
      heading: 'Una buena experiencia merece respuesta',
      explain: 'Preparé una respuesta amable para agradecer la visita. Tú puedes revisarla antes de publicarla.',
      replies: ['¡Muchas gracias por visitarnos, José! Nos alegra que hayas disfrutado el café. Será un gusto recibirte otra vez.']
    },
    complaint: {
      name: 'Mariana R.', stars: 2,
      review: '“Fui ayer por la tarde y mi pedido no estaba listo. Me fui sin poder comprar.”',
      heading: 'Esto necesita tu atención',
      explain: 'Detecté una queja. No responderé por mi cuenta: aquí tienes tres alternativas para que elijas o ajustes.',
      replies: [
        'Mariana, sentimos que tu visita no haya salido como esperabas. Nos gustaría conocer más detalles para atenderte personalmente.',
        'Gracias por contarnos lo ocurrido, Mariana. Lamentamos la molestia y queremos revisar tu experiencia directamente contigo.',
        'Mariana, agradecemos que nos lo hayas dicho. Tomamos en serio tus comentarios. ¿Podrías escribirnos por mensaje privado para conocer lo sucedido?'
      ]
    }
  };
  let activeScenario = 'positive';
  let chosenReply = 0;
  let finished = false;
  const replyOptions = $('#reply-options');
  function renderDemo() {
    const data = scenarios[activeScenario];
    $('#review-name').textContent = data.name;
    $('#review-stars').textContent = '★'.repeat(data.stars) + '☆'.repeat(5 - data.stars);
    $('#review-stars').setAttribute('aria-label', `${data.stars} de 5 estrellas`);
    $('#review-text').textContent = data.review;
    $('#assistant-heading').textContent = data.heading;
    $('#assistant-explainer').textContent = data.explain;
    $$('.scenario').forEach(b => {
      const active = b.dataset.scenario === activeScenario;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    replyOptions.replaceChildren(...data.replies.map((reply, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.reply = String(index);
      button.className = 'reply-option' + (chosenReply === index ? ' selected' : '');
      button.setAttribute('aria-pressed', String(chosenReply === index));
      const number = document.createElement('span');
      number.className = 'reply-index';
      number.textContent = String(index + 1).padStart(2, '0');
      const response = document.createElement('span');
      response.className = 'reply-text';
      response.textContent = reply;
      const check = document.createElement('span');
      check.className = 'reply-check';
      check.textContent = '✓';
      check.setAttribute('aria-hidden', 'true');
      button.append(number, response, check);
      return button;
    }));
    $('#demo-approve').disabled = finished;
    $('#demo-approve').style.opacity = finished ? '.55' : '1';
    $('#decision-status').textContent = finished ? 'Ejemplo completado. No se envió ni publicó ninguna respuesta.' : 'Aquí no se publica nada en cuentas reales.';
  }
  $$('.scenario').forEach(b => b.addEventListener('click', () => {
    activeScenario = b.dataset.scenario;
    chosenReply = 0;
    finished = false;
    renderDemo();
  }));
  replyOptions.addEventListener('click', (event) => {
    const button = event.target.closest('[data-reply]');
    if (!button || finished) return;
    chosenReply = Number(button.dataset.reply);
    renderDemo();
  });
  $('#demo-approve').addEventListener('click', () => { finished = true; renderDemo(); });
  $('#demo-reset').addEventListener('click', () => { activeScenario = 'positive'; chosenReply = 0; finished = false; renderDemo(); });
  renderDemo();

  const form = $('#interest-form');
  let preparedRequest = '';
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const fields = [$('#business-name'), $('#business-type'), $('#business-city'), $('#business-contact')];
    fields.forEach(f => f.setAttribute('aria-invalid', 'false'));
    const invalid = fields.find(field => !field.value.trim() || !field.checkValidity());
    if (invalid) {
      invalid.setAttribute('aria-invalid', 'true');
      $('#form-message').textContent = 'Revisa los campos obligatorios y escribe un correo válido.';
      invalid.focus();
      return;
    }
    const [name, type, city, email] = fields.map(field => field.value.trim());
    preparedRequest = `INTERÉS EN MAINSPOT\n\nNombre del negocio: ${name}\nActividad: ${type}\nCiudad: ${city}\nCorreo: ${email}\n\nMe interesa conocer las opciones piloto de MainSpot.`;
    $('#contact-summary').textContent = preparedRequest;
    form.hidden = true;
    $('#contact-result').hidden = false;
    $('#copy-status').textContent = '';
    $('#copy-request').focus();
  });
  $('#edit-request').addEventListener('click', () => {
    $('#contact-result').hidden = true;
    form.hidden = false;
    $('#business-name').focus();
  });
  $('#copy-request').addEventListener('click', async () => {
    try {
      if (!navigator.clipboard || !window.isSecureContext) throw new Error('clipboard_not_available');
      await navigator.clipboard.writeText(preparedRequest);
      $('#copy-status').textContent = 'Solicitud copiada. Aún no ha sido enviada.';
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents($('#contact-summary'));
      selection.removeAllRanges();
      selection.addRange(range);
      $('#copy-status').textContent = 'Seleccionamos el texto. Cópialo con Ctrl+C o el menú de tu teléfono. No se ha enviado.';
    }
  });
})();