const form = document.querySelector('#password-change-form');
const statusEl = document.querySelector('#password-change-status');

function setStatus(message, type = '') {
  if (!statusEl) {
    return;
  }
  statusEl.textContent = message || '';
  statusEl.classList.remove('error', 'success');
  if (type) {
    statusEl.classList.add(type);
  }
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
  setStatus('A jelszó frissítéséhez jelentkezz be újra.', 'error');
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

  if (!currentPassword || !newPassword) {
    setStatus('Minden mező kitöltése kötelező.', 'error');
    return;
  }
  if (newPassword !== confirmPassword) {
    setStatus('Az új jelszavak nem egyeznek.', 'error');
    return;
  }

  setStatus('Jelszó frissítése folyamatban...');

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

    if (!response.ok) {
      let message = '';
      try {
        const payload = await response.json();
        message = payload?.detail || '';
      } catch (_) {
        message = await response.text();
      }
      throw new Error(message || 'A jelszó frissítése nem sikerült.');
    }

    const payload = await response.json();
    sessionStorage.setItem('authToken', payload.token);
    sessionStorage.setItem('mustChangePassword', payload.must_change_password ? '1' : '0');

    setStatus(payload.message || 'A jelszavad frissült.', 'success');

    setTimeout(() => {
      const isAdmin = sessionStorage.getItem('isAdmin') === '1';
      window.location.href = isAdmin ? '/admin' : '/';
    }, 1200);
  } catch (error) {
    setStatus(error?.message || 'Nem sikerült frissíteni a jelszót.', 'error');
  }
});
