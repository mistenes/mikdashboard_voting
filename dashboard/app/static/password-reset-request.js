const form = document.querySelector('#password-reset-request-form');
const statusEl = document.querySelector('#password-reset-request-status');
const emailInput = document.querySelector('#password-reset-email');
const emailError = document.querySelector('#password-reset-email-error');

function setFieldValidity(inputEl, errorEl, message = '') {
  const wrapper = inputEl?.closest('.auth-input');
  if (!wrapper || !errorEl) {
    return;
  }

  if (message) {
    wrapper.dataset.invalid = 'true';
    errorEl.textContent = message;
  } else {
    delete wrapper.dataset.invalid;
    errorEl.textContent = '';
  }
}

async function requestJSON(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json();
      detail = payload?.detail || '';
    } catch (_) {
      // ignore malformed error payloads
    }
    throw new Error(detail || 'Ismeretlen hiba történt.');
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

emailInput?.addEventListener('input', () => {
  if (emailInput.value) {
    setFieldValidity(emailInput, emailError);
  }
});

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  statusEl.textContent = '';
  statusEl.classList.remove('error', 'success');

  if (!emailInput) {
    return;
  }

  if (!emailInput.value) {
    setFieldValidity(emailInput, emailError, 'Add meg az e-mail címedet.');
    statusEl.textContent = 'Ellenőrizd a kiemelt mezőt.';
    statusEl.classList.add('error');
    return;
  }

  if (!emailInput.checkValidity()) {
    setFieldValidity(emailInput, emailError, 'Érvényes e-mail címet adj meg.');
    statusEl.textContent = 'Ellenőrizd a kiemelt mezőt.';
    statusEl.classList.add('error');
    return;
  }

  setFieldValidity(emailInput, emailError);

  const submitButton = form.querySelector('button[type="submit"]');
  submitButton?.setAttribute('disabled', 'true');
  submitButton?.setAttribute('aria-busy', 'true');

  try {
    const payload = { email: emailInput.value };
    const response = await requestJSON('/api/password-reset/request', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    statusEl.textContent = response?.message ||
      'Ha a megadott e-mail címmel létezik fiók, hamarosan levelet küldünk a folytatáshoz.';
    statusEl.classList.add('success');
    form.setAttribute('data-complete', 'true');
    emailInput.setAttribute('readonly', 'true');
  } catch (error) {
    submitButton?.removeAttribute('disabled');
    submitButton?.removeAttribute('aria-busy');

    if (error.message.toLowerCase().includes('e-mail')) {
      setFieldValidity(emailInput, emailError, 'Ellenőrizd az e-mail címet.');
    }
    statusEl.textContent = error.message || 'Nem sikerült elküldeni a kérést.';
    statusEl.classList.add('error');
    return;
  }

  submitButton?.setAttribute('disabled', 'true');
  submitButton?.removeAttribute('aria-busy');
  submitButton?.textContent = 'Kérés elküldve';
});
