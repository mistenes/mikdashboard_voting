const form = document.querySelector('#password-reset-confirm-form');
const statusEl = document.querySelector('#password-reset-confirm-status');
const summaryEl = document.querySelector('#password-reset-summary');
const newPasswordInput = document.querySelector('#password-reset-new');
const confirmPasswordInput = document.querySelector('#password-reset-confirm');
const newPasswordError = document.querySelector('#password-reset-new-error');
const confirmPasswordError = document.querySelector('#password-reset-confirm-error');

const pathSegments = window.location.pathname.split('/').filter(Boolean);
const resetToken = pathSegments[pathSegments.length - 1] || '';

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

async function initialize() {
  if (!resetToken) {
    summaryEl.textContent = 'Hiányzik a jelszó-visszaállító hivatkozás. Kérj új linket.';
    summaryEl.classList.add('error');
    return;
  }

  try {
    summaryEl.classList.remove('error');
    summaryEl.classList.remove('success');
    statusEl.classList.remove('error', 'success');
    const response = await requestJSON(`/api/password-reset/verify?token=${encodeURIComponent(resetToken)}`);
    const email = response?.email || '';
    summaryEl.innerHTML =
      email
        ? `A <strong>${email}</strong> fiókhoz tartozó jelszót állítjuk vissza. Adj meg egy új jelszót.`
        : 'Adj meg egy új jelszót az alábbi mezőkben.';
    summaryEl.classList.add('success');
    form?.removeAttribute('hidden');
    statusEl.textContent = response?.message || '';
    if (statusEl.textContent) {
      statusEl.classList.add('success');
    }
  } catch (error) {
    summaryEl.textContent = error.message || 'A jelszó-visszaállító link lejárt vagy érvénytelen.';
    summaryEl.classList.add('error');
    statusEl.classList.remove('success');
    statusEl.textContent = 'Kérj új jelszó-visszaállító linket a bejelentkezési oldalról.';
    statusEl.classList.add('error');
    if (form) {
      form.setAttribute('hidden', 'true');
    }
  }
}

newPasswordInput?.addEventListener('input', () => {
  if (newPasswordInput.value) {
    setFieldValidity(newPasswordInput, newPasswordError);
  }
});

confirmPasswordInput?.addEventListener('input', () => {
  if (confirmPasswordInput.value) {
    setFieldValidity(confirmPasswordInput, confirmPasswordError);
  }
});

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  statusEl.textContent = '';
  statusEl.classList.remove('error', 'success');

  if (!newPasswordInput || !confirmPasswordInput) {
    return;
  }

  let isValid = true;

  if (!newPasswordInput.value) {
    setFieldValidity(newPasswordInput, newPasswordError, 'Add meg az új jelszót.');
    isValid = false;
  } else if (newPasswordInput.value.length < 8) {
    setFieldValidity(newPasswordInput, newPasswordError, 'Legalább 8 karakter hosszú jelszót adj meg.');
    isValid = false;
  } else {
    setFieldValidity(newPasswordInput, newPasswordError);
  }

  if (!confirmPasswordInput.value) {
    setFieldValidity(confirmPasswordInput, confirmPasswordError, 'Ismételd meg az új jelszót.');
    isValid = false;
  } else if (newPasswordInput.value !== confirmPasswordInput.value) {
    setFieldValidity(confirmPasswordInput, confirmPasswordError, 'A két jelszó nem egyezik.');
    isValid = false;
  } else {
    setFieldValidity(confirmPasswordInput, confirmPasswordError);
  }

  if (!isValid) {
    statusEl.textContent = 'Ellenőrizd a kiemelt mezőket.';
    statusEl.classList.add('error');
    return;
  }

  const submitButton = form.querySelector('button[type="submit"]');
  submitButton?.setAttribute('disabled', 'true');
  submitButton?.setAttribute('aria-busy', 'true');

  try {
    const payload = {
      token: resetToken,
      password: newPasswordInput.value,
    };
    const response = await requestJSON('/api/password-reset/confirm', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    statusEl.textContent = response?.message || 'Az új jelszó mentése sikeres.';
    statusEl.classList.add('success');
    form.setAttribute('hidden', 'true');
  } catch (error) {
    statusEl.textContent = error.message || 'Nem sikerült menteni az új jelszót.';
    statusEl.classList.add('error');
    submitButton?.removeAttribute('disabled');
    submitButton?.removeAttribute('aria-busy');
    return;
  }

  submitButton?.removeAttribute('aria-busy');
  submitButton?.textContent = 'Jelszó frissítve';
});

initialize();
