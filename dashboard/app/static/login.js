const loginForm = document.querySelector("#login-form");
const loginStatus = document.querySelector("#login-status");
const emailInput = document.querySelector("#login-email");
const passwordInput = document.querySelector("#login-password");
const emailError = document.querySelector("#login-email-error");
const passwordError = document.querySelector("#login-password-error");
const passwordToggle = document.querySelector(".auth-input__toggle");

function setFieldValidity(inputEl, errorEl, message = "") {
  const wrapper = inputEl?.closest(".auth-input");
  if (!wrapper || !errorEl) {
    return;
  }

  if (message) {
    wrapper.dataset.invalid = "true";
    errorEl.textContent = message;
  } else {
    delete wrapper.dataset.invalid;
    errorEl.textContent = "";
  }
}

function validateFields() {
  let isValid = true;

  if (emailInput && emailError) {
    if (!emailInput.value) {
      setFieldValidity(emailInput, emailError, "Add meg az e-mail címedet.");
      isValid = false;
    } else if (!emailInput.checkValidity()) {
      setFieldValidity(emailInput, emailError, "Érvényes e-mail címet adj meg.");
      isValid = false;
    } else {
      setFieldValidity(emailInput, emailError);
    }
  }

  if (passwordInput && passwordError) {
    if (!passwordInput.value) {
      setFieldValidity(passwordInput, passwordError, "Add meg a jelszavadat.");
      isValid = false;
    } else {
      setFieldValidity(passwordInput, passwordError);
    }
  }

  return isValid;
}

passwordToggle?.addEventListener("click", () => {
  if (!passwordInput) {
    return;
  }

  const isHidden = passwordInput.type === "password";
  passwordInput.type = isHidden ? "text" : "password";
  passwordToggle.setAttribute("aria-pressed", String(isHidden));
  passwordToggle.textContent = isHidden ? "Elrejt" : "Mutat";
  passwordInput.focus();
});

emailInput?.addEventListener("input", () => {
  if (emailInput.value) {
    setFieldValidity(emailInput, emailError);
  }
});

passwordInput?.addEventListener("input", () => {
  if (passwordInput.value) {
    setFieldValidity(passwordInput, passwordError);
  }
});

async function requestJSON(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      detail = payload?.detail || "";
    } catch (_) {
      // figyelmen kívül hagyjuk a feldolgozhatatlan választ
    }
    throw new Error(detail || "Ismeretlen hiba");
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function translateLoginError(message) {
  if (!message) {
    return "Ismeretlen hiba történt. Próbáld újra.";
  }
  if (message.includes("Hibás bejelentkezési adatok")) {
    return "Hibás e-mail cím vagy jelszó.";
  }
  if (message.includes("erősítsd meg")) {
    return "Először erősítsd meg az e-mail címedet.";
  }
  if (message.includes("el lett utasítva")) {
    return "A regisztrációs kérelmed el lett utasítva.";
  }
  if (message.includes("jóváhagyásra vár")) {
    return "A fiókod még adminisztrátori jóváhagyásra vár.";
  }
  if (message.includes("tagsági díj")) {
    return "A szervezet tagsági díja nincs rendezve. Vedd fel a kapcsolatot a szervezet adminjával.";
  }
  if (message.includes("szervezeti hozzárendelés")) {
    return "A fiókod nincs szervezethez rendelve. Írj az adminisztrátornak.";
  }
  return "Nem sikerült bejelentkezni. Próbáld újra később.";
}

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginStatus.textContent = "";
  loginStatus.classList.remove("error", "success");

  if (!validateFields()) {
    loginStatus.textContent = "Ellenőrizd a kiemelt mezőket.";
    loginStatus.classList.add("error");
    return;
  }

  const formData = new FormData(loginForm);
  const payload = {
    email: formData.get("email"),
    password: formData.get("password"),
  };

  sessionStorage.clear();
  const submitButton = loginForm.querySelector('button[type="submit"]');
  submitButton?.setAttribute("disabled", "true");
  submitButton?.setAttribute("aria-busy", "true");

  try {
    const response = await requestJSON("/api/login", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    sessionStorage.setItem("authToken", response.token);
    sessionStorage.setItem("isAdmin", response.is_admin ? "1" : "0");
    sessionStorage.setItem(
      "isOrganizationContact",
      response.is_organization_contact ? "1" : "0",
    );
    if (payload.email) {
      sessionStorage.setItem("currentEmail", payload.email);
    }
    sessionStorage.setItem(
      "mustChangePassword",
      response.must_change_password ? "1" : "0",
    );

    if (response.must_change_password) {
      window.location.href = "/jelszo-frissites";
      return;
    }

    const fallbackRedirect = response.organization_id
      ? `/szervezetek/${response.organization_id}/${
          response.organization_fee_paid ? "tagok" : "dij"
        }`
      : "/";
    window.location.href = response.redirect || fallbackRedirect;
  } catch (error) {
    if (error.message.includes("e-mail") && emailInput) {
      setFieldValidity(emailInput, emailError, "Ellenőrizd az e-mail címet.");
    }
    if (error.message.toLowerCase().includes("jelsz")) {
      setFieldValidity(passwordInput, passwordError, "Ellenőrizd a jelszót.");
    }
    loginStatus.textContent = translateLoginError(error.message);
    loginStatus.classList.add("error");
  } finally {
    submitButton?.removeAttribute("disabled");
    submitButton?.removeAttribute("aria-busy");
  }
});
