const form = document.querySelector('#password-reset-request-form');
const statusEl = document.querySelector('#password-reset-request-status');
const emailInput = document.querySelector('#password-reset-email');
const emailError = document.querySelector('#password-reset-email-error');

function setStatus(message = '', state = 'idle') {
  if (!statusEl) {
    return;
  }

  statusEl.textContent = message;
  statusEl.dataset.state = state;
  statusEl.hidden = !message;
  statusEl.classList.remove('pending', 'success', 'error');

  if (state === 'pending' || state === 'success' || state === 'error') {
    statusEl.classList.add(state);
  }

  if (state === 'error') {
    statusEl.setAttribute('role', 'alert');
  } else {
    statusEl.setAttribute('role', 'status');
  }

  if (state === 'error' && !statusEl.hasAttribute('tabindex')) {
    statusEl.setAttribute('tabindex', '-1');
  }

  if (state === 'error') {
    try {
      statusEl.focus({ preventScroll: true });
    } catch (focusError) {
      try {
        statusEl.focus();
      } catch (fallbackError) {
        // ignore focus issues in older browsers
      }
    }
  }
}

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
  setStatus('', 'idle');

  if (!emailInput) {
    return;
  }

  if (!emailInput.value) {
    setFieldValidity(emailInput, emailError, 'Add meg az e-mail címedet.');
    setStatus('Ellenőrizd a kiemelt mezőt.', 'error');
    return;
  }

  if (!emailInput.checkValidity()) {
    setFieldValidity(emailInput, emailError, 'Érvényes e-mail címet adj meg.');
    setStatus('Ellenőrizd a kiemelt mezőt.', 'error');
    return;
  }

  setFieldValidity(emailInput, emailError);

  const submitButton = form.querySelector('button[type="submit"]');
  submitButton?.setAttribute('disabled', 'true');
  submitButton?.setAttribute('aria-busy', 'true');
  setStatus('Kérés feldolgozása…', 'pending');

  try {
    const payload = { email: emailInput.value };
    const response = await requestJSON('/api/password-reset/request', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    setStatus(
      response?.message ||
        'Ha a megadott e-mail címmel létezik fiók, hamarosan levelet küldünk a folytatáshoz.',
      'success',
    );
    form.setAttribute('data-complete', 'true');
    emailInput.setAttribute('readonly', 'true');
  } catch (error) {
    submitButton?.removeAttribute('disabled');
    submitButton?.removeAttribute('aria-busy');

    const errorMessage =
      (typeof error?.message === 'string' && error.message.trim()) ||
      'Nem sikerült elküldeni a kérést.';

    if (errorMessage.toLowerCase().includes('e-mail')) {
      setFieldValidity(emailInput, emailError, 'Ellenőrizd az e-mail címet.');
    }
    setStatus(errorMessage, 'error');
    return;
  }

  submitButton?.setAttribute('disabled', 'true');
  submitButton?.removeAttribute('aria-busy');
  submitButton?.textContent = 'Kérés elküldve';
});
