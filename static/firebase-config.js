/* ============================================================
   EKOLSTAT — Configuration Firebase
   ============================================================
   IMPORTANT : remplacez les valeurs par celles de votre projet
   Firebase. Les clés ci-dessous sont des valeurs par défaut
   destinées à être surchargées via la console Firebase.
   ============================================================ */

   window.EKOLSTAT_FIREBASE_CONFIG = {
    apiKey: "AIzaSyAqcoW8gmua4ttyaesCd6E15enapVXlvWc",
    databaseURL: "https://ekolstat-default-rtdb.europe-west1.firebasedatabase.app/",
    authDomain: "ekolstat.firebaseapp.com",
    projectId: "ekolstat",
    storageBucket: "ekolstat.firebasestorage.app",
    messagingSenderId: "660352315364",
    appId: "1:660352315364:web:c9110af7df01e8db13a1f1"
};

(function initFirebase() {
  if (!window.firebase) {
    console.error("[EKOLSTAT] Firebase SDK introuvable.");
    return;
  }
  if (!firebase.apps || !firebase.apps.length) {
    firebase.initializeApp(window.EKOLSTAT_FIREBASE_CONFIG);
  }
  window.EKOLSTAT = window.EKOLSTAT || {};
  window.EKOLSTAT.auth = firebase.auth();
  window.EKOLSTAT.db   = firebase.database();
})();

/* Helpers communs --------------------------------------------------------- */
window.EKOLSTAT = window.EKOLSTAT || {};

window.EKOLSTAT.formatNumber = function (n) {
  if (n === null || n === undefined || isNaN(n)) return "0";
  return Number(n).toLocaleString("fr-FR");
};

window.EKOLSTAT.percent = function (num, den, digits) {
  if (!den || den === 0) return "0%";
  const v = (num / den) * 100;
  return v.toFixed(digits === undefined ? 1 : digits).replace(".", ",") + "%";
};

window.EKOLSTAT.toast = function (message, type) {
  const t = document.getElementById("toast");
  const m = document.getElementById("toast-msg");
  if (!t || !m) return;
  m.textContent = message;
  t.className = "toast " + (type || "info");
  setTimeout(() => { t.classList.add("hidden"); }, 4200);
};

window.EKOLSTAT.translateAuthError = function (err) {
  const code = err && err.code ? err.code : "";
  switch (code) {
    case "auth/invalid-email":         return "Adresse e-mail invalide.";
    case "auth/user-disabled":         return "Ce compte a été désactivé.";
    case "auth/user-not-found":        return "Aucun compte avec cet e-mail.";
    case "auth/wrong-password":        return "Mot de passe incorrect.";
    case "auth/invalid-credential":    return "Identifiants invalides.";
    case "auth/too-many-requests":     return "Trop de tentatives. Réessayez plus tard.";
    case "auth/network-request-failed":return "Connexion réseau impossible.";
    case "auth/email-already-in-use":  return "Cette adresse e-mail est déjà utilisée.";
    case "auth/weak-password":         return "Le mot de passe doit contenir au moins 6 caractères.";
    default: return (err && err.message) ? err.message : "Une erreur est survenue.";
  }
};

/* ── Routage par rôle ─────────────────────────────────────────────────────
   Hiérarchie : IGE → IPP → POOL → INSPECTEUR ITINÉRANT.
   Les écoles n'ont plus de compte : elles sont créées par l'inspecteur.
   login.html / index.html sont à la racine → chemin relatif = "templates/xxx.html"
   ────────────────────────────────────────────────────────────────────── */
window.EKOLSTAT.routeByRole = function (role) {
  switch ((role || "").toLowerCase()) {
    case "ige":          return "templates/ige.html";
    case "ipp":          return "templates/ipp.html";
    case "pool":
    case "sousdivision":
    case "sous-division":return "templates/pool.html";
    case "inspecteur":
    case "inspecteur-itinerant":
    case "inspecteur_itinerant": return "templates/inspecteur.html";
    default:             return "login.html";
  }
};

/* ── PDF : largeurs de colonnes ───────────────────────────────────────────
   Renvoie un <colgroup> dont les largeurs (en %) dépendent du titre de
   chaque colonne, pour que les tableaux tiennent toujours dans la page
   (avec table-layout:fixed les colonnes ne peuvent plus déborder).
   ────────────────────────────────────────────────────────────────────── */
window.EKOLSTAT.pdfColgroup = function (headers) {
  var W = { "classe": 18, "niveau": 12, "option": 24, "code": 8,
            "filles": 16, "garçons": 16, "garcons": 16, "total": 10,
            "sous-division": 24, "pool": 24, "inspecteur": 24, "écoles": 9, "ecoles": 9, "classes": 9 };
  var ws = headers.map(function (h) {
    var k = String(h).replace(/<[^>]*>/g, "").trim().toLowerCase();
    return W[k] || 15;
  });
  var sum = ws.reduce(function (a, b) { return a + b; }, 0);
  return "<colgroup>" + ws.map(function (w) {
    return '<col style="width:' + (w * 100 / sum).toFixed(2) + '%">';
  }).join("") + "</colgroup>";
};
window.EKOLSTAT.PDF_TABLE_FIXED = "table-layout:fixed;word-break:break-word;overflow-wrap:anywhere;";

/* ============================================================
   PERFORMANCE — helpers partagés par tous les dashboards
   ============================================================ */

/* Chart.js : police Satoshi dans les graphiques (le canvas
   n'hérite pas de la police CSS). */
(function () {
  if (window.Chart && Chart.defaults) {
    Chart.defaults.font.family = '"Satoshi", "Urbanist", sans-serif';
    Chart.defaults.color = "#475569";
    Chart.defaults.borderColor = "#e2e8f0";
  }
})();

