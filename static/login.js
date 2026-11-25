/* ============================================================
   EKOLSTAT — Page de connexion (CORRIGÉ)
   ============================================================ */
(function () {
  const form      = document.getElementById("login-form");
  const emailIn   = document.getElementById("email");
  const passIn    = document.getElementById("password") || document.getElementById("pwdInput");
  const remember  = document.getElementById("remember");
  const btn       = document.getElementById("login-btn");
  const btnLabel  = btn ? btn.querySelector(".btn-label") : null;
  const btnLoad   = btn ? btn.querySelector(".btn-loader") : null;
  const message   = document.getElementById("auth-message") || createAuthMessage();
  const toggle    = document.getElementById("toggle-pass") || document.querySelector(".eye-btn");
  const forgot    = document.getElementById("forgot-link") || document.querySelector(".link-muted:not([onclick])");

  const auth = window.EKOLSTAT?.auth;
  const db   = window.EKOLSTAT?.db;
  const originalBtnText = btn ? btn.textContent.trim() : "Se connecter";

  function createAuthMessage() {
    const msg = document.createElement("div");
    msg.id = "auth-message";
    msg.className = "auth-message hidden";
    msg.style.marginTop = "14px";
    if (btn && btn.parentNode) {
      btn.parentNode.insertBefore(msg, btn.nextSibling);
    }
    return msg;
  }


  // Variable pour éviter les redirections multiples
  let redirecting = false;

  if (!auth || !db) {
    showMessage("Service d'authentification indisponible. Vérifiez votre connexion internet puis rechargez la page.", "error");
    return;
  }

  // Rediriger automatiquement si déjà connecté
  auth.onAuthStateChanged(async function (user) {
    if (!user || redirecting) return;
    
    try {
      redirecting = true;
      console.log("[Login] Utilisateur déjà connecté, vérification du profil...");
      const snap = await db.ref("utilisateurs/" + user.uid).get();
      const data = snap.exists() ? snap.val() : null;
      
      if (data && data.role && window.EKOLSTAT.routeByRole(data.role) !== "login.html") {
        const targetUrl = window.EKOLSTAT.routeByRole(data.role);
        console.log("[Login] Redirection vers:", targetUrl);
        window.location.href = targetUrl;
      } else {
        console.warn("[Login] Aucun rôle trouvé, déconnexion");
        await auth.signOut();
        redirecting = false;
      }
    } catch (e) {
      console.error("[Login] Erreur lors de la vérification:", e);
      redirecting = false;
    }
  });

  // Afficher / masquer le mot de passe
  if (toggle && passIn) {
    toggle.addEventListener("click", function () {
      const isPwd = passIn.type === "password";
      passIn.type = isPwd ? "text" : "password";
      const icon = toggle.querySelector("i");
      if (icon) {
        icon.className = isPwd ? "fas fa-eye-slash" : "fas fa-eye";
      }
    });
  }

  async function handleLoginSubmit(e) {
    if (e && typeof e.preventDefault === "function") {
      e.preventDefault();
    }

    if (redirecting) {
      console.log("[Login] Redirection déjà en cours, ignore");
      return;
    }

    const email = emailIn ? emailIn.value.trim() : "";
    const pass  = passIn ? passIn.value : "";
    if (!email || !pass) {
      showMessage("Veuillez renseigner votre email et votre mot de passe.", "info");
      return;
    }

    setLoading(true);
    showMessage("", "");

    try {
      // Persistance selon "Se souvenir"
      const persistence = remember && remember.checked
        ? firebase.auth.Auth.Persistence.LOCAL
        : firebase.auth.Auth.Persistence.SESSION;
      await auth.setPersistence(persistence);

      console.log("[Login] Tentative de connexion pour:", email);
      const cred = await auth.signInWithEmailAndPassword(email, pass);
      const uid  = cred.user.uid;

      // Récupérer le rôle dans la base avec un timeout
      console.log("[Login] Récupération du profil pour UID:", uid);
      
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Timeout chargement profil")), 10000)
      );
      
      const snap = await Promise.race([
        db.ref("utilisateurs/" + uid).get(),
        timeoutPromise
      ]);
      
      if (!snap.exists()) {
        console.error("[Login] Profil introuvable pour UID:", uid);
        await auth.signOut();
        showMessage("Aucun profil EKOLSTAT lié à ce compte. Contactez votre administrateur.", "error");
        setLoading(false);
        redirecting = false;
        return;
      }
      
      const profile = snap.val();
      console.log("[Login] Profil trouvé, rôle:", profile.role);

      if (window.EKOLSTAT.routeByRole(profile.role) === "login.html") {
        await auth.signOut();
        showMessage("Ce type de compte n'est plus utilisé. Les écoles n'ont plus d'accès : contactez votre inspecteur itinérant ou votre Pool.", "error");
        setLoading(false);
        redirecting = false;
        return;
      }
      
      showMessage("Connexion réussie. Redirection...", "success");
      redirecting = true;

      // Redirection après un court délai pour afficher le message
      setTimeout(function () {
        const targetUrl = window.EKOLSTAT.routeByRole(profile.role);
        console.log("[Login] Redirection vers:", targetUrl);
        window.location.href = targetUrl;
      }, 800);
    } catch (err) {
      console.error("[Login] Erreur de connexion:", err);
      showMessage(window.EKOLSTAT.translateAuthError(err), "error");
      setLoading(false);
      redirecting = false;
    }
  }

  const isNativeForm = form instanceof HTMLFormElement;
  if (isNativeForm) {
    form.addEventListener("submit", handleLoginSubmit);
  } else if (btn) {
    btn.addEventListener("click", handleLoginSubmit);
    [emailIn, passIn].forEach(input => {
      if (!input) return;
      input.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
          handleLoginSubmit(event);
        }
      });
    });
  }

  // Mot de passe oublié
  if (forgot) {
    forgot.addEventListener("click", async function (e) {
      e.preventDefault();
      const email = emailIn ? emailIn.value.trim() : "";
      if (!email) {
        showMessage("Saisissez votre adresse e-mail puis cliquez à nouveau sur 'Mot de passe oublié'.", "info");
        if (emailIn) emailIn.focus();
        return;
      }
      try {
        await auth.sendPasswordResetEmail(email);
        showMessage("Un e-mail de réinitialisation vient d'être envoyé à " + email + ".", "success");
      } catch (err) {
        showMessage(window.EKOLSTAT.translateAuthError(err), "error");
      }
    });
  }

  function setLoading(on) {
    if (!btn) return;
    btn.disabled = on;

    if (btnLabel && btnLoad) {
      btnLabel.classList.toggle("hidden", on);
      btnLoad.classList.toggle("hidden", !on);
      return;
    }

    // Fallback: inject a simple spinner into the button when no loader markup exists
    if (on) {
      if (!btn.dataset.origHtml) btn.dataset.origHtml = btn.innerHTML;

      let spinner = btn.querySelector('.btn-loader');
      if (!spinner) {
        spinner = document.createElement('span');
        spinner.className = 'btn-loader';
        spinner.style.marginLeft = '8px';
        spinner.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        btn.appendChild(spinner);
      }

      // ensure button displays label text (use originalBtnText as fallback)
      if (!btn.querySelector('.btn-label')) {
        btn.textContent = originalBtnText;
        btn.appendChild(spinner);
      }
    } else {
      // restore original content if we saved it
      if (btn.dataset.origHtml) {
        btn.innerHTML = btn.dataset.origHtml;
        delete btn.dataset.origHtml;
      } else {
        const spinner = btn.querySelector('.btn-loader');
        if (spinner) spinner.remove();
      }
    }
  }

  function showMessage(text, type) {
    if (!text) {
      message.classList.add("hidden");
      message.textContent = "";
      message.className = "auth-message hidden";
      return;
    }
    message.className = "auth-message " + (type || "info");
    const icon = type === "error"   ? "fa-circle-exclamation"
              : type === "success" ? "fa-circle-check"
              : "fa-circle-info";
    message.textContent = "";
    var ic = document.createElement("i");
    ic.className = "fas " + icon;
    var sp = document.createElement("span");
    sp.textContent = text;
    message.appendChild(ic);
    message.appendChild(sp);
    message.classList.remove("hidden");
  }
})();
