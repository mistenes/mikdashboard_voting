const form = document.querySelector('#password-change-form');
const summaryEl = document.querySelector('[data-summary]');
const summaryTitleEl = summaryEl?.querySelector('[data-summary-title]');
const summaryBodyEl = summaryEl?.querySelector('[data-summary-body]');
const submitButton = form?.querySelector('[data-submit]');
const defaultSubmitLabel = submitButton?.textContent?.trim() || 'Jelszó frissítése';

const SUMMARY_STATES = ['info', 'pending', 'success', 'error'];

function setSummary(state, title, detail) {
  if (!summaryEl) {
    return;
  }
  const nextState = SUMMARY_STATES.includes(state) ? state : 'info';
  SUMMARY_STATES.forEach((variant) => summaryEl.classList.remove(`auth-summary--${variant}`));
  summaryEl.classList.add(`auth-summary--${nextState}`);
  if (summaryTitleEl && title) {
    summaryTitleEl.textContent = title;
  }
  if (summaryBodyEl && typeof detail === 'string') {
    summaryBodyEl.textContent = detail;
  }
}

function toggleBusy(isBusy, label) {
  if (!submitButton) {
    return;
  }
  submitButton.disabled = Boolean(isBusy);
  submitButton.dataset.loading = isBusy ? 'true' : 'false';
  submitButton.textContent = isBusy ? label || 'Jelszó frissítése…' : defaultSubmitLabel;
}

function clearFieldErrors() {
  form?.querySelectorAll('[data-field]').forEach((field) => {
    field.removeAttribute('data-invalid');
    const errorEl = field.querySelector('[data-field-error]');
    if (errorEl) {
      errorEl.textContent = '';
    }
  });
}

function setFieldError(fieldName, message) {
  const field = form?.querySelector(`[data-field="${fieldName}"]`);
  if (!field) {
    return;
  }
  if (message) {
    field.setAttribute('data-invalid', 'true');
  } else {
    field.removeAttribute('data-invalid');
  }
  const errorEl = field.querySelector('[data-field-error]');
  if (errorEl) {
    errorEl.textContent = message || '';
  }
}

function disableFormInputs(disabled) {
  form?.querySelectorAll('input').forEach((input) => {
    input.disabled = Boolean(disabled);
  });
}

function requireSession() {
  const token = sessionStorage.getItem('authToken');
  if (!token) {
    window.location.href = '/';
    return null;
  }
  return token;
}

const currentToken = requireSession();
if (!currentToken) {
  setSummary('error', 'Lejárt munkamenet', 'A jelszó frissítéséhez jelentkezz be újra.');
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = requireSession();
  if (!token) {
    return;
  }

  const formData = new FormData(form);
  const currentPassword = formData.get('currentPassword');
  const newPassword = formData.get('newPassword');
  const confirmPassword = formData.get('confirmPassword');

  clearFieldErrors();

  if (!currentPassword || !newPassword) {
    if (!currentPassword) {
      setFieldError('currentPassword', 'Add meg a jelenlegi jelszavad.');
    }
    if (!newPassword) {
      setFieldError('newPassword', 'Add meg az új jelszavad.');
    }
    setSummary('error', 'Hiányzó adatok', 'Minden mező kitöltése kötelező.');
    return;
  }
  if (newPassword?.length < 8) {
    setFieldError('newPassword', 'Legalább 8 karakter hosszú jelszót adj meg.');
    setSummary('error', 'Túl rövid jelszó', 'Válassz legalább 8 karakteres jelszót.');
    return;
  }
  if (newPassword !== confirmPassword) {
    setFieldError('confirmPassword', 'Az új jelszavak nem egyeznek.');
    setSummary('error', 'Nem egyeznek a jelszavak', 'Győződj meg róla, hogy mindkét mezőben ugyanaz szerepel.');
    return;
  }

  setSummary('pending', 'Jelszó frissítése folyamatban…', 'Kérjük, várj néhány másodpercet.');
  toggleBusy(true);

  try {
    const response = await fetch('/api/change-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        current_password: currentPassword,
        new_password: newPassword,
      }),
    });

    let payload = null;
    if (!response.ok) {
      try {
        payload = await response.json();
      } catch (_) {
        payload = { detail: await response.text() };
      }
      throw new Error(payload?.detail || 'A jelszó frissítése nem sikerült.');
    }

    payload = payload || (await response.json());
    sessionStorage.setItem('authToken', payload.token);
    sessionStorage.setItem('mustChangePassword', payload.must_change_password ? '1' : '0');

    disableFormInputs(true);
    setSummary('success', payload.message || 'A jelszavad frissült.', 'Átirányítunk a vezérlőpultra.');
    toggleBusy(true, 'Átirányítás...');

    setTimeout(() => {
      const isAdmin = sessionStorage.getItem('isAdmin') === '1';
      window.location.href = isAdmin ? '/admin' : '/';
    }, 1200);
  } catch (error) {
    toggleBusy(false);
    setSummary('error', 'Nem sikerült frissíteni a jelszót.', error?.message || 'Ismételd meg később.');
  }
});