/* ── Bibliothèques lourdes chargées uniquement quand on en a besoin ──
   html2pdf (~900 Ko) et SheetJS (~900 Ko) ne bloquent plus l'affichage. */
(function () {
  var LIBS = {
    html2pdf: "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js",
    xlsx: "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"
  };
  var cache = {};
  window.EKOLSTAT.loadLib = function (name) {
    if (cache[name]) return cache[name];
    cache[name] = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = LIBS[name];
      s.async = true;
      s.onload = resolve;
      s.onerror = function () { delete cache[name]; reject(new Error("Chargement impossible : " + name)); };
      document.head.appendChild(s);
    });
    return cache[name];
  };
  window.EKOLSTAT.withLib = function (name, callback) {
    window.EKOLSTAT.toast("Chargement du module en cours…", "info");
    window.EKOLSTAT.loadLib(name).then(callback).catch(function () {
      window.EKOLSTAT.toast("Module indisponible. Vérifiez votre connexion internet.", "error");
    });
  };
})();

/* ── Données de référence (provinces, cycles, options) ──
   Quasi statiques : mises en cache 6 h dans le navigateur, donc plus
   d'aller-retour réseau à chaque ouverture. */
window.EKOLSTAT.getRef = function (db, name) {
  var TTL = 6 * 3600 * 1000;
  var key = "ekolstat_ref_v1_" + name;
  try {
    var raw = localStorage.getItem(key);
    if (raw) {
      var o = JSON.parse(raw);
      if (o && o.t && Date.now() - o.t < TTL && o.v !== undefined) return Promise.resolve(o.v);
    }
  } catch (e) { /* stockage indisponible : on passe par le réseau */ }
  return db.ref(name).once("value").then(function (snap) {
    var v = snap.val();
    try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: v })); } catch (e) {}
    return v;
  });
};

/* ── Rendu groupé ──
   Avant : chaque snapshot Firebase relançait un rendu complet (5 à 6 rendus
   au chargement). Maintenant : on attend que les données initiales soient
   là, puis on regroupe les rafales de mises à jour en un seul rendu. */
window.EKOLSTAT.createRenderScheduler = function (renderFn, needed, opts) {
  var ready = {}, isReady = false, timer = 0, fallback;
  function flush() {
    timer = 0;
    if (!isReady) return;
    try { renderFn(); } catch (e) { console.error("[EKOLSTAT] Erreur de rendu :", e); }
  }
  function schedule() { if (!timer) timer = setTimeout(flush, 40); }
  function setReady() {
    if (isReady) return;
    isReady = true;
    clearTimeout(fallback);
    if (timer) { clearTimeout(timer); timer = 0; }
    document.body.classList.remove("is-loading");
    flush();
  }
  // Filet de sécurité : on affiche quand même après 10 s
  fallback = setTimeout(setReady, (opts && opts.timeout) || 10000);
  return {
    mark: function (key) {
      ready[key] = true;
      if (isReady) { schedule(); return; }
      if (needed.every(function (k) { return ready[k]; })) setReady();
    },
    render: schedule,
    isReady: function () { return isReady; }
  };
};

/* ── Effectifs limités au périmètre ──
   Avant : db.ref("effectifs").on("value") téléchargeait les effectifs de
   TOUT le pays pour une simple école. Maintenant on n'écoute que les classes
   du périmètre. Au-delà de MAX_SCOPED classes, un flux unique est plus
   économique que des milliers d'écouteurs : on retombe sur l'ancien mode. */
window.EKOLSTAT.watchEffectifs = function (db, onChange, onFirstLoad) {
  var MAX_SCOPED = 600;
  var store = {}, subs = {}, fullRef = null, fullFn = null;
  var mode = null, pending = 0, signaled = false;

  function signal() { if (!signaled) { signaled = true; if (onFirstLoad) onFirstLoad(); } }
  function stopAll() {
    Object.keys(subs).forEach(function (id) { subs[id].ref.off("value", subs[id].fn); });
    subs = {};
    if (fullRef) { fullRef.off("value", fullFn); fullRef = null; fullFn = null; }
    store = {};
  }

  function sync(ids) {
    if (ids.length > MAX_SCOPED) {
      if (mode === "full") return;
      stopAll();
      mode = "full";
      fullRef = db.ref("effectifs");
      fullFn = function (snap) { store = snap.val() || {}; onChange(store); signal(); };
      fullRef.on("value", fullFn);
      return;
    }
    if (mode === "full") { stopAll(); }
    mode = "scoped";

    var want = {}, changed = false;
    ids.forEach(function (id) { want[id] = 1; });

    Object.keys(subs).forEach(function (id) {
      if (want[id]) return;
      var rec = subs[id];
      rec.ref.off("value", rec.fn);
      if (rec.first && !signaled) pending--;
      delete subs[id];
      delete store[id];
      changed = true;
    });

    var added = ids.filter(function (id) { return !subs[id]; });
    if (!signaled) pending += added.length;
    added.forEach(function (id) {
      var rec = { ref: db.ref("effectifs/" + id), first: true };
      rec.fn = function (snap) {
        var v = snap.val();
        if (v) store[id] = v; else delete store[id];
        onChange(store);   // avant signal() : le 1er rendu absorbe ce changement (pas de rendu en double)
        if (rec.first) { rec.first = false; if (!signaled && --pending <= 0) signal(); }
      };
      subs[id] = rec;
      rec.ref.on("value", rec.fn);
    });

    if (!added.length && pending <= 0) signal();
    if (changed) onChange(store);
  }

  return { sync: sync, stop: stopAll };
};
