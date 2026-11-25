/* ============================================================
   EKOLSTAT — Espace Inspecteur itinérant - Version 3.0
   Hiérarchie : IGE → IPP → POOL → INSPECTEUR ITINÉRANT
   Responsabilités :
     • créer des écoles (sans compte) via un formulaire par étapes ;
     • créer leurs classes et renseigner les effectifs de chaque classe ;
     • une fois confirmé, tout remonte au Pool, à l'IPP et à l'IGE
       (chaque fiche porte inspecteurId / poolId / ippId).
   ============================================================ */

(function() {
  const auth = firebase.auth();
  const db = firebase.database();

  let currentUser = null;
  let currentProfile = null;
  let currentInspId = null;
  let currentPoolId = "";
  let currentIppId = "";

  // État global
  let ecoles = {};
  let classes = {};
  let effectifs = {};
  let cyclesData = null;
  let optionsData = [];

  // Graphique
  let evolutionChart = null;

  const fmt = (n) => n ? n.toLocaleString("fr-FR") : "0";
  const pct = (num, den) => den ? ((num / den) * 100).toFixed(1).replace(".", ",") + "%" : "0%";

  // ==================== SERIAL NUMBER ====================
  function generateSerialNumber() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const rand4 = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    return 'SERIE:MINENNC' + yyyy + mm + rand4;
  }

  // ==================== AUTHENTIFICATION ====================
  auth.onAuthStateChanged(async (user) => {
    if (!user) {
      window.location.href = "../login.html";
      return;
    }

    const snap = await db.ref("utilisateurs/" + user.uid).get();
    if (!snap.exists()) {
      await auth.signOut();
      window.location.href = "../login.html";
      return;
    }

    currentProfile = snap.val();
    if (currentProfile.role !== "inspecteur") {
      toast("Accès non autorisé", "error");
      await auth.signOut();
      setTimeout(() => window.location.href = "../login.html", 1200);
      return;
    }

    // Compte désactivé ou supprimé par le Pool
    if (currentProfile.statut === "inactif" || currentProfile.statut === "supprime") {
      toast("Ce compte a été désactivé par votre Pool.", "error");
      await auth.signOut();
      setTimeout(() => window.location.href = "../login.html", 1500);
      return;
    }

    currentUser = user;
    currentInspId = currentProfile.entiteId || currentProfile.inspecteurId || user.uid;
    currentPoolId = currentProfile.poolId || "";
    currentIppId = currentProfile.ippId || "";

    document.getElementById("user-name").textContent = currentProfile.nomEntite || "Inspecteur";
    document.getElementById("user-role").textContent = "Inspecteur itinérant";

    init();
  });

  // ==================== INITIALISATION ====================
  function init() {
    bindEvents();
    loadData();
    loadReferenceData().then(function () { _sched.mark("ref"); });
  }

  function loadReferenceData() {
    return Promise.all([
      EKOLSTAT.getRef(db, "cycles"),
      EKOLSTAT.getRef(db, "options_secondaire")
    ]).then(function (r) {
      cyclesData = r[0];
      optionsData = normalizeOptions(r[1]);
    }).catch(function (e) {
      console.error("[Inspecteur] Données de référence :", e);
    });
  }

  function loadData() {
    // Uniquement les écoles et classes créées par cet inspecteur
    db.ref("ecoles").orderByChild("inspecteurId").equalTo(currentInspId).on("value", (snap) => {
      ecoles = snap.val() || {};
      _sched.mark("ecoles");
      renderAll();
    });

    db.ref("classes").orderByChild("inspecteurId").equalTo(currentInspId).on("value", (snap) => {
      classes = snap.val() || {};
      _sched.mark("classes");
      effWatch.sync(Object.keys(classes));
      renderAll();
    });
  }

  // ==================== NAVIGATION ====================
  function showView(view) {
    document.querySelectorAll(".nav-link").forEach(l => l.classList.toggle("active", l.getAttribute("data-view") === view));
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    const viewEl = document.getElementById("view-" + view);
    if (viewEl) viewEl.classList.add("active");
    if (view === "overview") renderEvolutionChart();

    const sb = document.getElementById("sidebar");
    const ov = document.getElementById("sidebar-overlay");
    if (sb) sb.classList.remove("open");
    if (ov) ov.classList.remove("show");
  }

  function bindEvents() {
    const $ = (id) => document.getElementById(id);

    const logoutLink = $("logout-link");
    if (logoutLink) logoutLink.addEventListener("click", () => auth.signOut());

    const refreshBtn = $("refresh-btn");
    if (refreshBtn) refreshBtn.addEventListener("click", () => { renderAll(); toast("Données rafraîchies", "success"); });

    const globalSearch = $("global-search");
    if (globalSearch) {
      globalSearch.addEventListener("input", function(e) {
        const q = e.target.value.toLowerCase().trim();
        document.querySelectorAll("#ecole-summary-container tbody tr, #ecole-management-container tbody tr").forEach(function(r) {
          r.style.display = (!q || r.textContent.toLowerCase().includes(q)) ? "" : "none";
        });
      });
    }

    // Navigation latérale
    document.querySelectorAll(".nav-link[data-view]").forEach(link => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const view = link.getAttribute("data-view");
        if (view === "form") { startNewEcole(); return; }
        showView(view);
      });
    });

    // Boutons « Nouvelle école »
    ["btn-new-ecole", "btn-new-ecole-2"].forEach(id => { const b = $(id); if (b) b.addEventListener("click", startNewEcole); });

    bindWizardEvents();

    const btnExportPdf = $("btn-export-pdf");
    if (btnExportPdf) btnExportPdf.addEventListener("click", exportToPdf);

    document.querySelectorAll("[data-close-modal]").forEach(btn => {
      btn.addEventListener("click", () => { const m = btn.closest(".modal"); if (m) m.classList.remove("show"); });
    });

    // Hamburger (responsive, tous écrans)
    const sidebar = $("sidebar");
    const overlay = $("sidebar-overlay");
    const burger = $("hamburger-btn");
    if (burger && sidebar) {
      burger.addEventListener("click", () => {
        if (window.innerWidth <= 1024) {
          sidebar.classList.add("open");
          if (overlay) overlay.classList.add("show");
        } else {
          sidebar.classList.toggle("collapsed");
        }
      });
    }
    if (overlay && sidebar) {
      overlay.addEventListener("click", () => { sidebar.classList.remove("open"); overlay.classList.remove("show"); });
    }
    window.addEventListener("resize", () => {
      if (window.innerWidth > 1024) {
        sidebar.classList.remove("open");
        if (overlay) overlay.classList.remove("show");
      }
    });
  }

  // ==================== AGRÉGATION ====================
  function getStats() {
    const stats = {
      totalEcoles: 0, ecolesPubliques: 0, ecolesPrivees: 0,
      totalClasses: 0, totalEleves: 0, totalFilles: 0, totalGarcons: 0, totalHandicap: 0,
      ecoleStats: {}
    };

    for (const ecoleId in ecoles) {
      if (!ecoles.hasOwnProperty(ecoleId)) continue;
      const ecole = ecoles[ecoleId];
      if (ecole.statut === "supprime") continue;
      stats.totalEcoles++;
      if (ecole.categorie === "publique") stats.ecolesPubliques++;
      else if (ecole.categorie === "privee") stats.ecolesPrivees++;
      stats.ecoleStats[ecoleId] = {
        nom: ecole.nom,
        code: ecole.code || "",
        responsable: ecole.responsable || "",
        cycle: ecole.cycle || "",
        categorie: ecole.categorie || "",
        classes: 0, eleves: 0, filles: 0, garcons: 0
      };
    }

    for (const id in classes) {
      if (!classes.hasOwnProperty(id)) continue;
      const classe = classes[id];
      if (classe.statut === "supprime") continue;

      const eff = effectifs[id] || { nb_filles:0, nb_garcons:0 };
      const f = eff.nb_filles || 0;
      const g = eff.nb_garcons || 0;

      stats.totalClasses++;
      stats.totalEleves += f + g;
      stats.totalFilles += f;
      stats.totalGarcons += g;
      stats.totalHandicap += eff.nb_handicap || 0;

      const es = classe.ecoleId && stats.ecoleStats[classe.ecoleId];
      if (es) { es.classes++; es.eleves += f + g; es.filles += f; es.garcons += g; }
    }
    return stats;
  }

  // Stats détaillées par cycle (pour rapports + PDF)
  function getStatsDetaillees() {
    const statsMaternelle = { 1:0, 2:0, 3:0, filles:{1:0,2:0,3:0}, garcons:{1:0,2:0,3:0} };
    const statsPrimaire = { 1:0,2:0,3:0,4:0,5:0,6:0, filles:{1:0,2:0,3:0,4:0,5:0,6:0}, garcons:{1:0,2:0,3:0,4:0,5:0,6:0} };
    const statsCTEB = { 7:0, 8:0, filles:{7:0,8:0}, garcons:{7:0,8:0} };
    const statsCycleLong = {};
    const statsCycleCourt = {};

    for (const id in classes) {
      if (!classes.hasOwnProperty(id)) continue;
      const classe = classes[id];
      if (classe.statut === "supprime") continue;

      const eff = effectifs[id] || { nb_filles:0, nb_garcons:0 };
      const f = eff.nb_filles || 0;
      const g = eff.nb_garcons || 0;

      const niveau = classe.niveau;
      const cycle = classe.cycle;
      const option = classe.optionCode;

      if (cycle === "maternelle") {
        statsMaternelle[niveau] = (statsMaternelle[niveau] || 0) + f + g;
        statsMaternelle.filles[niveau] = (statsMaternelle.filles[niveau] || 0) + f;
        statsMaternelle.garcons[niveau] = (statsMaternelle.garcons[niveau] || 0) + g;
      } else if (cycle === "primaire") {
        statsPrimaire[niveau] = (statsPrimaire[niveau] || 0) + f + g;
        statsPrimaire.filles[niveau] = (statsPrimaire.filles[niveau] || 0) + f;
        statsPrimaire.garcons[niveau] = (statsPrimaire.garcons[niveau] || 0) + g;
      } else if (cycle === "secondaire") {
        const sousCycle = classe.sousCycle;
        if (sousCycle === "cteb") {
          statsCTEB[niveau] = (statsCTEB[niveau] || 0) + f + g;
          statsCTEB.filles[niveau] = (statsCTEB.filles[niveau] || 0) + f;
          statsCTEB.garcons[niveau] = (statsCTEB.garcons[niveau] || 0) + g;
        } else if (sousCycle === "long") {
          if (!statsCycleLong[niveau]) statsCycleLong[niveau] = {};
          if (!statsCycleLong[niveau][option]) {
            statsCycleLong[niveau][option] = { total:0, filles:0, garcons:0, optionLibelle: classe.optionLibelle };
          }
          statsCycleLong[niveau][option].total += f + g;
          statsCycleLong[niveau][option].filles += f;
          statsCycleLong[niveau][option].garcons += g;
        } else if (sousCycle === "court") {
          if (!statsCycleCourt[niveau]) statsCycleCourt[niveau] = {};
          if (!statsCycleCourt[niveau][option]) {
            statsCycleCourt[niveau][option] = { total:0, filles:0, garcons:0, optionLibelle: classe.optionLibelle };
          }
          statsCycleCourt[niveau][option].total += f + g;
          statsCycleCourt[niveau][option].filles += f;
          statsCycleCourt[niveau][option].garcons += g;
        }
      }
    }

    return { statsMaternelle, statsPrimaire, statsCTEB, statsCycleLong, statsCycleCourt };
  }


  // ==================== RENDU ====================
  // Rendu groupé : un seul rendu une fois les données initiales reçues
  var _sched = EKOLSTAT.createRenderScheduler(function () { renderAllNow(); }, ["ecoles", "classes", "effectifs", "ref"]);
  function renderAll() { _sched.render(); }

  // Effectifs : uniquement ceux des classes de l'inspecteur
  var effWatch = EKOLSTAT.watchEffectifs(db,
    function (data) { effectifs = data; renderAll(); },
    function () { _sched.mark("effectifs"); });

  function renderAllNow() {
    const stats = getStats();
    renderKPIs(stats);
    renderEcoleSummaryTable(stats);
    renderEcoleManagementTable(stats);
    renderReports(stats);
    if (window.Chart) renderEvolutionChart();
  }

  function renderKPIs(stats) {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = fmt(val); };
    set("total-ecoles", stats.totalEcoles);
    set("total-classes", stats.totalClasses);
    set("total-eleves", stats.totalEleves);
    set("total-filles", stats.totalFilles);
    set("total-garcons", stats.totalGarcons);
    set("total-handicap", stats.totalHandicap);
    set("ecoles-publiques", stats.ecolesPubliques);
    set("ecoles-privees", stats.ecolesPrivees);
  }

  function cycleLabelOf(c) {
    return c === "maternelle" ? "Maternelle" : c === "primaire" ? "Primaire" : c === "secondaire" ? "Secondaire" : "—";
  }
  function regimeLabelOf(c) {
    return c === "publique" ? "Publique" : c === "privee" ? "Privée" : "—";
  }

  function renderEcoleSummaryTable(stats) {
    const container = document.getElementById("ecole-summary-container");
    if (!container) return;

    const ids = Object.keys(stats.ecoleStats);
    if (ids.length === 0) {
      container.innerHTML = '<div class="empty">Aucune école pour le moment. Cliquez sur « Nouvelle école » pour commencer la collecte.</div>';
      return;
    }

    let html = '<table class="data-table"><thead><tr>';
    html += '<th>École</th><th>Type</th><th>Régime</th><th>Classes</th><th>Filles</th><th>Garçons</th><th><strong>Total élèves</strong></th>';
    html += '</tr></thead><tbody>';
    ids.forEach(function(id) {
      const s = stats.ecoleStats[id];
      html += '<tr>';
      html += '<td><strong>' + escape(s.nom) + '</strong></td>';
      html += '<td>' + cycleLabelOf(s.cycle) + '</td>';
      html += '<td>' + regimeLabelOf(s.categorie) + '</td>';
      html += '<td>' + fmt(s.classes) + '</td>';
      html += '<td>' + fmt(s.filles) + ' (' + pct(s.filles, s.eleves) + ')</td>';
      html += '<td>' + fmt(s.garcons) + ' (' + pct(s.garcons, s.eleves) + ')</td>';
      html += '<td><strong>' + fmt(s.eleves) + '</strong></td>';
      html += '</tr>';
    });
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  function renderEcoleManagementTable(stats) {
    const container = document.getElementById("ecole-management-container");
    if (!container) return;

    const ids = Object.keys(stats.ecoleStats);
    if (ids.length === 0) {
      container.innerHTML = '<div class="empty">Aucune école. Cliquez sur « Nouvelle école » pour commencer.</div>';
      return;
    }

    let html = '<table class="data-table"><thead><tr>';
    html += '<th>Nom</th><th>Responsable</th><th>Type</th><th>Régime</th><th>Classes</th><th>Élèves</th><th>Actions</th>';
    html += '</tr></thead><tbody>';
    ids.forEach(function(id) {
      const s = stats.ecoleStats[id];
      html += '<tr>';
      html += '<td><strong>' + escape(s.nom) + '</strong></td>';
      html += '<td>' + escape(s.responsable || "-") + '</td>';
      html += '<td>' + cycleLabelOf(s.cycle) + '</td>';
      html += '<td>' + regimeLabelOf(s.categorie) + '</td>';
      html += '<td>' + fmt(s.classes) + '</td>';
      html += '<td>' + fmt(s.eleves) + '</td>';
      html += '<td><div class="row-actions">';
      html += '<button class="icon-btn" onclick="editEcole(\'' + id + '\')" title="Modifier l\'école, ses classes et effectifs"><i class="fas fa-edit"></i></button>';
      html += '</div></td></tr>';
    });
    html += '</tbody></table>';
    container.innerHTML = html;
  }


  // ==================== FORMULAIRE : ÉCOLE → CLASSES → EFFECTIFS ====================
  // Étape 1 : type d'école (maternelle / primaire / secondaire)
  // Étape 2 : informations de l'école
  // Étape 3 : classes et effectifs (les choix dépendent du type)
  // Étape 4 : récapitulatif + confirmation (écriture unique, atomique)

  function ordinal(n) { return n === 1 ? "1ère" : n + "ème"; }
  function mkClasses(n, suffix) {
    const a = [];
    for (let i = 1; i <= n; i++) a.push({ niveau: i, nom: ordinal(i) + " " + suffix });
    return a;
  }
  // Valeurs de secours si la table de référence « cycles » est inaccessible (hors-ligne, 1re ouverture)
  const FALLBACK_CYCLES = {
    maternelle: { nom: "Maternelle", classes: mkClasses(3, "Maternelle") },
    primaire:   { nom: "Primaire",   classes: mkClasses(6, "Primaire") },
    secondaire: { nom: "Secondaire", sousCycles: {
      cteb:  { nom: "CTEB (7ème & 8ème)", classes: [{ niveau: 7, nom: "7ème" }, { niveau: 8, nom: "8ème" }] },
      long:  { nom: "Cycle Long (1ère → 4ème Humanité)",  classes: mkClasses(4, "Humanité") },
      court: { nom: "Cycle Court (1ère → 3ème Humanité)", classes: mkClasses(3, "Humanité") }
    } }
  };
  function cyc() {
    const c = cyclesData;
    return (c && c.maternelle && c.primaire && c.secondaire && c.secondaire.sousCycles) ? c : FALLBACK_CYCLES;
  }
  function normalizeOptions(o) {
    if (!o) return [];
    return (Array.isArray(o) ? o : Object.values(o)).filter(function (x) { return x && x.code; });
  }
  function classList(cycle, sousCycle) {
    const c = cyc();
    if (cycle === "secondaire") {
      const sc = c.secondaire.sousCycles[sousCycle];
      return (sc && sc.classes) || [];
    }
    return (c[cycle] && c[cycle].classes) || [];
  }
  function needsOption(row) {
    return wz.cycle === "secondaire" && (row.sousCycle === "long" || row.sousCycle === "court");
  }
  function niveauNom(row) {
    const f = classList(wz.cycle, row.sousCycle).find(function (c) { return String(c.niveau) === String(row.niveau); });
    return f ? f.nom : "";
  }
  function optionLibelle(code) {
    const o = optionsData.find(function (x) { return x.code === code; });
    return o ? o.libelle : "";
  }

  // ---- État du formulaire ----
  let wz = newWz();
  let rowSeq = 0;
  function newWz() {
    return { step: 1, editId: null, cycle: "", nom: "", code: "", responsable: "", categorie: "", rows: [], removedIds: [] };
  }
  function newRow(p) {
    return Object.assign({ key: "r" + (++rowSeq), id: null, sousCycle: "", niveau: "", optionCode: "", handicap: 0, filles: 0, garcons: 0 }, p || {});
  }
  function wzDirty() { return !!(wz.cycle || wz.nom || wz.rows.length); }

  // ---- Brouillon local : évite de tout perdre si la page se recharge sur le terrain ----
  function draftKey() { return "ekolstat_draft_" + currentInspId; }
  function saveDraft() {
    if (wz.editId) return;
    try {
      if (!wzDirty()) { localStorage.removeItem(draftKey()); return; }
      localStorage.setItem(draftKey(), JSON.stringify(wz));
    } catch (e) { /* stockage indisponible */ }
  }
  function loadDraft() {
    try {
      const raw = localStorage.getItem(draftKey());
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (!d || d.editId) return null;
      d.rows = (d.rows || []).map(function (r) { return newRow(r); });
      d.removedIds = [];
      return d;
    } catch (e) { return null; }
  }
  function clearDraft() { try { localStorage.removeItem(draftKey()); } catch (e) {} }

  function startNewEcole() {
    wz = newWz();
    const d = loadDraft();
    if (d) { wz = Object.assign(newWz(), d); toast("Brouillon restauré : reprenez où vous vous étiez arrêté.", "info"); }
    renderWizard();
    showView("form");
  }

  function startEditEcole(id) {
    const e = ecoles[id];
    if (!e) return;
    const rows = Object.keys(classes)
      .filter(function (cid) { return classes[cid].ecoleId === id && classes[cid].statut !== "supprime"; })
      .sort(function (a, b) {
        const x = classes[a], y = classes[b];
        return (x.sousCycle || "").localeCompare(y.sousCycle || "") || (x.niveau || 0) - (y.niveau || 0);
      })
      .map(function (cid) {
        const c = classes[cid], eff = effectifs[cid] || {};
        return newRow({
          id: cid, sousCycle: c.sousCycle || "", niveau: String(c.niveau), optionCode: c.optionCode || "",
          handicap: eff.nb_handicap || 0, filles: eff.nb_filles || 0, garcons: eff.nb_garcons || 0
        });
      });
    wz = Object.assign(newWz(), {
      step: 2, editId: id, cycle: e.cycle || "", nom: e.nom || "", code: e.code || "",
      responsable: e.responsable || "", categorie: e.categorie || "", rows: rows
    });
    renderWizard();
    showView("form");
  }

  // ---- Affichage ----
  function renderWizard() {
    const $ = function (id) { return document.getElementById(id); };
    const editing = !!wz.editId;

    $("wz-title").innerHTML = editing
      ? '<i class="fas fa-pen-to-square"></i> Modifier l\'école'
      : '<i class="fas fa-circle-plus"></i> Nouvelle école';
    $("wz-sub").textContent = editing
      ? "Corrigez les informations, les classes ou les effectifs puis confirmez."
      : "Renseignez l'école, ses classes et ses effectifs";

    // Étapes
    document.querySelectorAll("#wz-steps li").forEach(function (li) {
      const n = Number(li.getAttribute("data-step"));
      li.classList.toggle("active", n === wz.step);
      li.classList.toggle("done", n < wz.step);
    });
    for (let i = 1; i <= 4; i++) $("wz-pane-" + i).classList.toggle("hidden", i !== wz.step);

    // Boutons
    $("wz-prev").classList.toggle("hidden", wz.step === 1 || (editing && wz.step === 2));
    $("wz-next").classList.toggle("hidden", wz.step === 4 || wz.step === 1);
    $("wz-confirm").classList.toggle("hidden", wz.step !== 4);

    // Étape 1 : cartes
    const cards = $("type-cards");
    cards.classList.toggle("locked", editing && !!wz.cycle);
    cards.querySelectorAll(".type-card").forEach(function (c) {
      c.classList.toggle("selected", c.getAttribute("data-cycle") === wz.cycle);
    });

    // Étape 2 : champs
    $("ecole-nom").value = wz.nom;
    $("ecole-code").value = wz.code;
    $("ecole-responsable").value = wz.responsable;
    $("ecole-categorie").value = wz.categorie;
    $("wz-cycle-badge").textContent = wz.cycle ? "École " + cycleLabelOf(wz.cycle).toLowerCase() : "";

    // Étape 3 : classes
    $("btn-fill-all").classList.toggle("hidden", wz.cycle === "secondaire" || !wz.cycle);
    renderRows();

    // Étape 4 : récapitulatif
    if (wz.step === 4) renderRecap();
  }

  function renderRows() {
    const box = document.getElementById("classe-rows");
    if (!box) return;
    if (!wz.rows.length) {
      box.innerHTML = '<div class="wz-empty"><i class="fas fa-chalkboard" style="font-size:26px;margin-bottom:8px;display:block"></i>Aucune classe pour le moment. Cliquez sur « Ajouter une classe ».</div>';
    } else {
      box.innerHTML = wz.rows.map(rowHtml).join("");
    }
    updateTotals();
  }

  function rowHtml(row, i) {
    const sec = wz.cycle === "secondaire";
    const opt = function (v, label, sel) { return '<option value="' + escape(v) + '"' + (sel ? " selected" : "") + '>' + escape(label) + '</option>'; };
    let h = '<div class="classe-row" data-key="' + row.key + '">';
    h += '<div class="classe-row-head"><span><i class="fas fa-chalkboard"></i> Classe ' + (i + 1) + '</span>';
    h += '<button type="button" class="icon-btn danger" data-act="remove" title="Retirer cette classe"><i class="fas fa-trash"></i></button></div>';
    h += '<div class="classe-row-grid">';

    if (sec) {
      const scs = cyc().secondaire.sousCycles;
      h += '<div class="form-field"><label>Sous-cycle *</label><select data-f="sousCycle"><option value="">Sélectionner</option>';
      Object.keys(scs).forEach(function (k) { h += opt(k, scs[k].nom, row.sousCycle === k); });
      h += '</select></div>';
    }

    const list = classList(wz.cycle, row.sousCycle);
    h += '<div class="form-field"><label>Classe *</label><select data-f="niveau"' + (sec && !row.sousCycle ? " disabled" : "") + '>';
    h += '<option value="">' + (sec && !row.sousCycle ? "Choisir le sous-cycle" : "Sélectionner") + '</option>';
    list.forEach(function (c) { h += opt(c.niveau, c.nom, String(c.niveau) === String(row.niveau)); });
    h += '</select></div>';

    if (needsOption(row)) {
      h += '<div class="form-field"><label>Option *</label><select data-f="optionCode"><option value="">Sélectionner</option>';
      optionsData.forEach(function (o) { h += opt(o.code, o.code + " - " + o.libelle, row.optionCode === o.code); });
      h += '</select></div>';
    }

    h += '<div class="form-field"><label><i class="fas fa-venus"></i> Filles *</label><input type="number" inputmode="numeric" min="0" data-f="filles" value="' + (row.filles || 0) + '" /></div>';
    h += '<div class="form-field"><label><i class="fas fa-mars"></i> Garçons *</label><input type="number" inputmode="numeric" min="0" data-f="garcons" value="' + (row.garcons || 0) + '" /></div>';
    h += '<div class="form-field"><label><i class="fas fa-wheelchair"></i> Élèves vivant avec un handicap</label><input type="number" inputmode="numeric" min="0" data-f="handicap" value="' + (row.handicap || 0) + '" /></div>';
    h += '</div></div>';
    return h;
  }

  function updateTotals() {
    const el = document.getElementById("wz-totals");
    if (!el) return;
    let f = 0, g = 0, hd = 0;
    wz.rows.forEach(function (r) { f += r.filles || 0; g += r.garcons || 0; hd += r.handicap || 0; });
    el.innerHTML = '<span>Classes : <b>' + fmt(wz.rows.length) + '</b></span><span>Filles : <b>' + fmt(f) + '</b></span><span>Garçons : <b>' + fmt(g) + '</b></span><span>Total élèves : <b>' + fmt(f + g) + '</b></span><span>Handicap : <b>' + fmt(hd) + '</b></span>';
  }

  function renderRecap() {
    let f = 0, g = 0, hd = 0;
    let html = '<div class="wz-recap-meta">';
    html += '<div><span>École</span><strong>' + escape(wz.nom) + '</strong></div>';
    html += '<div><span>Type</span><strong>' + cycleLabelOf(wz.cycle) + '</strong></div>';
    html += '<div><span>Régime</span><strong>' + regimeLabelOf(wz.categorie) + '</strong></div>';
    html += '<div><span>Code</span><strong>' + escape(wz.code || "—") + '</strong></div>';
    html += '<div><span>Responsable</span><strong>' + escape(wz.responsable || "—") + '</strong></div>';
    html += '</div>';
    html += '<div class="table-wrap"><table class="data-table"><thead><tr><th>Classe</th><th>Option</th><th>Filles</th><th>Garçons</th><th>Total</th><th>Handicap</th></tr></thead><tbody>';
    wz.rows.forEach(function (r) {
      f += r.filles || 0; g += r.garcons || 0;
      html += '<tr><td>' + escape(niveauNom(r)) + (r.sousCycle ? ' <small>(' + escape(r.sousCycle.toUpperCase()) + ')</small>' : '') + '</td>';
      html += '<td>' + escape(needsOption(r) ? r.optionCode + " - " + optionLibelle(r.optionCode) : "—") + '</td>';
      html += '<td>' + fmt(r.filles) + '</td><td>' + fmt(r.garcons) + '</td><td><strong>' + fmt((r.filles || 0) + (r.garcons || 0)) + '</strong></td><td>' + fmt(r.handicap) + '</td></tr>';
      hd += r.handicap || 0;
    });
    html += '<tr><td colspan="2"><strong>Total</strong></td><td><strong>' + fmt(f) + '</strong></td><td><strong>' + fmt(g) + '</strong></td><td><strong>' + fmt(f + g) + '</strong></td><td><strong>' + fmt(hd) + '</strong></td></tr>';
    html += '</tbody></table></div>';
    document.getElementById("wz-recap").innerHTML = html;
  }

  // ---- Validation ----
  function validateStep(n) {
    if (n >= 1 && !wz.cycle) { toast("Choisissez d'abord le type d'école.", "error"); return 1; }
    if (n >= 2) {
      if (!wz.nom.trim()) { toast("Le nom de l'école est obligatoire.", "error"); return 2; }
      if (!wz.categorie) { toast("Choisissez le régime (publique ou privée).", "error"); return 2; }
    }
    if (n >= 3) {
      if (!wz.rows.length) { toast("Ajoutez au moins une classe.", "error"); return 3; }
      for (let i = 0; i < wz.rows.length; i++) {
        const r = wz.rows[i];
        if (wz.cycle === "secondaire" && !r.sousCycle) { toast("Classe " + (i + 1) + " : choisissez le sous-cycle.", "error"); return 3; }
        if (!r.niveau) { toast("Classe " + (i + 1) + " : choisissez la classe.", "error"); return 3; }
        if (needsOption(r) && !r.optionCode) { toast("Classe " + (i + 1) + " : choisissez l'option.", "error"); return 3; }
        if ((r.handicap || 0) > (r.filles || 0) + (r.garcons || 0)) { toast("Classe " + (i + 1) + " : les élèves avec handicap ne peuvent pas dépasser l'effectif de la classe.", "error"); return 3; }
      }
    }
    return 0;
  }

  // ---- Doublons : même nom autorisé uniquement si le type d'école est différent ----
  // (un complexe maternelle + primaire + secondaire = 3 écoles, donc 3 fiches)
  function slugName(s) {
    return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }
  async function loadPoolEcoles() {
    if (!currentPoolId) return ecoles;
    try {
      const snap = await db.ref("ecoles").orderByChild("poolId").equalTo(currentPoolId).once("value");
      return Object.assign({}, snap.val() || {}, ecoles);
    } catch (e) {
      return ecoles; // lecture du pool non permise : on contrôle au moins ses propres écoles
    }
  }
  // Renvoie { exact, autreType } : exact = même nom ET même type (interdit)
  async function checkDuplicate() {
    const key = slugName(wz.nom);
    const all = await loadPoolEcoles();
    let exact = null, autreType = null;
    Object.keys(all).forEach(function (id) {
      const e = all[id];
      if (id === wz.editId || !e || e.statut === "supprime") return;
      if (slugName(e.nom) !== key) return;
      if (e.cycle === wz.cycle) exact = exact || e; else autreType = autreType || e;
    });
    return { exact: exact, autreType: autreType };
  }
  function dupMessage(e) {
    return 'Une école « ' + e.nom + ' » de type ' + cycleLabelOf(e.cycle).toLowerCase() + ' existe déjà' +
      (e.inspecteurNom ? ' (inspecteur : ' + e.inspecteurNom + ')' : '') +
      '. Un même nom n\'est accepté que pour des types différents (maternelle, primaire, secondaire).';
  }

  async function goStep(n) {
    if (n > wz.step) {
      const bad = validateStep(wz.step);
      if (bad) return;
      if (wz.step === 2) {
        const d = await checkDuplicate();
        if (d.exact) { toast(dupMessage(d.exact), "error"); return; }
        if (d.autreType) toast('Ce nom existe déjà pour une école ' + cycleLabelOf(d.autreType.cycle).toLowerCase() + ' : accepté, car le type est différent.', "info");
      }
    }
    wz.step = n;
    saveDraft();
    renderWizard();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ---- Événements ----
  function bindWizardEvents() {
    const $ = function (id) { return document.getElementById(id); };

    // Étape 1 : choix du type → passe directement à l'étape 2
    $("type-cards").addEventListener("click", async function (e) {
      const card = e.target.closest(".type-card");
      if (!card) return;
      const cycle = card.getAttribute("data-cycle");
      if (cycle === wz.cycle) { goStep(2); return; }
      if (wz.rows.length) {
        const ok = await confirmDialog("Changer le type d'école ?", "Les classes déjà saisies seront retirées car elles dépendent du type.");
        if (!ok) return;
        wz.rows = [];
      }
      wz.cycle = cycle;
      goStep(2);
    });

    // Étape 2 : saisie
    [["ecole-nom", "nom"], ["ecole-code", "code"], ["ecole-responsable", "responsable"], ["ecole-categorie", "categorie"]].forEach(function (p) {
      const el = $(p[0]);
      el.addEventListener("input", function () { wz[p[1]] = el.value; saveDraft(); });
      el.addEventListener("change", function () { wz[p[1]] = el.value; saveDraft(); });
    });

    // Étape 3 : lignes de classes (délégation)
    const box = $("classe-rows");
    box.addEventListener("click", function (e) {
      const btn = e.target.closest('[data-act="remove"]');
      if (!btn) return;
      const key = btn.closest(".classe-row").getAttribute("data-key");
      const row = wz.rows.find(function (r) { return r.key === key; });
      if (row && row.id) wz.removedIds.push(row.id);
      wz.rows = wz.rows.filter(function (r) { return r.key !== key; });
      saveDraft();
      renderRows();
    });
    box.addEventListener("change", function (e) {
      const f = e.target.getAttribute("data-f");
      if (!f || e.target.tagName !== "SELECT") return;
      const row = wz.rows.find(function (r) { return r.key === e.target.closest(".classe-row").getAttribute("data-key"); });
      if (!row) return;
      row[f] = e.target.value;
      if (f === "sousCycle") { row.niveau = ""; row.optionCode = ""; renderRows(); }
      saveDraft();
    });
    box.addEventListener("input", function (e) {
      const f = e.target.getAttribute("data-f");
      if (!f || e.target.tagName !== "INPUT") return;
      const row = wz.rows.find(function (r) { return r.key === e.target.closest(".classe-row").getAttribute("data-key"); });
      if (!row) return;
      if (f === "filles" || f === "garcons" || f === "handicap") {
        row[f] = Math.max(0, parseInt(e.target.value, 10) || 0);
        updateTotals();
      } else {
        row[f] = e.target.value;
      }
      saveDraft();
    });

    $("btn-add-classe").addEventListener("click", function () {
      wz.rows.push(newRow());
      saveDraft();
      renderRows();
      const last = box.lastElementChild;
      if (last && last.scrollIntoView) last.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    // Maternelle / primaire : toutes les classes du cycle d'un coup
    $("btn-fill-all").addEventListener("click", function () {
      const present = {};
      wz.rows.forEach(function (r) { present[String(r.niveau)] = true; });
      let added = 0;
      classList(wz.cycle, "").forEach(function (c) {
        if (present[String(c.niveau)]) return;
        wz.rows.push(newRow({ niveau: String(c.niveau) }));
        added++;
      });
      if (!added) toast("Toutes les classes du cycle sont déjà dans la liste.", "info");
      saveDraft();
      renderRows();
    });

    // Navigation
    $("wz-prev").addEventListener("click", function () { goStep(Math.max(1, wz.step - 1)); });
    $("wz-next").addEventListener("click", function () { goStep(Math.min(4, wz.step + 1)); });
    $("wz-confirm").addEventListener("click", confirmEcole);
    $("wz-cancel").addEventListener("click", async function () {
      if (wzDirty()) {
        const ok = await confirmDialog("Abandonner la saisie ?", wz.editId ? "Les modifications non confirmées seront perdues." : "Ce qui a été saisi pour cette école sera effacé.");
        if (!ok) return;
      }
      const wasEdit = !!wz.editId;
      clearDraft();
      wz = newWz();
      renderWizard();
      showView(wasEdit ? "ecoles" : "overview");
    });
  }

  // ---- Confirmation : écriture atomique (école + classes + effectifs) ----
  async function confirmEcole() {
    const bad = validateStep(3);
    if (bad) { goStep(bad); return; }

    // L'école a pu être réassignée à un autre inspecteur par le Pool pendant la saisie
    if (wz.editId && !ecoles[wz.editId]) {
      toast("Cette école n'est plus sous votre responsabilité (réassignée par le Pool). Modification annulée.", "error");
      clearDraft(); wz = newWz(); renderWizard(); showView("ecoles");
      return;
    }

    // Dernier contrôle avant écriture (quelqu'un a pu créer la même école entre-temps)
    const dup = await checkDuplicate();
    if (dup.exact) { toast(dupMessage(dup.exact), "error"); goStep(2); return; }

    const btn = document.getElementById("wz-confirm");
    btn.disabled = true;
    const TS = firebase.database.ServerValue.TIMESTAMP;
    const u = {};

    try {
      const ecoleId = wz.editId || db.ref("ecoles").push().key;
      const eb = "ecoles/" + ecoleId + "/";
      u[eb + "nom"] = wz.nom.trim();
      u[eb + "code"] = wz.code.trim();
      u[eb + "responsable"] = wz.responsable.trim();
      u[eb + "cycle"] = wz.cycle;
      u[eb + "categorie"] = wz.categorie;
      u[eb + "inspecteurId"] = currentInspId;
      u[eb + "inspecteurNom"] = currentProfile.nomEntite || "";
      u[eb + "poolId"] = currentPoolId;
      u[eb + "ippId"] = currentIppId;
      u[eb + "confirmeLe"] = TS;
      if (!wz.editId) { u[eb + "statut"] = "actif"; u[eb + "createdAt"] = TS; }
      else { u[eb + "updatedAt"] = TS; }

      wz.rows.forEach(function (r) {
        const cid = r.id || ("classe_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8));
        const cb = "classes/" + cid + "/";
        const sec = wz.cycle === "secondaire";
        const opt = needsOption(r);
        u[cb + "nom"] = niveauNom(r) || (cycleLabelOf(wz.cycle) + " - Niveau " + r.niveau);
        u[cb + "cycle"] = wz.cycle;
        u[cb + "niveau"] = parseInt(r.niveau, 10);
        u[cb + "professeurPrincipal"] = null;
        u[cb + "ecoleId"] = ecoleId;
        u[cb + "inspecteurId"] = currentInspId;
        u[cb + "poolId"] = currentPoolId;
        u[cb + "ippId"] = currentIppId;
        u[cb + "statut"] = "actif";
        u[cb + "sousCycle"] = sec ? r.sousCycle : null;
        u[cb + "optionCode"] = opt ? r.optionCode : null;
        u[cb + "optionLibelle"] = opt ? optionLibelle(r.optionCode) : null;
        if (!r.id) u[cb + "createdAt"] = TS;

        // On ne réécrit les effectifs (et leur date) que s'ils ont changé
        const prev = r.id ? effectifs[r.id] : null;
        if (!prev || prev.nb_filles !== r.filles || prev.nb_garcons !== r.garcons || (prev.nb_handicap || 0) !== (r.handicap || 0)) {
          u["effectifs/" + cid] = { nb_filles: r.filles || 0, nb_garcons: r.garcons || 0, nb_handicap: r.handicap || 0, lastUpdate: TS };
        }
      });

      wz.removedIds.forEach(function (cid) {
        u["classes/" + cid] = null;
        u["effectifs/" + cid] = null;
      });

      // Sans réseau, Firebase garde l'écriture en local et l'envoie au retour de la connexion.
      const res = await Promise.race([
        db.ref().update(u).then(function () { return "ok"; }),
        new Promise(function (resolve) { setTimeout(function () { resolve("pending"); }, 8000); })
      ]);

      const nom = wz.nom.trim();
      const wasEdit = !!wz.editId;
      clearDraft();
      wz = newWz();
      renderWizard();
      showView("ecoles");
      if (res === "ok") {
        toast(wasEdit ? 'École "' + nom + '" mise à jour.' : 'École "' + nom + '" confirmée : les informations sont remontées au Pool.', "success");
      } else {
        toast('École "' + nom + '" enregistrée sur l\'appareil. Elle sera envoyée dès le retour de la connexion : gardez l\'application ouverte.', "info");
      }
    } catch (error) {
      console.error(error);
      toast("Erreur : " + error.message, "error");
    } finally {
      btn.disabled = false;
    }
  }

  window.editEcole = startEditEcole;


  // ==================== RAPPORTS (UI) ====================
  function renderReports(stats) {
    const container = document.getElementById("reports-container");
    if (!container) return;

    const d = getStatsDetaillees();

    const thStyle = 'border:1px solid #e5e7eb;padding:6px 8px;background:#f3f4f6;text-align:left;';
    const tdStyle = 'border:1px solid #e5e7eb;padding:6px 8px;text-align:left;';
    const sectionStyle = 'font-size:14px;font-weight:bold;background:#eef5fe;padding:6px 10px;border-left:4px solid #1762cb;margin:20px 0 10px;';

    let html = '';

    html += '<div style="margin-bottom:25px;"><h3 style="' + sectionStyle + '">Cycle Maternelle</h3>';
    html += buildReportTable(['Classe','Filles','Garçons','<strong>Total</strong>'], buildMaternelleRows(d.statsMaternelle), thStyle, tdStyle);
    html += '</div>';

    html += '<div style="margin-bottom:25px;"><h3 style="' + sectionStyle + '">Cycle Primaire</h3>';
    html += buildReportTable(['Classe','Filles','Garçons','<strong>Total</strong>'], buildPrimaireRows(d.statsPrimaire), thStyle, tdStyle);
    html += '</div>';

    html += '<div style="margin-bottom:25px;"><h3 style="' + sectionStyle + '">CTEB (7ème & 8ème)</h3>';
    html += buildReportTable(['Classe','Filles','Garçons','<strong>Total</strong>'], buildCtebRows(d.statsCTEB), thStyle, tdStyle);
    html += '</div>';

    html += '<div style="margin-bottom:25px;"><h3 style="' + sectionStyle + '">Cycle Long (1ère → 4ème Humanité)</h3>';
    html += buildReportTable(['Niveau','Option','Code','Filles','Garçons','<strong>Total</strong>'], buildCycleLongRows(d.statsCycleLong), thStyle, tdStyle);
    html += '</div>';

    html += '<div style="margin-bottom:25px;"><h3 style="' + sectionStyle + '">Cycle Court (1ère → 3ème Humanité)</h3>';
    html += buildReportTable(['Niveau','Option','Code','Filles','Garçons','<strong>Total</strong>'], buildCycleCourtRows(d.statsCycleCourt), thStyle, tdStyle);
    html += '</div>';

    // Synthèse par École
    html += '<div style="margin-bottom:25px;"><h3 style="' + sectionStyle + '">Synthèse par École</h3>';
    html += buildReportTable(
      ['École','Cycle','Classes','Filles','Garçons','<strong>Total</strong>'],
      buildEcoleSummaryRows(stats),
      thStyle, tdStyle
    );
    html += '</div>';

    container.innerHTML = html;
  }

  // ---- Helpers de construction de lignes (UI + PDF) ----
  function buildMaternelleRows(s) {
    const rows = [];
    const niveaux = ["1ère Maternelle", "2ème Maternelle", "3ème Maternelle"];
    for (let i = 1; i <= 3; i++) {
      const total = s[i] || 0;
      const filles = s.filles[i] || 0;
      const garcons = s.garcons[i] || 0;
      rows.push([
        niveaux[i-1],
        fmt(filles) + ' (' + pct(filles, total) + ')',
        fmt(garcons) + ' (' + pct(garcons, total) + ')',
        '<strong>' + fmt(total) + '</strong>'
      ]);
    }
    return rows;
  }
  function buildPrimaireRows(s) {
    const rows = [];
    const niveaux = ["1ère Primaire", "2ème Primaire", "3ème Primaire", "4ème Primaire", "5ème Primaire", "6ème Primaire"];
    for (let i = 1; i <= 6; i++) {
      const total = s[i] || 0;
      const filles = s.filles[i] || 0;
      const garcons = s.garcons[i] || 0;
      rows.push([
        niveaux[i-1],
        fmt(filles) + ' (' + pct(filles, total) + ')',
        fmt(garcons) + ' (' + pct(garcons, total) + ')',
        '<strong>' + fmt(total) + '</strong>'
      ]);
    }
    return rows;
  }
  function buildCtebRows(s) {
    const rows = [];
    const niveaux = [7, 8];
    for (let n = 0; n < niveaux.length; n++) {
      const niv = niveaux[n];
      const total = s[niv] || 0;
      const filles = s.filles[niv] || 0;
      const garcons = s.garcons[niv] || 0;
      rows.push([
        niv + 'ème',
        fmt(filles) + ' (' + pct(filles, total) + ')',
        fmt(garcons) + ' (' + pct(garcons, total) + ')',
        '<strong>' + fmt(total) + '</strong>'
      ]);
    }
    return rows;
  }
  function buildCycleLongRows(s) {
    const rows = [];
    for (let niveau = 1; niveau <= 4; niveau++) {
      if (s[niveau] && Object.keys(s[niveau]).length > 0) {
        for (const code in s[niveau]) {
          if (!s[niveau].hasOwnProperty(code)) continue;
          const data = s[niveau][code];
          const total = data.total || 0;
          const filles = data.filles || 0;
          const garcons = data.garcons || 0;
          rows.push([
            niveau + "ère Humanité",
            escape(data.optionLibelle || code),
            code,
            fmt(filles) + ' (' + pct(filles, total) + ')',
            fmt(garcons) + ' (' + pct(garcons, total) + ')',
            '<strong>' + fmt(total) + '</strong>'
          ]);
        }
      }
    }
    if (rows.length === 0) rows.push(['—','—','—','0','0','<strong>0</strong>']);
    return rows;
  }
  function buildCycleCourtRows(s) {
    const rows = [];
    for (let niveau = 1; niveau <= 3; niveau++) {
      if (s[niveau] && Object.keys(s[niveau]).length > 0) {
        for (const code in s[niveau]) {
          if (!s[niveau].hasOwnProperty(code)) continue;
          const data = s[niveau][code];
          const total = data.total || 0;
          const filles = data.filles || 0;
          const garcons = data.garcons || 0;
          rows.push([
            niveau + "ère Humanité",
            escape(data.optionLibelle || code),
            code,
            fmt(filles) + ' (' + pct(filles, total) + ')',
            fmt(garcons) + ' (' + pct(garcons, total) + ')',
            '<strong>' + fmt(total) + '</strong>'
          ]);
        }
      }
    }
    if (rows.length === 0) rows.push(['—','—','—','0','0','<strong>0</strong>']);
    return rows;
  }
  function buildEcoleSummaryRows(stats) {
    const rows = [];
    for (const ecoleId in stats.ecoleStats) {
      if (!stats.ecoleStats.hasOwnProperty(ecoleId)) continue;
      const s = stats.ecoleStats[ecoleId];
      let cycleLabel = "Tous";
      if (s.cycle === "maternelle") cycleLabel = "Maternelle";
      else if (s.cycle === "primaire") cycleLabel = "Primaire";
      else if (s.cycle === "secondaire") cycleLabel = "Secondaire";
      rows.push([
        escape(s.nom),
        cycleLabel,
        fmt(s.classes),
        fmt(s.filles) + ' (' + pct(s.filles, s.eleves) + ')',
        fmt(s.garcons) + ' (' + pct(s.garcons, s.eleves) + ')',
        '<strong>' + fmt(s.eleves) + '</strong>'
      ]);
    }
    if (rows.length === 0) rows.push(['—','—','0','0','0','<strong>0</strong>']);
    return rows;
  }

  function buildReportTable(headers, rows, thStyle, tdStyle) {
    let html = '<table style="width:100%;border-collapse:collapse;margin-bottom:15px;font-size:12px;' + window.EKOLSTAT.PDF_TABLE_FIXED + '">';
    html += window.EKOLSTAT.pdfColgroup(headers);
    html += '<thead><tr>';
    for (let h = 0; h < headers.length; h++) html += '<th style="' + thStyle + '">' + headers[h] + '</th>';
    html += '</tr></thead><tbody>';
    for (let r = 0; r < rows.length; r++) {
      html += '<tr>';
      for (let c = 0; c < rows[r].length; c++) html += '<td style="' + tdStyle + '">' + rows[r][c] + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
    return html;
  }

  // ==================== EXPORT PDF (vrai PDF via html2pdf) ====================
  function buildPdfFilename() {
    const nomEntite = (currentProfile && currentProfile.nomEntite) ? currentProfile.nomEntite : "INSPECTEUR";
    const slug = String(nomEntite)
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase();
    const d = new Date();
    const pad = (n) => n < 10 ? "0" + n : "" + n;
    const date = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    return "RAPPORT_STATISTIQUE_" + slug + "_" + date;
  }

  function exportToPdf() {
    if (!window.html2pdf) {
      // Module PDF chargé à la demande (≈900 Ko) puis relance de l'export
      EKOLSTAT.withLib("html2pdf", function () { exportToPdf(); });
      return;
    }

    toast("Préparation du rapport PDF...", "info");

    const nomEntite = "Inspecteur itinérant : " + ((currentProfile && currentProfile.nomEntite) || "");
    const responsable = (currentProfile && currentProfile.nomEntite) || "Non spécifié";
    const now = new Date();
    const dateRapport = now.toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' });
    const yyyy = now.getFullYear();
    const serial = generateSerialNumber();

    const stats = getStats();
    const d = getStatsDetaillees();

    const wrapper = document.createElement("div");
    wrapper.style.cssText = "font-family:'Satoshi','Urbanist',Arial,sans-serif;padding:20px;box-sizing:border-box;color:#111827;background:white;width:1040px;";

    const thStyle = 'border:1px solid #e5e7eb;padding:6px 8px;background:#f3f4f6;text-align:left;';
    const tdStyle = 'border:1px solid #e5e7eb;padding:6px 8px;text-align:left;';
    const sectionStyle = 'font-size:14px;font-weight:bold;background:#eef5fe;padding:6px 10px;border-left:4px solid #1762cb;margin:20px 0 10px;';

    let html = "";

    // En-tête officiel
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;padding-bottom:14px;border-bottom:2px solid #1762cb;">';
    html += '  <img src="../img/logo min backless.png" alt="RDC Ministère" style="height:120px;object-fit:contain;" />';
    html += '  <div style="text-align:center;flex:1;padding:0 20px;">';
    html += '    <div style="font-size:11px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:0.5px;">REPUBLIQUE DEMOCRATIQUE DU CONGO</div>';
    html += '    <div style="font-size:10px;color:#374151;margin-top:2px;">MINISTERE DE L\'EDUCATION NATIONALE ET NOUVELLE CITOYENNETE</div>';
    html += '    <div style="font-size:14px;font-weight:bold;color:#124ea3;margin-top:6px;">' + escape(nomEntite).toUpperCase() + '</div>';
    html += '    <div style="font-size:12px;font-weight:600;color:#1762cb;margin-top:4px;">RAPPORT STATISTIQUE DES BULLETINS SCOLAIRES ' + yyyy + '-' + (yyyy + 1) + '</div>';
    html += '  </div>';
    html += '  <div style="width:80px;"></div>';
    html += '</div>';

    // Synthèse globale
    html += '<div style="' + sectionStyle + '">1. SYNTHÈSE GLOBALE</div>';
    html += '<table style="width:100%;border-collapse:collapse;margin-bottom:15px;font-size:12px;">';
    html += '<thead><tr>';
    html += '<th style="' + thStyle + '">Indicateur</th><th style="' + thStyle + '">Valeur</th>';
    html += '</tr></thead><tbody>';
    html += '<tr><td style="' + tdStyle + '">Écoles</td><td style="' + tdStyle + '">' + fmt(stats.totalEcoles) + '</td></tr>';
    html += '<tr><td style="' + tdStyle + '">Classes</td><td style="' + tdStyle + '">' + fmt(stats.totalClasses) + '</td></tr>';
    html += '<tr><td style="' + tdStyle + '">Total élèves</td><td style="' + tdStyle + '"><strong>' + fmt(stats.totalEleves) + '</strong></td></tr>';
    html += '<tr><td style="' + tdStyle + '">Filles</td><td style="' + tdStyle + '">' + fmt(stats.totalFilles) + ' (' + pct(stats.totalFilles, stats.totalEleves) + ')</td></tr>';
    html += '<tr><td style="' + tdStyle + '">Garçons</td><td style="' + tdStyle + '">' + fmt(stats.totalGarcons) + ' (' + pct(stats.totalGarcons, stats.totalEleves) + ')</td></tr>';
    html += '<tr><td style="' + tdStyle + '">Élèves vivant avec un handicap</td><td style="' + tdStyle + '">' + fmt(stats.totalHandicap) + ' (' + pct(stats.totalHandicap, stats.totalEleves) + ')</td></tr>';
    html += '</tbody></table>';

    html += '<div style="' + sectionStyle + '">2. CYCLE MATERNELLE</div>';
    html += buildReportTable(['Classe','Filles','Garçons','<strong>Total</strong>'], buildMaternelleRows(d.statsMaternelle), thStyle, tdStyle);

    html += '<div style="' + sectionStyle + '">3. CYCLE PRIMAIRE</div>';
    html += buildReportTable(['Classe','Filles','Garçons','<strong>Total</strong>'], buildPrimaireRows(d.statsPrimaire), thStyle, tdStyle);

    html += '<div style="' + sectionStyle + '">4. CTEB (7ème & 8ème)</div>';
    html += buildReportTable(['Classe','Filles','Garçons','<strong>Total</strong>'], buildCtebRows(d.statsCTEB), thStyle, tdStyle);

    html += '<div style="' + sectionStyle + '">5. CYCLE LONG</div>';
    html += buildReportTable(['Niveau','Option','Code','Filles','Garçons','<strong>Total</strong>'], buildCycleLongRows(d.statsCycleLong), thStyle, tdStyle);

    html += '<div style="' + sectionStyle + '">6. CYCLE COURT</div>';
    html += buildReportTable(['Niveau','Option','Code','Filles','Garçons','<strong>Total</strong>'], buildCycleCourtRows(d.statsCycleCourt), thStyle, tdStyle);

    html += '<div style="' + sectionStyle + '">7. SYNTHÈSE PAR ÉCOLE</div>';
    html += buildReportTable(
      ['École','Cycle','Classes','Filles','Garçons','<strong>Total</strong>'],
      buildEcoleSummaryRows(stats),
      thStyle, tdStyle
    );

    // Pied de page officiel
    html += '<div style="margin-top:30px;padding-top:15px;border-top:2px solid #1762cb;display:flex;justify-content:space-between;align-items:flex-end;">';
    html += '  <div style="width:280px;text-align:center;">';
    html += '    <div style="font-size:11px;">Fait à Kinshasa, le ' + dateRapport + '</div>';
    html += '    <div style="margin-top:50px;border-top:1px solid #000;width:100%;"></div>';
    html += '    <div style="margin-top:6px;font-size:11px;">L\'Inspecteur itinérant</div>';
    html += '    <div style="font-size:12px;font-weight:bold;">' + escape(responsable) + '</div>';
    html += '  </div>';
    html += '  <div style="text-align:center;font-size:9px;color:#6b7280;">';
    html += '    <div>' + serial + '</div>';
    html += '  </div>';
    html += '  <div style="width:140px;height:90px;border:1px dashed #9ca3af;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:10px;">Sceau / Cachet</div>';
    html += '</div>';

    wrapper.innerHTML = html;

    const filename = buildPdfFilename() + ".pdf";

    const opt = {
      margin:       [10, 10, 10, 10],
      filename:     filename,
      image:        { type: 'jpeg', quality: 0.98 },
      html2canvas:  { scale: 2, useCORS: true, logging: false },
      jsPDF:        { unit: 'mm', format: 'a4', orientation: 'landscape' },
      pagebreak:    { mode: ['avoid-all', 'css', 'legacy'] }
    };

    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none;z-index:-9999;";
    wrapper.style.position = "relative";
    wrapper.style.left = "0";
    wrapper.style.top = "0";
    host.appendChild(wrapper);
    document.body.appendChild(host);

    setTimeout(() => {
      window.html2pdf().set(opt).from(wrapper).save().then(() => {
        if (host.parentNode) document.body.removeChild(host);
        toast("Rapport PDF généré : " + filename, "success");
      }).catch((err) => {
        if (host.parentNode) document.body.removeChild(host);
        console.error(err);
        toast("Erreur lors de la génération du PDF", "error");
      });
    }, 100);
  }

  // ==================== CHART ====================
  function renderEvolutionChart() {
    const ctx = document.getElementById("chart-evolution");
    if (!ctx || !window.Chart) return;

    if (evolutionChart) evolutionChart.destroy();

    const labels = [];
    const data = [];
    const now = new Date();

    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      labels.push(d.toLocaleDateString("fr-FR", { month: "short", year: "2-digit" }));
      data.push(0);
    }

    for (const id in classes) {
      if (!classes.hasOwnProperty(id)) continue;
      const classe = classes[id];
      if (classe.statut === "supprime") continue;
      const eff = effectifs[id];
      if (!eff) continue;
      const last = eff.lastUpdate || 0;
      if (!last) continue;
      const total = (eff.nb_filles || 0) + (eff.nb_garcons || 0);
      const dEff = new Date(last);
      for (let i = 0; i < 12; i++) {
        const monthDate = new Date(now.getFullYear(), now.getMonth() - (11 - i), 1);
        if (dEff.getFullYear() === monthDate.getFullYear() && dEff.getMonth() === monthDate.getMonth()) {
          data[i] += total;
          break;
        }
      }
    }

    evolutionChart = new Chart(ctx, {
      type: "line",
      data: {
        labels: labels,
        datasets: [{
          label: "Effectifs",
          data: data,
          borderColor: "#1762cb",
          backgroundColor: "rgba(23,98,203, 0.1)",
          fill: true,
          tension: 0.3,
          pointRadius: 4,
          pointBackgroundColor: "#1762cb"
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
        scales: { y: { beginAtZero: true, title: { display: true, text: "Nombre d'élèves" } } }
      }
    });
  }

  // ==================== HELPERS ====================
  function escape(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function confirmDialog(title, message) {
    return new Promise((resolve) => {
      const modal = document.getElementById("modal-confirm");
      if (!modal) { resolve(false); return; }

      const confirmTitle = document.getElementById("confirm-title");
      const confirmMessage = document.getElementById("confirm-message");
      const okBtn = document.getElementById("confirm-ok");

      if (confirmTitle) confirmTitle.innerHTML = '<i class="fas fa-circle-question"></i> ' + escape(title);
      if (confirmMessage) confirmMessage.textContent = message;

      const onOk = function() { cleanup(); resolve(true); };
      const onCancel = function() { cleanup(); resolve(false); };

      function cleanup() {
        modal.classList.remove("show");
        if (okBtn) okBtn.removeEventListener("click", onOk);
        const closeButtons = modal.querySelectorAll("[data-close-modal]");
        closeButtons.forEach(btn => btn.removeEventListener("click", onCancel));
      }

      if (okBtn) okBtn.addEventListener("click", onOk);
      const closeButtons = modal.querySelectorAll("[data-close-modal]");
      closeButtons.forEach(btn => btn.addEventListener("click", onCancel));
      modal.classList.add("show");
    });
  }

  function toast(msg, type) {
    const toastEl = document.getElementById("toast");
    const toastMsg = document.getElementById("toast-msg");
    if (!toastEl) return;
    if (toastMsg) toastMsg.textContent = msg;
    toastEl.className = "toast " + (type || "info");
    toastEl.classList.remove("hidden");
    setTimeout(() => toastEl.classList.add("hidden"), 3000);
  }
})();
