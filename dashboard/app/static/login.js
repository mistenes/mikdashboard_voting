const loginForm = document.querySelector("#login-form");
const loginStatus = document.querySelector("#login-status");

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

  const formData = new FormData(loginForm);
  const payload = {
    email: formData.get("email"),
    password: formData.get("password"),
  };

  sessionStorage.clear();

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
    loginStatus.textContent = translateLoginError(error.message);
    loginStatus.classList.add("error");
  }
});
