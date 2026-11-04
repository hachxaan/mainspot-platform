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

  // La demo NO realiza ninguna petición externa y nunca atribuye publicaciones reales.
  // Calificación y contenido son filtros independientes; la autonomía exige consentimiento previo.
  const scenarios = {
    positive: {
      name: 'José M.', initials: 'JM', stars: 5, mode: 'auto',
      review: '“El café delicioso y me atendieron con mucha amabilidad. ¡Volveremos!”',
      heading: 'MainSpot respondió automáticamente',
      explain: 'Detectó un agradecimiento sencillo de 5 estrellas, sin riesgo. La categoría ya estaba autorizada por el dueño del negocio.',
      reply: '¡Muchas gracias por visitarnos, José! Nos alegra que hayas disfrutado el café. Será un gusto recibirte otra vez.'
    },
    fourStar: {
      name: 'Lucía G.', initials: 'LG', stars: 4, mode: 'auto',
      review: '“Muy buena atención. Nos gustó mucho el lugar y sin duda volveremos.”',
      heading: 'MainSpot respondió automáticamente',
      explain: 'Una reseña de 4 estrellas con contenido positivo y seguro. No fue necesario interrumpir al propietario.',
      reply: '¡Gracias por compartir tu experiencia, Lucía! Nos da mucho gusto saber que disfrutaste tu visita. Te esperamos pronto.'
    },
    question: {
      name: 'Andrea C.', initials: 'AC', stars: 5, mode: 'human',
      review: '“¡Excelente café! ¿Me pueden ofrecer un descuento especial para un evento de 40 personas?”',
      heading: 'Cinco estrellas, pero requiere tu decisión',
      explain: 'Aunque la reseña es positiva, solicita una condición comercial que MainSpot no puede prometer. Te propone cómo responder sin comprometer al negocio.',
      replies: [
        '¡Gracias por tu comentario, Andrea! Para conocer las opciones disponibles para tu evento, escríbenos por mensaje privado.',
        'Nos alegra que hayas disfrutado el café, Andrea. Con gusto podemos revisar los detalles de tu evento por nuestros canales de contacto.',
        '¡Muchas gracias, Andrea! Envíanos un mensaje con los detalles de tu evento y nuestro equipo podrá orientarte.'
      ]
    },
    complaint: {
      name: 'Mariana R.', initials: 'MR', stars: 2, mode: 'human',
      review: '“Fui ayer por la tarde y mi pedido no estaba listo. Me fui sin poder comprar.”',
      heading: 'Una reseña de 2 estrellas necesita tu atención',
      explain: 'Las reseñas de 1 a 3 estrellas pasan a revisión humana, aunque parezcan sencillas. Aquí puedes elegir o ajustar una respuesta.',
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
    const isAuto = data.mode === 'auto';
    $('#review-name').textContent = data.name;
    $('#review-avatar').textContent = data.initials;
    $('#review-stars').textContent = '★'.repeat(data.stars) + '☆'.repeat(5 - data.stars);
    $('#review-stars').setAttribute('aria-label', `${data.stars} de 5 estrellas`);
    $('#review-text').textContent = data.review;
    $('#assistant-heading').textContent = data.heading;
    $('#assistant-explainer').textContent = data.explain;
    $$('.scenario').forEach(button => {
      const active = button.dataset.scenario === activeScenario;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    $('#demo-auto-result').hidden = !isAuto;
    $('#demo-human-result').hidden = isAuto;
    if (isAuto) {
      $('#demo-auto-text').textContent = data.reply;
      return;
    }
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
    $('#decision-status').textContent = finished
      ? 'Ejemplo aprobado en esta pantalla. No se envió nada a Google.'
      : 'Pendiente de tu decisión · no se ha publicado.';
  }
  $$('.scenario').forEach(button => button.addEventListener('click', () => {
    activeScenario = button.dataset.scenario;
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
  $('#demo-approve').addEventListener('click', () => {
    if (scenarios[activeScenario].mode !== 'human' || finished) return;
    finished = true;
    renderDemo();
  });
  $('#demo-reset').addEventListener('click', () => {
    activeScenario = 'positive';
    chosenReply = 0;
    finished = false;
    renderDemo();
  });
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