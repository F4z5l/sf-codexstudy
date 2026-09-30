/* Batch Explorer — Science and Fun (NextHope) course content.
   Folder navigation with breadcrumbs, lecture player (Hls.js) and PDF/notes viewer. */
(function () {
  "use strict";

  var api = window.SFApi;
  var $ = function (id) { return document.getElementById(id); };

  var params = new URLSearchParams(window.location.search);
  var courseId = (params.get("course") || "").trim();
  var courseName = (params.get("name") || "").trim() || "Course";
  var ROOT_PARENT = "-1";
  var PAGE_HINT = 10;   // a first page this big might have more pages behind it
  var MAX_PAGES = 30;
  var HLS_URLS = [
    "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.17/hls.min.js"
  ];

  var stack = [];        // folders below the course root: [{id, title}]
  var items = [];        // items of the folder on screen
  var loadToken = 0;
  var playerToken = 0;
  var hls = null;
  var hlsLibPromise = null;
  var current = null;    // { item, video }

  var ICON_FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';
  var ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7Z"/></svg>';
  var ICON_FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>';
  var ICON_CHEVRON = '<svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c];
    });
  }

  /* ---------- URL / history state ---------- */
  function hashForStack() {
    return stack.length ? "#p=" + encodeURIComponent(JSON.stringify(stack)) : "";
  }

  function stackFromHash() {
    try {
      var m = window.location.hash.match(/^#p=(.+)$/);
      if (!m) return [];
      var arr = JSON.parse(decodeURIComponent(m[1]));
      if (!Array.isArray(arr)) return [];
      return arr.filter(function (x) { return x && x.id != null; })
        .map(function (x) { return { id: String(x.id), title: String(x.title || "Folder") }; })
        .slice(0, 20);
    } catch (e) { return []; }
  }

  function navigate(newStack) {
    stack = newStack;
    try { window.history.pushState(null, "", window.location.pathname + window.location.search + hashForStack()); } catch (e) {}
    loadFolder();
  }

  window.addEventListener("popstate", function () {
    stack = stackFromHash();
    loadFolder();
  });

  /* ---------- Breadcrumbs ---------- */
  function renderCrumbs() {
    var nav = $("crumbs");
    var html = '<a href="index.html">Home</a><span class="sep">›</span>';
    if (!stack.length) {
      html += '<span class="current">' + esc(courseName) + "</span>";
    } else {
      html += '<button type="button" class="crumb" data-depth="0">' + esc(courseName) + "</button>";
      stack.forEach(function (folder, index) {
        html += '<span class="sep">›</span>';
        if (index === stack.length - 1) html += '<span class="current">' + esc(folder.title) + "</span>";
        else html += '<button type="button" class="crumb" data-depth="' + (index + 1) + '">' + esc(folder.title) + "</button>";
      });
    }
    nav.innerHTML = html;
    var last = nav.lastElementChild;
    if (last && last.scrollIntoView) { try { nav.scrollLeft = nav.scrollWidth; } catch (e) {} }
    var title = stack.length ? stack[stack.length - 1].title : courseName;
    $("pageTitle").textContent = title;
    document.title = title + " — CODEX STUDYS";
  }

  $("crumbs").addEventListener("click", function (event) {
    var btn = event.target.closest("button.crumb");
    if (!btn) return;
    var depth = parseInt(btn.getAttribute("data-depth"), 10);
    if (isNaN(depth)) return;
    navigate(stack.slice(0, depth));
  });

  /* ---------- Views ---------- */
  function setView(name) {
    $("loading").classList.toggle("hidden", name !== "loading");
    $("errorBox").classList.toggle("hidden", name !== "error");
    $("emptyBox").classList.toggle("hidden", name !== "empty");
    $("grid").classList.toggle("hidden", name !== "grid");
  }

  function showError(message) {
    $("moreLoading").classList.add("hidden");
    $("errorText").textContent = message || "Could not load this content. Please check your connection.";
    setView("error");
  }

  /* ---------- Cards ---------- */
  function thumbHtml(item, badge) {
    return '<div class="thumb"><div class="ph">' + ICON_PLAY + "</div>" +
      (item.thumbnail ? '<img src="' + esc(item.thumbnail) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : "") +
      (badge ? '<span class="duration">' + esc(badge) + "</span>" : "") + "</div>";
  }

  function cardHtml(item, index) {
    if (item.kind === "folder") {
      var sub = item.count ? item.count + (item.count === 1 ? " item" : " items") : "Folder";
      return '<article class="card card-folder" tabindex="0" role="button" data-action="open" data-idx="' + index + '" aria-label="Open folder ' + esc(item.title) + '">' +
        '<div class="folder-thumb">' + (item.thumbnail ? '<img src="' + esc(item.thumbnail) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : ICON_FOLDER) + "</div>" +
        '<div class="card-info"><h3 class="card-title">' + esc(item.title) + '</h3><div class="card-sub">' + esc(sub) + "</div></div>" +
        ICON_CHEVRON + "</article>";
    }
    if (item.kind === "pdf") {
      return '<article class="card card-pdf">' +
        '<div class="file-icon">' + ICON_FILE + "</div>" +
        '<div class="card-info"><h3 class="card-title">' + esc(item.title) + '</h3><div class="card-sub">' + (item.pdf ? "PDF document" : "Document") + "</div></div>" +
        (item.pdf ? '<button class="btn btn-primary" type="button" data-action="pdf" data-idx="' + index + '">View / Download</button>' : '<span class="card-sub">Unavailable</span>') +
        "</article>";
    }
    return '<article class="card">' + thumbHtml(item, item.duration) +
      '<div class="card-body"><h3 class="card-title">' + esc(item.title) + "</h3>" +
      '<div class="actions"><button class="btn btn-primary" type="button" data-action="watch" data-idx="' + index + '">▶ Watch</button>' +
      (item.pdf ? '<button class="btn" type="button" data-action="pdf" data-idx="' + index + '">PDF</button>' : "") +
      "</div></div></article>";
  }

  function renderItems() {
    if (!items.length) { setView("empty"); return; }
    $("grid").innerHTML = items.map(cardHtml).join("");
    setView("grid");
  }

  $("grid").addEventListener("click", function (event) {
    var el = event.target.closest("[data-action]");
    if (!el) return;
    var item = items[parseInt(el.getAttribute("data-idx"), 10)];
    if (!item) return;
    var action = el.getAttribute("data-action");
    if (action === "open") navigate(stack.concat([{ id: item.id, title: item.title }]));
    else if (action === "watch") openPlayer(item);
    else if (action === "pdf") openPdf(item.pdf, item.title);
  });

  $("grid").addEventListener("keydown", function (event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    var el = event.target.closest('[data-action="open"]');
    if (!el || event.target !== el) return;
    event.preventDefault();
    el.click();
  });

  /* ---------- Folder loading ---------- */
  function keyOf(item) { return item.kind + ":" + item.id; }

  function loadFolder() {
    if (!courseId) return;
    var token = ++loadToken;
    var parent = stack.length ? stack[stack.length - 1].id : ROOT_PARENT;
    renderCrumbs();
    items = [];
    $("moreLoading").classList.add("hidden");
    setView("loading");
    window.scrollTo(0, 0);

    return (async function () {
      try {
        var raw = await api.getJSON(api.folderPath(courseId, parent, 0));
        if (token !== loadToken) return;
        var page = api.normalizeItems(raw);
        if (!page.length && raw && raw.success === false) throw new Error(raw.message || "The server could not open this folder.");
        items = page.slice();
        renderItems();

        if (page.length >= PAGE_HINT) {
          var seen = {};
          items.forEach(function (it) { seen[keyOf(it)] = true; });
          $("moreLoading").classList.remove("hidden");
          for (var pages = 1; pages < MAX_PAGES; pages++) {
            var nextRaw;
            try { nextRaw = await api.getJSON(api.folderPath(courseId, parent, items.length), { retries: 1 }); }
            catch (e) { break; }
            if (token !== loadToken) return;
            var fresh = api.normalizeItems(nextRaw).filter(function (it) { return !seen[keyOf(it)]; });
            if (!fresh.length) break;
            fresh.forEach(function (it) { seen[keyOf(it)] = true; items.push(it); });
            renderItems();
          }
          $("moreLoading").classList.add("hidden");
        }
      } catch (error) {
        if (token !== loadToken) return;
        showError(error && error.message && error.message.indexOf("HTTP") !== 0 ? error.message + " — please retry." : "Could not load this content. Please check your connection and retry.");
      }
    })();
  }

  $("retryBtn").addEventListener("click", function () { loadFolder(); });

  /* ---------- Modals ---------- */
  function openModal(id) {
    $(id).classList.remove("hidden");
    document.body.style.overflow = "hidden";
  }
  function closeModal(id) {
    $(id).classList.add("hidden");
    if ($("playerModal").classList.contains("hidden") && $("pdfModal").classList.contains("hidden")) document.body.style.overflow = "";
  }

  /* ---------- PDF / notes ---------- */
  function openPdf(url, title) {
    var safe = api.safeUrl(url);
    if (!safe) return;
    $("pdfTitle").textContent = title || "Document";
    $("pdfFrame").src = safe;
    $("pdfOpen").href = safe;
    $("pdfDownload").href = safe;
    openModal("pdfModal");
  }
  function closePdf() {
    $("pdfFrame").src = "about:blank";
    closeModal("pdfModal");
  }
  $("pdfClose").addEventListener("click", closePdf);

  /* ---------- Video player ---------- */
  function loadHlsLib() {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (hlsLibPromise) return hlsLibPromise;
    hlsLibPromise = new Promise(function (resolve, reject) {
      var i = 0;
      (function next() {
        if (i >= HLS_URLS.length) { hlsLibPromise = null; reject(new Error("Player library failed to load")); return; }
        var s = document.createElement("script");
        s.src = HLS_URLS[i++];
        s.onload = function () { if (window.Hls) resolve(window.Hls); else next(); };
        s.onerror = function () { s.remove(); next(); };
        document.head.appendChild(s);
      })();
    });
    return hlsLibPromise;
  }

  function destroyHls() {
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
  }

  function playerLoading(on) { $("playerLoading").classList.toggle("hidden", !on); }
  function playerError(message) {
    playerLoading(false);
    $("playerErrorText").textContent = message || "Could not load this lecture.";
    $("playerError").classList.remove("hidden");
  }

  async function playSource(url, resumeAt, autoplay, token) {
    var video = $("video");
    destroyHls();
    var HlsLib = null;
    try { HlsLib = await loadHlsLib(); } catch (e) { HlsLib = null; }
    if (token !== playerToken) return;

    if (HlsLib && HlsLib.isSupported()) {
      var netRetries = 0, mediaRetries = 0;
      hls = new HlsLib({ maxBufferLength: 30, enableWorker: true });
      hls.on(HlsLib.Events.MANIFEST_PARSED, function () {
        if (token !== playerToken) return;
        playerLoading(false);
        if (resumeAt > 0) { try { video.currentTime = resumeAt; } catch (e) {} }
        if (autoplay) { var p = video.play(); if (p && p.catch) p.catch(function () {}); }
      });
      hls.on(HlsLib.Events.ERROR, function (event, data) {
        if (token !== playerToken || !data || !data.fatal) return;
        if (data.type === HlsLib.ErrorTypes.NETWORK_ERROR && netRetries < 2) { netRetries++; hls.startLoad(); return; }
        if (data.type === HlsLib.ErrorTypes.MEDIA_ERROR && mediaRetries < 1) { mediaRetries++; hls.recoverMediaError(); return; }
        playerError(data.type === HlsLib.ErrorTypes.NETWORK_ERROR ? "Network problem while loading the video." : "This video could not be played.");
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      video.onloadedmetadata = function () {
        if (token !== playerToken) return;
        playerLoading(false);
        if (resumeAt > 0) { try { video.currentTime = resumeAt; } catch (e) {} }
        if (autoplay) { var p = video.play(); if (p && p.catch) p.catch(function () {}); }
      };
      video.onerror = function () { if (token === playerToken) playerError("This video could not be played."); };
    } else {
      playerError("This browser cannot play the stream. Try “Open in new tab”.");
    }
  }

  function setLink(el, url) {
    if (url) { el.href = url; el.classList.remove("hidden"); }
    else { el.removeAttribute("href"); el.classList.add("hidden"); }
  }

  function showEmbed(on) {
    var frame = $("playerFrame"), video = $("video");
    if (on && current && current.video && current.video.playerUrl) {
      try { video.pause(); } catch (e) {}
      frame.src = current.video.playerUrl;
      frame.classList.remove("hidden");
      video.classList.add("hidden");
      playerLoading(false);
      $("playerError").classList.add("hidden");
      $("embedToggle").textContent = "Use built-in player";
    } else {
      frame.src = "about:blank";
      frame.classList.add("hidden");
      video.classList.remove("hidden");
      $("embedToggle").textContent = "Use embedded player";
    }
  }

  async function loadVideo(item) {
    var token = ++playerToken;
    destroyHls();
    var video = $("video");
    try { video.pause(); } catch (e) {}
    video.removeAttribute("src");
    video.onerror = null;
    $("playerError").classList.add("hidden");
    $("playerFrame").src = "about:blank";
    $("playerFrame").classList.add("hidden");
    video.classList.remove("hidden");
    playerLoading(true);
    setLink($("externalBtn"), "");
    setLink($("playerPdfBtn"), item.pdf || "");
    $("embedToggle").classList.add("hidden");
    $("qualityWrap").classList.add("hidden");

    try {
      var raw = await api.getJSON(api.videoPath(courseId, item.videoId));
      if (token !== playerToken) return;
      var v = api.normalizeVideo(raw);
      if (!v.hls && !v.playerUrl) throw new Error("No playable link is available for this lecture yet.");
      current = { item: item, video: v };
      if (v.title && !item.title) $("playerTitle").textContent = v.title;
      setLink($("externalBtn"), v.playerUrl);
      setLink($("playerPdfBtn"), item.pdf || v.pdf);
      if (v.playerUrl && v.hls) $("embedToggle").classList.remove("hidden");

      if (!v.hls) { showEmbed(true); return; }

      var select = $("qualitySelect");
      var options = ['<option value="' + esc(v.hls) + '">Auto</option>'];
      v.qualities.forEach(function (q) { options.push('<option value="' + esc(q.url) + '">' + esc(q.label) + "</option>"); });
      select.innerHTML = options.join("");
      $("qualityWrap").classList.toggle("hidden", v.qualities.length === 0);
      await playSource(v.hls, 0, true, token);
    } catch (error) {
      if (token !== playerToken) return;
      playerError(error && error.message && error.message.indexOf("HTTP") !== 0 && error.message !== "Network error"
        ? error.message
        : "Could not load this lecture. Check your connection and retry.");
    }
  }

  function openPlayer(item) {
    current = { item: item, video: null };
    $("playerTitle").textContent = item.title || "Lecture";
    openModal("playerModal");
    loadVideo(item);
  }

  function closePlayer() {
    playerToken++;
    destroyHls();
    var video = $("video");
    try { video.pause(); } catch (e) {}
    video.removeAttribute("src");
    try { video.load(); } catch (e) {}
    $("playerFrame").src = "about:blank";
    playerLoading(false);
    closeModal("playerModal");
    current = null;
  }

  $("playerClose").addEventListener("click", closePlayer);
  $("playerRetry").addEventListener("click", function () { if (current) loadVideo(current.item); });
  $("embedToggle").addEventListener("click", function () {
    showEmbed($("playerFrame").classList.contains("hidden"));
  });
  $("qualitySelect").addEventListener("change", function (event) {
    var video = $("video");
    var resume = video.currentTime || 0;
    var wasPlaying = !video.paused;
    playerLoading(true);
    playSource(event.target.value, resume, wasPlaying, playerToken);
  });

  ["playerModal", "pdfModal"].forEach(function (id) {
    $(id).addEventListener("click", function (event) {
      if (event.target !== $(id)) return;
      if (id === "playerModal") closePlayer(); else closePdf();
    });
  });
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    if (!$("playerModal").classList.contains("hidden")) closePlayer();
    else if (!$("pdfModal").classList.contains("hidden")) closePdf();
  });

  /* ---------- Start ---------- */
  if (!courseId) {
    $("pageTitle").textContent = "No course selected";
    $("crumbs").innerHTML = '<a href="index.html">Home</a>';
    $("errorText").textContent = "Pick a batch from the home page to start learning.";
    $("retryBtn").textContent = "Go to batches";
    $("retryBtn").addEventListener("click", function () { window.location.href = "index.html"; });
    setView("error");
  } else {
    stack = stackFromHash();
    loadFolder();
  }
})();
