/* ============================================================
   EKOLSTAT — Tableau de bord Pool - Version 3.0
   Responsabilités : création des comptes des Inspecteurs itinérants,
   suivi des écoles collectées sur le terrain par ces inspecteurs.
   ============================================================ */

(function() {
  const auth = firebase.auth();
  const db = firebase.database();

  let currentUser = null;
  let currentProfile = null;
  let currentPoolId = null;
  let currentIppId = null;

  // État global
  let inspecteurs = {};
  let ecoles = {};
  let classes = {};
  let effectifs = {};

  // Graphique
  let evolutionChart = null;

  // Application Firebase secondaire (pour créer des comptes sans déconnecter le Pool)
  let secondaryApp = null;
  function getSecondaryAuth() {
    if (!secondaryApp) {
      try {
        secondaryApp = firebase.initializeApp(firebase.app().options, "ekolstat-create-inspecteur");
      } catch (e) {
        secondaryApp = firebase.app("ekolstat-create-inspecteur");
      }
    }
    return secondaryApp.auth();
  }

  const fmt = (n) => n ? n.toLocaleString("fr-FR") : "0";
  const pct = (num, den) => den ? ((num / den) * 100).toFixed(1).replace(".", ",") + "%" : "0%";

  // Génération de mot de passe sécurisé
  function generatePassword(len = 10) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    let out = "";
    const arr = new Uint32Array(len);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(arr);
    } else {
      for (let i = 0; i < len; i++) arr[i] = Math.floor(Math.random() * 1e9);
    }
    for (let i = 0; i < len; i++) out += chars[arr[i] % chars.length];
    return out;
  }

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
    if (currentProfile.role !== "pool" && currentProfile.role !== "sous-division") {
      toast("Accès non autorisé", "error");
      await auth.signOut();
      setTimeout(() => window.location.href = "../login.html", 1200);
      return;
    }

    currentUser = user;
    currentPoolId = currentProfile.entiteId || currentProfile.poolId || user.uid;
    currentIppId = currentProfile.ippId || "";

    document.getElementById("user-name").textContent = currentProfile.nomEntite || "Pool";
    document.getElementById("user-role").textContent = "Pool";

    init();
  });

  // ==================== INITIALISATION ====================
  function init() {
    bindEvents();
    loadData();
  }

  function loadData() {
    // Inspecteurs itinérants créés par ce Pool
    db.ref("inspecteurs").orderByChild("poolId").equalTo(currentPoolId).on("value", (snap) => {
      inspecteurs = snap.val() || {};
      _sched.mark("inspecteurs");
      renderAll();
    });

    // Écoles créées par les inspecteurs de ce Pool
    db.ref("ecoles").orderByChild("poolId").equalTo(currentPoolId).on("value", (snap) => {
      ecoles = snap.val() || {};
      _sched.mark("ecoles");
      renderAll();
    });

    // Classes (filtre par poolId)
    db.ref("classes").orderByChild("poolId").equalTo(currentPoolId).on("value", (snap) => {
      classes = snap.val() || {};
      _sched.mark("classes");
      effWatch.sync(Object.keys(classes));
      renderAll();
    });
  }

  function bindEvents() {
    // Déconnexion
    const logoutLink = document.getElementById("logout-link");
    if (logoutLink) logoutLink.addEventListener("click", () => auth.signOut());

    // Rafraîchir
    const refreshBtn = document.getElementById("refresh-btn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => {
        renderAll();
        toast("Données rafraîchies", "success");
      });
    }

    // Recherche
    const globalSearch = document.getElementById("global-search");
    if (globalSearch) {
      globalSearch.addEventListener("input", function(e) {
        const q = e.target.value.toLowerCase().trim();
        const rows = document.querySelectorAll("#ecole-summary-container tbody tr, #ecole-management-container tbody tr, #inspecteur-management-container tbody tr");
        rows.forEach(function(r) {
          if (!q) { r.style.display = ""; return; }
          r.style.display = r.textContent.toLowerCase().includes(q) ? "" : "none";
        });
      });
    }

    // Navigation
    document.querySelectorAll(".nav-link[data-view]").forEach(link => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const view = link.getAttribute("data-view");

        document.querySelectorAll(".nav-link").forEach(l => l.classList.remove("active"));
        link.classList.add("active");

        document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
        const viewEl = document.getElementById("view-" + view);
        if (viewEl) viewEl.classList.add("active");

        const titles = {
          "overview": "Vue d'ensemble",
          "inspecteurs": "Inspecteurs itinérants",
          "ecoles": "Écoles collectées",
          "reports": "Rapports"
        };
        const pageTitle = document.getElementById("page-title");
        if (pageTitle) pageTitle.textContent = titles[view] || view;

        if (view === "overview") renderEvolutionChart();

        // Fermer le drawer mobile après navigation
        const sb = document.getElementById("sidebar");
        const ov = document.getElementById("sidebar-overlay");
        if (sb) sb.classList.remove("open");
        if (ov) ov.classList.remove("show");
      });
    });

    // Modal Inspecteur itinérant
    const btnNewInsp = document.getElementById("btn-new-inspecteur");
    const formInsp = document.getElementById("form-inspecteur");
    const genPassInsp = document.getElementById("gen-pass-inspecteur");
    if (btnNewInsp) btnNewInsp.addEventListener("click", () => openInspecteurModal());
    const btnImportInsp = document.getElementById("btn-import-inspecteur");
    if (btnImportInsp) btnImportInsp.addEventListener("click", openInspecteurImport);
    if (formInsp) formInsp.addEventListener("submit", saveInspecteur);
    if (genPassInsp) {
      genPassInsp.addEventListener("click", function() {
        const passInput = document.getElementById("inspecteur-password");
        if (passInput) passInput.value = generatePassword(10);
      });
    }

    const btnReassign = document.getElementById("btn-reassign-save");
    if (btnReassign) btnReassign.addEventListener("click", saveReassign);

    // Filtre des écoles par inspecteur
    const filterInsp = document.getElementById("filter-inspecteur");
    if (filterInsp) filterInsp.addEventListener("change", () => renderEcolesCollectees(getStats()));

    // Export PDF
    const btnExportPdf = document.getElementById("btn-export-pdf");
    if (btnExportPdf) btnExportPdf.addEventListener("click", exportToPdf);

    // Fermeture des modals
    document.querySelectorAll("[data-close-modal]").forEach(btn => {
      btn.addEventListener("click", () => {
        const modal = btn.closest(".modal");
        if (modal) modal.classList.remove("show");
      });
    });

    // ==================== HAMBURGER (responsive, tous écrans) ====================
    const sidebar = document.getElementById("sidebar");
    const overlay = document.getElementById("sidebar-overlay");
    const burger = document.getElementById("hamburger-btn");

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
      overlay.addEventListener("click", () => {
        sidebar.classList.remove("open");
        overlay.classList.remove("show");
      });
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
      totalInspecteurs: 0,
      totalEcoles: 0,
      ecolesPubliques: 0,
      ecolesPrivees: 0,
      totalClasses: 0,
      totalEleves: 0,
      totalFilles: 0,
      totalGarcons: 0,
      totalHandicap: 0,
      ecoleStats: {},
      inspStats: {}
    };

    // Inspecteurs actifs
    for (const inspId in inspecteurs) {
      if (!inspecteurs.hasOwnProperty(inspId)) continue;
      const insp = inspecteurs[inspId];
      if (insp.statut === "supprime") continue;
      stats.totalInspecteurs++;
      stats.inspStats[inspId] = {
        nom: insp.nom, code: insp.code || "", email: insp.email || "",
        statut: insp.statut || "actif",
        ecoles: 0, classes: 0, eleves: 0, filles: 0, garcons: 0
      };
    }

    // Écoles
    for (const ecoleId in ecoles) {
      if (!ecoles.hasOwnProperty(ecoleId)) continue;
      const ecole = ecoles[ecoleId];
      if (ecole.statut === "supprime") continue;
      stats.totalEcoles++;
      if (ecole.categorie === "publique") stats.ecolesPubliques++;
      else if (ecole.categorie === "privee") stats.ecolesPrivees++;
      const insp = inspecteurs[ecole.inspecteurId];
      stats.ecoleStats[ecoleId] = {
        nom: ecole.nom,
        code: ecole.code || "",
        responsable: ecole.responsable || "",
        cycle: ecole.cycle || "",
        categorie: ecole.categorie || "",
        statut: ecole.statut || "actif",
        inspecteurId: ecole.inspecteurId || "",
        inspecteurNom: (insp && insp.nom) || ecole.inspecteurNom || "—",
        classes: 0, eleves: 0, filles: 0, garcons: 0, handicap: 0
      };
      if (stats.inspStats[ecole.inspecteurId]) stats.inspStats[ecole.inspecteurId].ecoles++;
    }

    // Classes + effectifs
    for (const id in classes) {
      if (!classes.hasOwnProperty(id)) continue;
      const classe = classes[id];
      if (classe.statut === "supprime") continue;

      const eff = effectifs[id] || { nb_filles:0, nb_garcons:0 };
      const f = eff.nb_filles || 0;
      const g = eff.nb_garcons || 0;
      const total = f + g;

      stats.totalClasses++;
      stats.totalEleves += total;
      stats.totalFilles += f;
      stats.totalGarcons += g;
      const h = eff.nb_handicap || 0;
      stats.totalHandicap += h;

      if (classe.ecoleId && stats.ecoleStats[classe.ecoleId]) {
        const es = stats.ecoleStats[classe.ecoleId];
        es.handicap += h;
        es.classes++; es.eleves += total; es.filles += f; es.garcons += g;
      }
      if (classe.inspecteurId && stats.inspStats[classe.inspecteurId]) {
        const is = stats.inspStats[classe.inspecteurId];
        is.classes++; is.eleves += total; is.filles += f; is.garcons += g;
      }
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
  var _sched = EKOLSTAT.createRenderScheduler(function () { renderAllNow(); }, ["inspecteurs", "ecoles", "classes", "effectifs"]);
  function renderAll() { _sched.render(); }

  // Effectifs : uniquement ceux des classes du périmètre (avant : tout le pays)
  var effWatch = EKOLSTAT.watchEffectifs(db,
    function (data) { effectifs = data; renderAll(); },
    function () { _sched.mark("effectifs"); });

  function renderAllNow() {
    const stats = getStats();
    renderKPIs(stats);
    renderEcoleSummaryTable(stats);
    renderInspecteursTable(stats);
    renderEcolesCollectees(stats);
    renderReports(stats);
    if (window.Chart) renderEvolutionChart();
  }

  function renderKPIs(stats) {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = fmt(val); };
    set("total-ecoles", stats.totalEcoles);
    set("total-inspecteurs", stats.totalInspecteurs);
    set("total-handicap", stats.totalHandicap);
    set("total-classes", stats.totalClasses);
    set("total-eleves", stats.totalEleves);
    set("total-filles", stats.totalFilles);
    set("total-garcons", stats.totalGarcons);
    set("ecoles-publiques", stats.ecolesPubliques);
    set("ecoles-privees", stats.ecolesPrivees);
  }

  function renderEcoleSummaryTable(stats) {
    const container = document.getElementById("ecole-summary-container");
    if (!container) return;

    if (Object.keys(stats.ecoleStats).length === 0) {
      container.innerHTML = '<div class="empty">Aucune école collectée pour le moment. Elles apparaissent ici dès qu\'un inspecteur itinérant en confirme une.</div>';
      return;
    }

    let html = '<table class="data-table">';
    html += '<thead><tr>';
    html += '<th>École</th>';
    html += '<th>Inspecteur</th>';
    html += '<th>Type</th>';
    html += '<th>Classes</th>';
    html += '<th>Filles</th>';
    html += '<th>Garçons</th>';
    html += '<th><strong>Total élèves</strong></th>';
    html += '</tr></thead><tbody>';

    for (const ecoleId in stats.ecoleStats) {
      if (!stats.ecoleStats.hasOwnProperty(ecoleId)) continue;
      const s = stats.ecoleStats[ecoleId];
      let cycleLabel = "Tous";
      if (s.cycle === "maternelle") cycleLabel = "Maternelle";
      else if (s.cycle === "primaire") cycleLabel = "Primaire";
      else if (s.cycle === "secondaire") cycleLabel = "Secondaire";

      html += '<tr>';
      html += '<td><strong>' + escape(s.nom) + '</strong></td>';
      html += '<td>' + escape(s.inspecteurNom) + '</td>';
      html += '<td>' + cycleLabel + '</td>';
      html += '<td>' + fmt(s.classes) + '</td>';
      html += '<td>' + fmt(s.filles) + ' (' + pct(s.filles, s.eleves) + ')</td>';
      html += '<td>' + fmt(s.garcons) + ' (' + pct(s.garcons, s.eleves) + ')</td>';
      html += '<td><strong>' + fmt(s.eleves) + '</strong></td>';
      html += '</tr>';
    }

    html += '</tbody></table>';
    container.innerHTML = html;
  }

  function cycleLabelOf(c) {
    return c === "maternelle" ? "Maternelle" : c === "primaire" ? "Primaire" : c === "secondaire" ? "Secondaire" : "—";
  }

  // ---- Vue « Inspecteurs itinérants » (gestion des comptes) ----
  function renderInspecteursTable(stats) {
    const container = document.getElementById("inspecteur-management-container");
    if (!container) return;

    const ids = Object.keys(inspecteurs).filter(id => inspecteurs[id].statut !== "supprime");
    if (ids.length === 0) {
      container.innerHTML = '<div class="empty">Aucun inspecteur itinérant. Cliquez sur "Nouvel inspecteur" pour commencer.</div>';
      return;
    }

    let html = '<table class="data-table"><thead><tr>';
    html += '<th>Nom</th><th>Code</th><th>Email</th><th>Téléphone</th><th>Écoles</th><th>Élèves</th><th>Statut</th><th>Actions</th>';
    html += '</tr></thead><tbody>';

    ids.forEach(function(id) {
      const insp = inspecteurs[id];
      const s = stats.inspStats[id] || { ecoles: 0, eleves: 0 };
      const inactif = insp.statut === "inactif";
      html += '<tr>';
      html += '<td><strong>' + escape(insp.nom) + '</strong></td>';
      html += '<td>' + escape(insp.code || "-") + '</td>';
      html += '<td>' + escape(insp.email || "-") + '</td>';
      html += '<td>' + escape(insp.telephone || "-") + '</td>';
      html += '<td>' + fmt(s.ecoles) + '</td>';
      html += '<td>' + fmt(s.eleves) + '</td>';
      html += '<td><span class="badge ' + (inactif ? "badge-muted" : "badge-success") + '">' + (inactif ? "Inactif" : "Actif") + '</span></td>';
      html += '<td><div class="row-actions">';
      html += '<button class="icon-btn" onclick="editInspecteur(\'' + id + '\')" title="Modifier"><i class="fas fa-edit"></i></button>';
      html += '<button class="icon-btn" onclick="resetInspecteurPassword(\'' + escape(insp.email || "") + '\')" title="Réinitialiser MDP"><i class="fas fa-key"></i></button>';
      html += '<button class="icon-btn ' + (inactif ? "" : "warning") + '" onclick="toggleInspecteur(\'' + id + '\', \'' + (insp.statut || "actif") + '\')" title="' + (inactif ? "Réactiver" : "Désactiver") + '"><i class="fas ' + (inactif ? "fa-circle-play" : "fa-circle-pause") + '"></i></button>';
      html += '<button class="icon-btn danger" onclick="deleteInspecteur(\'' + id + '\', \'' + escape(insp.nom) + '\')" title="Supprimer"><i class="fas fa-trash"></i></button>';
      html += '</div></td></tr>';
    });

    html += '</tbody></table>';
    container.innerHTML = html;
  }

  // ---- Vue « Écoles collectées » (lecture seule) ----
  function renderEcolesCollectees(stats) {
    const container = document.getElementById("ecole-management-container");
    const filter = document.getElementById("filter-inspecteur");
    if (!container) return;

    // Remplir le filtre sans perdre la sélection courante
    if (filter) {
      const current = filter.value;
      let opts = '<option value="">Tous les inspecteurs</option>';
      Object.keys(stats.inspStats).forEach(function(id) {
        opts += '<option value="' + id + '">' + escape(stats.inspStats[id].nom) + '</option>';
      });
      filter.innerHTML = opts;
      filter.value = stats.inspStats[current] ? current : "";
    }
    const filterId = filter ? filter.value : "";

    const ids = Object.keys(stats.ecoleStats).filter(id => !filterId || stats.ecoleStats[id].inspecteurId === filterId);
    if (ids.length === 0) {
      container.innerHTML = '<div class="empty">Aucune école collectée.</div>';
      return;
    }

    let html = '<table class="data-table"><thead><tr>';
    html += '<th>École</th><th>Type</th><th>Régime</th><th>Inspecteur</th><th>Classes</th><th>Filles</th><th>Garçons</th><th><strong>Total</strong></th><th>Handicap</th><th>Actions</th>';
    html += '</tr></thead><tbody>';
    ids.forEach(function(id) {
      const e = stats.ecoleStats[id];
      html += '<tr>';
      html += '<td><strong>' + escape(e.nom) + '</strong></td>';
      html += '<td>' + cycleLabelOf(e.cycle) + '</td>';
      html += '<td>' + (e.categorie === "publique" ? "Publique" : e.categorie === "privee" ? "Privée" : "—") + '</td>';
      html += '<td>' + escape(e.inspecteurNom) + '</td>';
      html += '<td>' + fmt(e.classes) + '</td>';
      html += '<td>' + fmt(e.filles) + '</td>';
      html += '<td>' + fmt(e.garcons) + '</td>';
      html += '<td><strong>' + fmt(e.eleves) + '</strong></td>';
      html += '<td>' + fmt(e.handicap) + '</td>';
      html += '<td><div class="row-actions">';
      html += '<button class="icon-btn" onclick="showEcoleDetail(\'' + id + '\')" title="Voir les classes"><i class="fas fa-eye"></i></button>';
      html += '<button class="icon-btn" onclick="openReassign(\'' + id + '\')" title="Réassigner à un autre inspecteur"><i class="fas fa-right-left"></i></button>';
      html += '<button class="icon-btn danger" onclick="deleteEcolePool(\'' + id + '\', \'' + escape(e.nom) + '\')" title="Supprimer l\'école"><i class="fas fa-trash"></i></button>';
      html += '</div></td>';
      html += '</tr>';
    });
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  function showEcoleDetail(ecoleId) {
    const e = ecoles[ecoleId];
    const modal = document.getElementById("modal-ecole-detail");
    if (!e || !modal) return;
    document.getElementById("ecole-detail-title").innerHTML = '<i class="fas fa-school"></i> ' + escape(e.nom);

    const rows = Object.keys(classes)
      .filter(id => classes[id].ecoleId === ecoleId && classes[id].statut !== "supprime")
      .map(id => ({ c: classes[id], eff: effectifs[id] || {} }))
      .sort((x, y) => (x.c.sousCycle || "").localeCompare(y.c.sousCycle || "") || (x.c.niveau || 0) - (y.c.niveau || 0));

    let html = '<p style="margin:0 0 10px">' + cycleLabelOf(e.cycle) + ' · ' + (e.categorie === "publique" ? "Publique" : "Privée");
    if (e.responsable) html += ' · Responsable : ' + escape(e.responsable);
    html += '</p>';
    html += '<table class="data-table"><thead><tr><th>Classe</th><th>Option</th><th>Filles</th><th>Garçons</th><th>Total</th><th>Handicap</th></tr></thead><tbody>';
    if (!rows.length) html += '<tr><td colspan="6">Aucune classe.</td></tr>';
    rows.forEach(function(r) {
      const f = r.eff.nb_filles || 0, g = r.eff.nb_garcons || 0;
      html += '<tr><td>' + escape(r.c.nom) + '</td><td>' + escape(r.c.optionLibelle || "—") + '</td><td>' + fmt(f) + '</td><td>' + fmt(g) + '</td><td><strong>' + fmt(f + g) + '</strong></td><td>' + fmt(r.eff.nb_handicap || 0) + '</td></tr>';
    });
    html += '</tbody></table>';
    document.getElementById("ecole-detail-body").innerHTML = html;
    modal.classList.add("show");
  }
  window.showEcoleDetail = showEcoleDetail;

  // ---- Réassigner une école à un autre inspecteur ----
  let reassignEcoleId = null;
  function openReassign(ecoleId) {
    const e = ecoles[ecoleId];
    if (!e) return;
    const targets = Object.keys(inspecteurs).filter(id => id !== e.inspecteurId && (inspecteurs[id].statut || "actif") === "actif");
    if (!targets.length) { toast("Aucun autre inspecteur actif dans ce pool.", "error"); return; }
    reassignEcoleId = ecoleId;
    const cur = inspecteurs[e.inspecteurId];
    document.getElementById("reassign-info").innerHTML =
      'École : <strong>' + escape(e.nom) + '</strong><br>Inspecteur actuel : <strong>' + escape((cur && cur.nom) || e.inspecteurNom || "—") + '</strong>';
    let opts = '<option value="">Sélectionner le nouvel inspecteur</option>';
    targets.forEach(id => { opts += '<option value="' + id + '">' + escape(inspecteurs[id].nom) + '</option>'; });
    document.getElementById("reassign-select").innerHTML = opts;
    document.getElementById("modal-reassign").classList.add("show");
  }

  async function saveReassign() {
    const target = document.getElementById("reassign-select").value;
    const insp = inspecteurs[target];
    if (!reassignEcoleId || !insp) { toast("Choisissez le nouvel inspecteur.", "error"); return; }
    try {
      const u = {};
      u["ecoles/" + reassignEcoleId + "/inspecteurId"] = target;
      u["ecoles/" + reassignEcoleId + "/inspecteurNom"] = insp.nom;
      u["ecoles/" + reassignEcoleId + "/reassigneLe"] = firebase.database.ServerValue.TIMESTAMP;
      Object.keys(classes).forEach(function(cid) {
        if (classes[cid].ecoleId === reassignEcoleId) u["classes/" + cid + "/inspecteurId"] = target;
      });
      await db.ref().update(u);
      document.getElementById("modal-reassign").classList.remove("show");
      toast("École réassignée à " + insp.nom, "success");
    } catch (err) {
      toast("Erreur : " + err.message, "error");
    }
  }

  // ---- Suppression d'une école : réservée au Pool ----
  async function deleteEcolePool(id, nom) {
    const ok = await confirmDialog(
      "⚠️ Supprimer cette école ?",
      'L\'école "' + nom + '" et toutes ses classes seront retirées des statistiques (Pool, IPP, IGE). Action IRRÉVERSIBLE.'
    );
    if (!ok) return;
    try {
      const u = {};
      u["ecoles/" + id + "/statut"] = "supprime";
      Object.keys(classes).forEach(function(cid) {
        if (classes[cid].ecoleId === id) u["classes/" + cid + "/statut"] = "supprime";
      });
      await db.ref().update(u);
      toast('École "' + nom + '" supprimée', "success");
    } catch (err) {
      toast("Erreur : " + err.message, "error");
    }
  }
  window.openReassign = openReassign;
  window.deleteEcolePool = deleteEcolePool;

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

    // Synthèse par Inspecteur itinérant
    html += '<div style="margin-bottom:25px;"><h3 style="' + sectionStyle + '">Synthèse par Inspecteur itinérant</h3>';
    html += buildReportTable(
      ['Inspecteur','Écoles','Classes','Filles','Garçons','<strong>Total</strong>'],
      buildInspecteurSummaryRows(stats),
      thStyle, tdStyle
    );
    html += '</div>';

    container.innerHTML = html;
  }

  // ---- Helpers de construction de lignes (UI + PDF) ----
  function buildInspecteurSummaryRows(stats) {
    const rows = [];
    for (const id in stats.inspStats) {
      if (!stats.inspStats.hasOwnProperty(id)) continue;
      const s = stats.inspStats[id];
      rows.push([
        escape(s.nom),
        fmt(s.ecoles),
        fmt(s.classes),
        fmt(s.filles) + ' (' + pct(s.filles, s.eleves) + ')',
        fmt(s.garcons) + ' (' + pct(s.garcons, s.eleves) + ')',
        '<strong>' + fmt(s.eleves) + '</strong>'
      ]);
    }
    if (rows.length === 0) rows.push(['—','0','0','0','0','<strong>0</strong>']);
    return rows;
  }
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
    const nomEntite = (currentProfile && currentProfile.nomEntite) ? currentProfile.nomEntite : "POOL";
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

    const nomEntite = (currentProfile && currentProfile.nomEntite) || "Pool";
    const responsable = (currentProfile && currentProfile.responsable) || "Non spécifié";
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
    html += '<tr><td style="' + tdStyle + '">Inspecteurs itinérants</td><td style="' + tdStyle + '">' + fmt(stats.totalInspecteurs) + '</td></tr>';
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

    html += '<div style="' + sectionStyle + '">8. SYNTHÈSE PAR INSPECTEUR ITINÉRANT</div>';
    html += buildReportTable(
      ['Inspecteur','Écoles','Classes','Filles','Garçons','<strong>Total</strong>'],
      buildInspecteurSummaryRows(stats),
      thStyle, tdStyle
    );

    // Pied de page officiel
    html += '<div style="margin-top:30px;padding-top:15px;border-top:2px solid #1762cb;display:flex;justify-content:space-between;align-items:flex-end;">';
    html += '  <div style="width:280px;text-align:center;">';
    html += '    <div style="font-size:11px;">Fait à Kinshasa, le ' + dateRapport + '</div>';
    html += '    <div style="margin-top:50px;border-top:1px solid #000;width:100%;"></div>';
    html += '    <div style="margin-top:6px;font-size:11px;">Le Chef de Pool</div>';
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

  // ==================== INSPECTEUR ITINÉRANT CRUD ====================
  function openInspecteurModal(id = null) {
    const modal = document.getElementById("modal-inspecteur");
    if (!modal) return;

    const $ = (x) => document.getElementById(x);
    const passwordField = $("field-password");

    if (id && inspecteurs[id]) {
      const i = inspecteurs[id];
      $("inspecteur-id").value = id;
      $("inspecteur-nom").value = i.nom || "";
      $("inspecteur-code").value = i.code || "";
      $("inspecteur-telephone").value = i.telephone || "";
      $("inspecteur-email").value = i.email || "";
      $("inspecteur-email").disabled = true;
      if (passwordField) passwordField.style.display = "none";
      $("modal-inspecteur-title").innerHTML = '<i class="fas fa-edit"></i> Modifier l\'inspecteur';
    } else {
      $("inspecteur-id").value = "";
      $("inspecteur-nom").value = "";
      $("inspecteur-code").value = "";
      $("inspecteur-telephone").value = "";
      $("inspecteur-email").value = "";
      $("inspecteur-email").disabled = false;
      $("inspecteur-password").value = generatePassword(10);
      if (passwordField) passwordField.style.display = "";
      $("modal-inspecteur-title").innerHTML = '<i class="fas fa-plus-circle"></i> Nouvel inspecteur itinérant';
    }

    modal.classList.add("show");
    $("inspecteur-nom").focus();
  }

  async function saveInspecteur(e) {
    e.preventDefault();

    const id = document.getElementById("inspecteur-id").value;
    const nom = document.getElementById("inspecteur-nom").value.trim();
    const code = document.getElementById("inspecteur-code").value.trim();
    const telephone = document.getElementById("inspecteur-telephone").value.trim();
    const email = document.getElementById("inspecteur-email").value.trim();
    const password = document.getElementById("inspecteur-password").value;

    if (!nom || !email) {
      toast("Le nom et l'email sont obligatoires", "error");
      return;
    }

    try {
      if (id) {
        await db.ref("inspecteurs/" + id).update({
          nom: nom, code: code, telephone: telephone,
          updatedAt: firebase.database.ServerValue.TIMESTAMP
        });
        await db.ref("utilisateurs/" + id).update({
          nomEntite: nom, code: code, telephone: telephone
        });
        toast("Inspecteur mis à jour", "success");
      } else {
        if (!password || password.length < 6) {
          toast("Le mot de passe doit contenir au moins 6 caractères", "error");
          return;
        }
        const secAuth = getSecondaryAuth();
        const cred = await secAuth.createUserWithEmailAndPassword(email, password);
        const newUid = cred.user.uid;

        try {
          await db.ref("inspecteurs/" + newUid).set({
            nom: nom, code: code, telephone: telephone, email: email,
            poolId: currentPoolId,
            ippId: currentIppId,
            statut: "actif",
            createdAt: firebase.database.ServerValue.TIMESTAMP
          });
          await db.ref("utilisateurs/" + newUid).set({
            role: "inspecteur",
            nomEntite: nom,
            code: code,
            telephone: telephone,
            entiteId: newUid,
            inspecteurId: newUid,
            poolId: currentPoolId,
            ippId: currentIppId,
            email: email,
            statut: "actif",
            createdAt: firebase.database.ServerValue.TIMESTAMP
          });
        } catch (dbErr) {
          // Retour arrière : pas de compte orphelin
          try { await db.ref("inspecteurs/" + newUid).remove(); } catch (_) {}
          try { await cred.user.delete(); } catch (_) {}
          throw dbErr;
        } finally {
          try { await secAuth.signOut(); } catch (_) {}
        }

        toast('Inspecteur "' + nom + '" créé. Mot de passe : ' + password, "success");
      }

      document.getElementById("modal-inspecteur").classList.remove("show");

    } catch (error) {
      console.error(error);
      toast("Erreur : " + (window.EKOLSTAT.translateAuthError ? window.EKOLSTAT.translateAuthError(error) : error.message), "error");
    }
  }

  // ==================== IMPORT EXCEL DES INSPECTEURS ====================
  // Colonnes : Nom | Code | Téléphone (facultatif)
  // Chaque ligne crée un compte : <nom>@gmail.com / 111111
  function openInspecteurImport() {
    if (!window.EKOLSTAT || !window.EKOLSTAT.openImportModal) {
      toast("Module d'import indisponible", "error");
      return;
    }
    window.EKOLSTAT.openImportModal({
      entityLabel: "Inspecteur itinérant",
      entityLabelPlural: "Inspecteurs itinérants",
      node: "inspecteurs",
      db: db,
      getSecondaryAuth: getSecondaryAuth,
      templateFile: "modele-import-inspecteurs.xlsx",
      templateExamples: [
        ["Jean Mukendi", "INSP-001"],
        ["Marie Kabeya", "INSP-002"]
      ],
      columns: [
        { key: "nom", header: "Nom", required: true,
          aliases: ["nom", "nom complet", "nom de l'entite", "nom entite", "entite", "designation",
                    "nom de l'inspecteur", "nom inspecteur", "inspecteur"] },
        { key: "code", header: "Code",
          aliases: ["code", "code entite", "code de l'entite", "code inspecteur", "matricule"] },
        { key: "telephone", header: "Téléphone", extra: true,
          aliases: ["telephone", "tel", "phone", "numero", "contact"] }
      ],
      getExisting: function() {
        return Object.keys(inspecteurs).map(function(k) { return inspecteurs[k]; });
      },
      entityData: function(v) {
        return { nom: v.nom, code: v.code, telephone: v.telephone, poolId: currentPoolId, ippId: currentIppId };
      },
      userData: function(v, uid) {
        return {
          role: "inspecteur",
          nomEntite: v.nom,
          code: v.code,
          telephone: v.telephone,
          entiteId: uid,
          inspecteurId: uid,
          poolId: currentPoolId,
          ippId: currentIppId,
          statut: "actif"
        };
      }
    });
  }

  async function resetInspecteurPassword(email) {
    if (!email) { toast("Cet inspecteur n'a pas d'email", "error"); return; }
    const ok = await confirmDialog("Réinitialiser le mot de passe", "Envoyer un email à " + email + " ?");
    if (!ok) return;
    try {
      await auth.sendPasswordResetEmail(email);
      toast("Email envoyé à " + email, "success");
    } catch (err) { toast(err.message, "error"); }
  }

  // Le statut est écrit à deux endroits : la fiche /inspecteurs (suivi par le Pool)
  // et le profil /utilisateurs (vérifié à la connexion de l'inspecteur).
  async function setInspecteurStatut(id, statut) {
    const updates = {};
    updates["inspecteurs/" + id + "/statut"] = statut;
    updates["utilisateurs/" + id + "/statut"] = statut;
    await db.ref().update(updates);
  }

  async function toggleInspecteur(id, currentStatut) {
    const insp = inspecteurs[id];
    if (!insp) return;

    const willInactivate = currentStatut !== "inactif";
    const ok = await confirmDialog(
      willInactivate ? "Désactiver cet inspecteur ?" : "Réactiver cet inspecteur ?",
      willInactivate
        ? 'L\'inspecteur "' + insp.nom + '" ne pourra plus se connecter. Ses écoles restent comptabilisées.'
        : 'L\'inspecteur "' + insp.nom + '" pourra de nouveau se connecter.'
    );
    if (!ok) return;

    try {
      await setInspecteurStatut(id, willInactivate ? "inactif" : "actif");
      toast(willInactivate ? "Inspecteur désactivé" : "Inspecteur réactivé", "success");
    } catch (err) {
      toast("Erreur : " + err.message, "error");
    }
  }

  async function deleteInspecteur(id, nom) {
    const ok = await confirmDialog(
      "⚠️ Supprimer définitivement ?",
      'L\'inspecteur "' + nom + '" sera supprimé et ne pourra plus se connecter. Les écoles qu\'il a collectées sont conservées. Action IRRÉVERSIBLE.'
    );
    if (!ok) return;

    try {
      await setInspecteurStatut(id, "supprime");
      toast('Inspecteur "' + nom + '" supprimé', "success");
    } catch (err) {
      toast("Erreur : " + err.message, "error");
    }
  }

  // Exposer pour onclick
  window.editInspecteur = openInspecteurModal;
  window.toggleInspecteur = toggleInspecteur;
  window.deleteInspecteur = deleteInspecteur;
  window.resetInspecteurPassword = resetInspecteurPassword;

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
