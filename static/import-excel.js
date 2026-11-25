/* ============================================================
   EKOLSTAT — Import en masse via Excel
   ------------------------------------------------------------
   Utilisé par :
     • IPP              → création de Pools
     • Pool             → création d'Inspecteurs itinérants
       (les écoles n'ont plus de compte : elles sont créées par les inspecteurs)

   Pour chaque ligne du fichier :
     1. un compte Firebase Auth est créé
           email        = <nom de l'entité sans accents/espaces>@gmail.com
           mot de passe = 111111
     2. la fiche est enregistrée dans /<node>/<uid>
     3. le profil de connexion est enregistré dans /utilisateurs/<uid>

   Dépendance : SheetJS (window.XLSX) + firebase-config.js
   ============================================================ */
(function () {
  window.EKOLSTAT = window.EKOLSTAT || {};

  var DEFAULT_PASSWORD = "111111";
  var EMAIL_DOMAIN = "gmail.com";
  var PAUSE_BETWEEN_MS = 150;

  /* ---------- Utilitaires texte ---------- */
  function norm(s) {
    return String(s == null ? "" : s)
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/\s+/g, " ").trim();
  }
  function slug(s) { return norm(s).replace(/[^a-z0-9]/g, ""); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function emailFor(nom) { return slug(nom) + "@" + EMAIL_DOMAIN; }
  function emailWithCode(nom, code) { return slug(nom) + slug(code) + "@" + EMAIL_DOMAIN; }

  /* ---------- Normalisations de valeurs ---------- */
  function normCategorie(v) {
    var n = norm(v);
    if (!n) return null;
    if (n.indexOf("publi") === 0) return "publique";
    if (n.indexOf("priv") === 0) return "privee";
    return null;
  }
  function normCycle(v) {
    var n = norm(v);
    if (!n) return "";
    if (n.indexOf("matern") === 0) return "maternelle";
    if (n.indexOf("prim") === 0) return "primaire";
    if (n.indexOf("second") === 0) return "secondaire";
    return null;
  }

  /* ---------- Lecture du tableau (array of arrays) ----------
     Détecte la ligne d'en-têtes grâce aux alias de colonnes ;
     à défaut, lit les colonnes dans l'ordre (nom, code, 3e colonne). */
  function parseRows(aoa, columns) {
    var core = columns.filter(function (c) { return !c.extra; });
    var mapping = {};            // key -> index de colonne
    var startRow = 0;

    var first = (aoa[0] || []).map(norm);
    columns.forEach(function (c) {
      var idx = first.findIndex(function (cell) {
        return cell && c.aliases.indexOf(cell) !== -1;
      });
      if (idx !== -1) mapping[c.key] = idx;
    });

    if (mapping.nom !== undefined) {
      startRow = 1;
    } else {
      mapping = {};
      core.forEach(function (c, i) { mapping[c.key] = i; });
    }

    var rows = [];
    for (var r = startRow; r < aoa.length; r++) {
      var raw = aoa[r] || [];
      var empty = raw.every(function (v) { return String(v == null ? "" : v).trim() === ""; });
      if (empty) continue;
      var values = {};
      columns.forEach(function (c) {
        var idx = mapping[c.key];
        values[c.key] = idx === undefined ? "" : String(raw[idx] == null ? "" : raw[idx]).trim();
      });
      rows.push({ line: r + 1, values: values });
    }
    return rows;
  }

  /* ---------- Validation (aperçu) ---------- */
  function validateRows(rows, cfg) {
    var existing = (cfg.getExisting ? cfg.getExisting() : []).map(function (e) {
      return { nom: slug(e.nom), code: slug(e.code) };
    });
    var seen = {};

    return rows.map(function (row) {
      var v = row.values;
      var res = { line: row.line, values: {}, status: "ok", message: "", email: "" };

      // Normalisation / contrôle de chaque colonne
      for (var i = 0; i < cfg.columns.length; i++) {
        var c = cfg.columns[i];
        var val = v[c.key];
        if (c.required && !val) { res.status = "error"; res.message = c.header + " manquant(e)"; break; }
        if (c.normalize && (val || c.required)) {
          var out = c.normalize(val);
          if (out === null) { res.status = "error"; res.message = c.invalidMsg || (c.header + " invalide"); break; }
          val = out;
        }
        res.values[c.key] = val;
      }
      if (res.status === "error") { res.values.nom = res.values.nom || v.nom; return res; }

      var nomSlug = slug(res.values.nom);
      if (!nomSlug) { res.status = "error"; res.message = "Nom inexploitable pour générer l'email"; return res; }
      res.email = emailFor(res.values.nom);

      var codeSlug = slug(res.values.code);
      var dupExisting = existing.some(function (e) {
        return e.nom === nomSlug && (!codeSlug || !e.code || e.code === codeSlug);
      });
      if (dupExisting) { res.status = "skip"; res.message = "Existe déjà"; return res; }

      var key = nomSlug + "|" + codeSlug;
      if (seen[key]) { res.status = "skip"; res.message = "Doublon dans le fichier"; return res; }
      seen[key] = true;
      return res;
    });
  }

  /* ---------- Création d'un compte avec reprise sur limite de débit ---------- */
  async function withRetry(fn) {
    var attempt = 0;
    for (;;) {
      try { return await fn(); }
      catch (e) {
        var retryable = e && (e.code === "auth/too-many-requests" || e.code === "auth/network-request-failed");
        if (!retryable || attempt >= 3) throw e;
        attempt++;
        await sleep(6000 * attempt);
      }
    }
  }

  async function createOne(item, cfg) {
    var auth = cfg.getSecondaryAuth();
    var db = cfg.db;
    var values = item.values;

    var email = item.email;
    var cred;
    try {
      cred = await withRetry(function () { return auth.createUserWithEmailAndPassword(email, DEFAULT_PASSWORD); });
    } catch (e) {
      // Email déjà pris (homonyme dans une autre entité) → on ajoute le code
      if (e && e.code === "auth/email-already-in-use" && slug(values.code)) {
        email = emailWithCode(values.nom, values.code);
        cred = await withRetry(function () { return auth.createUserWithEmailAndPassword(email, DEFAULT_PASSWORD); });
      } else {
        throw e;
      }
    }

    var uid = cred.user.uid;
    var TS = firebase.database.ServerValue.TIMESTAMP;
    try {
      var entity = Object.assign({}, cfg.entityData(values), { email: email, statut: "actif", createdAt: TS });
      await db.ref(cfg.node + "/" + uid).set(entity);
      var profile = Object.assign({}, cfg.userData(values, uid), { email: email, createdAt: TS });
      await db.ref("utilisateurs/" + uid).set(profile);
    } catch (e) {
      // Retour arrière : on évite les comptes orphelins
      try { await db.ref(cfg.node + "/" + uid).remove(); } catch (_) {}
      try { await cred.user.delete(); } catch (_) {}
      throw e;
    } finally {
      try { await auth.signOut(); } catch (_) {}
    }
    return email;
  }

  /* ---------- Modèle Excel ---------- */
  function downloadTemplate(cfg) {
    var core = cfg.columns.filter(function (c) { return !c.extra; });
    var aoa = [core.map(function (c) { return c.header; })].concat(cfg.templateExamples);
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = core.map(function () { return { wch: 32 }; });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Liste");
    XLSX.writeFile(wb, cfg.templateFile);
  }

  /* ---------- Interface ---------- */
  var cssInjected = false;
  function injectCss() {
    if (cssInjected) return;
    cssInjected = true;
    var st = document.createElement("style");
    st.textContent =
      ".imp-card{width:min(920px,96vw);max-width:96vw}" +
      ".imp-drop{border:2px dashed #cbd5e1;border-radius:12px;padding:28px 16px;text-align:center;cursor:pointer;transition:.15s}" +
      ".imp-drop:hover,.imp-drop.over{border-color:var(--c-primary-600,#1762cb);background:rgba(23,98,203,.05)}" +
      ".imp-drop i{font-size:28px;color:var(--c-primary-600,#1762cb);margin-bottom:8px;display:block}" +
      ".imp-info{font-size:13px;line-height:1.5;background:rgba(23,98,203,.07);border-radius:10px;padding:10px 12px;margin-bottom:12px}" +
      ".imp-warn{font-size:13px;line-height:1.5;background:rgba(234,179,8,.14);border-radius:10px;padding:10px 12px;margin-top:12px}" +
      ".imp-sum{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 10px}" +
      ".imp-pill{padding:4px 10px;border-radius:999px;font-size:12.5px;font-weight:600}" +
      ".imp-pill.ok{background:#dcfce7;color:#166534}.imp-pill.skip{background:#fef9c3;color:#854d0e}.imp-pill.error{background:#fee2e2;color:#991b1b}" +
      ".imp-scroll{max-height:42vh;overflow:auto;border:1px solid #e2e8f0;border-radius:10px}" +
      ".imp-table{width:100%;border-collapse:collapse;font-size:13px}" +
      ".imp-table th,.imp-table td{padding:7px 10px;text-align:left;border-bottom:1px solid #eef2f7;white-space:nowrap}" +
      ".imp-table th{position:sticky;top:0;background:#f8fafc;z-index:1}" +
      ".imp-st-ok{color:#166534}.imp-st-skip{color:#854d0e}.imp-st-error{color:#991b1b}" +
      ".imp-bar{height:10px;border-radius:999px;background:#e2e8f0;overflow:hidden;margin:10px 0}" +
      ".imp-bar>div{height:100%;width:0;background:var(--c-primary-600,#1762cb);transition:width .2s}";
    document.head.appendChild(st);
  }

  function openImportModal(cfg) {
    if (!window.XLSX) { EKOLSTAT.withLib("xlsx", function () { openImportModal(cfg); }); return; }
    injectCss();

    var core = cfg.columns.filter(function (c) { return !c.extra; });
    var extras = cfg.columns.filter(function (c) { return c.extra; });
    var colList = core.map(function (c) { return "<b>" + esc(c.header) + "</b>"; }).join(", ");

    var overlay = document.createElement("div");
    overlay.className = "modal show";
    overlay.innerHTML =
      '<div class="modal-card imp-card">' +
        '<div class="modal-head">' +
          '<h3><i class="fas fa-file-excel"></i> Importer des ' + esc(cfg.entityLabelPlural) + ' (Excel)</h3>' +
          '<button class="icon-btn" data-imp-close><i class="fas fa-xmark"></i></button>' +
        '</div>' +
        '<div class="modal-body" id="imp-body"></div>' +
        '<div class="modal-foot" id="imp-foot"></div>' +
      '</div>';
    document.body.appendChild(overlay);

    var body = overlay.querySelector("#imp-body");
    var foot = overlay.querySelector("#imp-foot");
    var busy = false;
    var items = [];

    function close() { if (busy) return; overlay.remove(); }
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay || e.target.closest("[data-imp-close]")) close();
    });

    /* ----- Étape 1 : choix du fichier ----- */
    function stepChoose(errorMsg) {
      body.innerHTML =
        '<div class="imp-info">' +
          'Le fichier doit contenir les colonnes : ' + colList + '.' +
          (extras.length ? ' Colonnes facultatives reconnues : ' + extras.map(function (c) { return "<b>" + esc(c.header) + "</b>"; }).join(", ") + '.' : '') +
          '<br>Un compte est créé automatiquement pour chaque ligne : email = <b>nom@' + EMAIL_DOMAIN +
          '</b> (sans espaces ni accents), mot de passe = <b>' + DEFAULT_PASSWORD + '</b>.' +
        '</div>' +
        (errorMsg ? '<div class="imp-warn" style="margin:0 0 12px;background:rgba(220,38,38,.1)">' + esc(errorMsg) + '</div>' : '') +
        '<div class="imp-drop" id="imp-drop"><i class="fas fa-cloud-arrow-up"></i>' +
          '<div><b>Cliquez ou déposez votre fichier ici</b></div><div style="font-size:12.5px;opacity:.7">.xlsx, .xls ou .csv</div>' +
          '<input type="file" id="imp-file" accept=".xlsx,.xls,.csv" style="display:none" />' +
        '</div>';
      foot.innerHTML =
        '<button type="button" class="btn btn-ghost" id="imp-tpl"><i class="fas fa-download"></i> Télécharger le modèle</button>' +
        '<button type="button" class="btn btn-ghost" data-imp-close>Fermer</button>';

      var drop = body.querySelector("#imp-drop");
      var input = body.querySelector("#imp-file");
      drop.addEventListener("click", function () { input.click(); });
      drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("over"); });
      drop.addEventListener("dragleave", function () { drop.classList.remove("over"); });
      drop.addEventListener("drop", function (e) {
        e.preventDefault(); drop.classList.remove("over");
        if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
      });
      input.addEventListener("change", function () { if (input.files[0]) readFile(input.files[0]); });
      foot.querySelector("#imp-tpl").addEventListener("click", function () { downloadTemplate(cfg); });
    }

    function readFile(file) {
      var reader = new FileReader();
      reader.onerror = function () { stepChoose("Impossible de lire le fichier."); };
      reader.onload = function (e) {
        try {
          var wb = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
          var ws = wb.Sheets[wb.SheetNames[0]];
          var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", blankrows: false, raw: false });
          var rows = parseRows(aoa, cfg.columns);
          if (!rows.length) { stepChoose("Le fichier ne contient aucune ligne exploitable."); return; }
          items = validateRows(rows, cfg);
          stepPreview(file.name);
        } catch (err) {
          console.error(err);
          stepChoose("Fichier illisible : " + (err.message || err));
        }
      };
      reader.readAsArrayBuffer(file);
    }

    /* ----- Étape 2 : aperçu ----- */
    function count(st) { return items.filter(function (i) { return i.status === st; }).length; }

    function stepPreview(fileName) {
      var nOk = count("ok"), nSkip = count("skip"), nErr = count("error");
      var thead = "<tr><th>Ligne</th>" + core.map(function (c) { return "<th>" + esc(c.header) + "</th>"; }).join("") +
        "<th>Email généré</th><th>Statut</th></tr>";
      var trs = items.map(function (it) {
        var label = it.status === "ok" ? "Prêt" : esc(it.message);
        return "<tr><td>" + it.line + "</td>" +
          core.map(function (c) { return "<td>" + esc(it.values[c.key] != null ? it.values[c.key] : "") + "</td>"; }).join("") +
          "<td>" + esc(it.email) + "</td>" +
          '<td class="imp-st-' + it.status + '">' + label + "</td></tr>";
      }).join("");

      body.innerHTML =
        '<div style="font-size:13px;margin-bottom:8px"><i class="fas fa-file-excel"></i> ' + esc(fileName) + '</div>' +
        '<div class="imp-sum">' +
          '<span class="imp-pill ok">' + nOk + ' à créer</span>' +
          (nSkip ? '<span class="imp-pill skip">' + nSkip + ' ignorée(s)</span>' : '') +
          (nErr ? '<span class="imp-pill error">' + nErr + ' erreur(s)</span>' : '') +
        '</div>' +
        '<div class="imp-scroll"><table class="imp-table"><thead>' + thead + '</thead><tbody>' + trs + '</tbody></table></div>' +
        '<div class="imp-warn"><i class="fas fa-triangle-exclamation"></i> Tous les comptes créés auront le mot de passe <b>' + DEFAULT_PASSWORD +
          '</b>. Si un email est déjà utilisé, le code de l\'entité est ajouté à l\'email (ex. nom' + 'code@' + EMAIL_DOMAIN + ').</div>';

      foot.innerHTML =
        '<button type="button" class="btn btn-ghost" id="imp-back">Changer de fichier</button>' +
        '<button type="button" class="btn btn-primary" id="imp-go"' + (nOk ? "" : " disabled") + '><i class="fas fa-user-plus"></i> Créer ' + nOk + ' compte(s)</button>';
      foot.querySelector("#imp-back").addEventListener("click", function () { stepChoose(); });
      foot.querySelector("#imp-go").addEventListener("click", run);
    }

    /* ----- Étape 3 : exécution ----- */
    async function run() {
      busy = true;
      var todo = items.filter(function (i) { return i.status === "ok"; });
      body.innerHTML =
        '<div id="imp-progress-txt" style="font-size:14px">Création en cours… 0 / ' + todo.length + '</div>' +
        '<div class="imp-bar"><div id="imp-bar-fill"></div></div>' +
        '<div style="font-size:12.5px;opacity:.7">Ne fermez pas cette fenêtre pendant l\'import.</div>';
      foot.innerHTML = '<button type="button" class="btn btn-ghost" disabled>Import en cours…</button>';

      var txt = body.querySelector("#imp-progress-txt");
      var fill = body.querySelector("#imp-bar-fill");

      for (var i = 0; i < todo.length; i++) {
        var it = todo[i];
        try {
          it.finalEmail = await createOne(it, cfg);
          it.result = "created";
        } catch (e) {
          it.result = "failed";
          it.error = (window.EKOLSTAT.translateAuthError ? window.EKOLSTAT.translateAuthError(e) : (e.message || String(e)));
        }
        txt.textContent = "Création en cours… " + (i + 1) + " / " + todo.length;
        fill.style.width = Math.round(((i + 1) / todo.length) * 100) + "%";
        await sleep(PAUSE_BETWEEN_MS);
      }
      busy = false;
      stepDone();
    }

    /* ----- Étape 4 : bilan ----- */
    function stepDone() {
      var created = items.filter(function (i) { return i.result === "created"; });
      var failed = items.filter(function (i) { return i.result === "failed"; });
      var trs = items.map(function (it) {
        var st, cls, detail = "";
        if (it.result === "created") { st = "Créé"; cls = "ok"; detail = it.finalEmail; }
        else if (it.result === "failed") { st = "Échec"; cls = "error"; detail = it.error; }
        else if (it.status === "skip") { st = "Ignoré"; cls = "skip"; detail = it.message; }
        else { st = "Erreur"; cls = "error"; detail = it.message; }
        return "<tr><td>" + esc(it.values.nom) + "</td><td class=\"imp-st-" + cls + "\">" + st + "</td><td>" + esc(detail) + "</td></tr>";
      }).join("");

      body.innerHTML =
        '<div class="imp-sum">' +
          '<span class="imp-pill ok">' + created.length + ' créé(s)</span>' +
          (failed.length ? '<span class="imp-pill error">' + failed.length + ' échec(s)</span>' : '') +
          (count("skip") ? '<span class="imp-pill skip">' + count("skip") + ' ignoré(s)</span>' : '') +
          (count("error") ? '<span class="imp-pill error">' + count("error") + ' invalide(s)</span>' : '') +
        '</div>' +
        '<div class="imp-scroll"><table class="imp-table"><thead><tr><th>Nom</th><th>Résultat</th><th>Détail</th></tr></thead><tbody>' + trs + '</tbody></table></div>' +
        '<div class="imp-info" style="margin-top:12px">Mot de passe par défaut des comptes créés : <b>' + DEFAULT_PASSWORD + '</b>.</div>';

      foot.innerHTML =
        '<button type="button" class="btn btn-ghost" id="imp-report"><i class="fas fa-download"></i> Télécharger le rapport</button>' +
        '<button type="button" class="btn btn-primary" data-imp-close>Terminer</button>';
      foot.querySelector("#imp-report").addEventListener("click", function () {
        var aoa = [["Nom", "Code", "Email", "Mot de passe", "Résultat", "Détail"]];
        items.forEach(function (it) {
          var res = it.result === "created" ? "Créé" : it.result === "failed" ? "Échec" : it.status === "skip" ? "Ignoré" : "Erreur";
          aoa.push([
            it.values.nom || "", it.values.code || "",
            it.finalEmail || it.email || "",
            it.result === "created" ? DEFAULT_PASSWORD : "",
            res, it.error || it.message || ""
          ]);
        });
        var ws = XLSX.utils.aoa_to_sheet(aoa);
        ws["!cols"] = [{ wch: 36 }, { wch: 16 }, { wch: 40 }, { wch: 14 }, { wch: 10 }, { wch: 40 }];
        var wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Rapport");
        XLSX.writeFile(wb, "rapport-" + cfg.templateFile);
      });
    }

    stepChoose();
  }

  /* ---------- Exports ---------- */
  window.EKOLSTAT.openImportModal = openImportModal;
  window.EKOLSTAT.importUtils = {
    norm: norm, slug: slug, emailFor: emailFor, emailWithCode: emailWithCode,
    normCategorie: normCategorie, normCycle: normCycle,
    parseRows: parseRows, validateRows: validateRows,
    DEFAULT_PASSWORD: DEFAULT_PASSWORD
  };
})();
