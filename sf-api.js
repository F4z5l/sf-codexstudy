/* Science and Fun (NextHope) API helper.
   Used by both the home page (app.js) and the batch explorer (study.js).
   Every request is tried against the live host first, then against the optional
   same-origin proxy (/sf/*, see vercel.json) so a missing CORS header cannot break the site. */
(function () {
  "use strict";

  var BASE = "https://scienceandfun.nexthope.site";
  var PROXY = "/sf";
  var TIMEOUT_MS = 15000;

  function delay(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  function fetchOnce(url) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    return fetch(url, { cache: "no-store", signal: controller.signal, headers: { Accept: "application/json" } })
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.text();
      })
      .then(function (text) {
        try { return JSON.parse(text); }
        catch (e) { throw new Error("Invalid server response"); }
      })
      .then(function (json) { clearTimeout(timer); return json; }, function (err) { clearTimeout(timer); throw err; });
  }

  /* GET path (must start with "/") -> parsed JSON. Retries with back-off, live host then proxy. */
  async function getJSON(path, opts) {
    var retries = (opts && typeof opts.retries === "number") ? opts.retries : 2;
    var lastError = new Error("Network error");
    for (var attempt = 0; attempt <= retries; attempt++) {
      var bases = [BASE, PROXY];
      for (var i = 0; i < bases.length; i++) {
        try { return await fetchOnce(bases[i] + path); }
        catch (e) { lastError = e; }
      }
      if (attempt < retries) await delay(500 * (attempt + 1));
    }
    throw lastError;
  }

  function firstDefined(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return "";
  }

  function safeUrl(value) {
    if (typeof value !== "string") return "";
    var v = value.trim();
    if (v.indexOf("//") === 0) v = "https:" + v;
    return /^https?:\/\//i.test(v) ? v : "";
  }

  /* ---- Batches ---- */
  function normalizeBatches(raw) {
    var list = [];
    if (Array.isArray(raw)) list = raw;
    else if (raw && typeof raw === "object") list = [].concat(raw["new"] || [], raw.old || []);
    var seen = {};
    var out = [];
    list.forEach(function (b) {
      if (!b || typeof b !== "object") return;
      var id = firstDefined(b, ["id", "_id", "course_id", "batch_id"]);
      if (id === "") return;
      id = String(id);
      if (seen[id]) return;
      seen[id] = true;
      var title = String(firstDefined(b, ["title", "name"]) || "Untitled course");
      out.push({
        _id: id,
        batch_id: id,
        name: title,
        previewImage: safeUrl(String(firstDefined(b, ["thumbnail", "thumb", "image", "previewImage"]))),
        byName: "",
        language: "",
        source: "scienceandfun"
      });
    });
    return out;
  }

  /* ---- Folder contents ---- */
  function pickList(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== "object") return [];
    var keys = ["data", "list", "items", "contents", "content", "result", "results", "materials", "folder_contents"];
    for (var i = 0; i < keys.length; i++) {
      var v = payload[keys[i]];
      if (Array.isArray(v)) return v;
      if (v && typeof v === "object") {
        var inner = pickList(v);
        if (inner.length) return inner;
      }
    }
    return [];
  }

  function toNumber(v) {
    var n = parseInt(v, 10);
    return isNaN(n) ? 0 : n;
  }

  function formatDuration(value) {
    if (value === undefined || value === null || value === "") return "";
    if (typeof value === "string" && value.indexOf(":") !== -1) return value;
    var total = Number(value);
    if (!isFinite(total) || total <= 0) return "";
    if (total > 100000) total = Math.round(total / 1000); // milliseconds
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = Math.floor(total % 60);
    var pad = function (n) { return n < 10 ? "0" + n : String(n); };
    return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : m + ":" + pad(s);
  }

  function normalizeItem(raw) {
    if (!raw || typeof raw !== "object") return null;
    var type = String(firstDefined(raw, ["material_type", "type", "materialType"])).toUpperCase();
    var pdf = safeUrl(String(firstDefined(raw, ["pdf_link", "file_link", "pdf_url", "file_url", "pdf"])));
    var id = firstDefined(raw, ["id", "_id", "material_id", "folder_id", "video_id"]);
    var videoId = firstDefined(raw, ["video_id", "id", "_id", "material_id"]);
    var kind;
    if (type === "FOLDER") kind = "folder";
    else if (type === "PDF" || type === "NOTES" || type === "NOTE" || type === "DPP") kind = "pdf";
    else if (type === "VIDEO" || type === "LECTURE") kind = "video";
    else if (pdf && !raw.video_id) kind = "pdf";
    else kind = "video";

    var count = toNumber(firstDefined(raw, ["total_items", "items_count", "item_count", "count", "children_count", "total_count"]));
    if (!count) {
      count = toNumber(firstDefined(raw, ["video_count", "total_videos", "videos"])) +
        toNumber(firstDefined(raw, ["file_count", "total_files", "pdf_count", "files", "total_pdfs"]));
    }

    return {
      kind: kind,
      id: String(id),
      videoId: String(videoId),
      title: String(firstDefined(raw, ["title", "name", "topic"]) || (kind === "folder" ? "Folder" : "Untitled")),
      thumbnail: safeUrl(String(firstDefined(raw, ["thumbnail", "thumbnail_url", "thumb", "image", "cover"]))),
      count: count,
      duration: formatDuration(firstDefined(raw, ["duration", "video_duration", "length"])),
      pdf: pdf
    };
  }

  function normalizeItems(payload) {
    return pickList(payload).map(normalizeItem).filter(function (item) { return item && item.id !== ""; });
  }

  /* ---- Video details ---- */
  function normalizeQualities(raw) {
    var out = [];
    if (Array.isArray(raw)) {
      raw.forEach(function (q) {
        if (typeof q === "string") {
          var u = safeUrl(q);
          if (u) out.push({ label: /(\d{3,4})p/i.test(q) ? RegExp.$1 + "p" : "Quality", url: u });
        } else if (q && typeof q === "object") {
          var url = safeUrl(String(firstDefined(q, ["url", "link", "src", "decoded_video_link", "video_link"])));
          var label = String(firstDefined(q, ["quality", "label", "name", "resolution", "height"]));
          if (label && /^\d+$/.test(label)) label += "p";
          if (url) out.push({ label: label || "Quality", url: url });
        }
      });
    } else if (raw && typeof raw === "object") {
      Object.keys(raw).forEach(function (key) {
        var val = raw[key];
        var url = safeUrl(typeof val === "string" ? val : String(firstDefined(val || {}, ["url", "link", "src", "decoded_video_link"])));
        if (url) out.push({ label: /^\d+$/.test(key) ? key + "p" : key, url: url });
      });
    }
    var num = function (q) { return parseInt(q.label, 10) || 0; };
    out.sort(function (a, b) { return num(b) - num(a); });
    return out;
  }

  function normalizeVideo(payload) {
    var d = payload;
    if (d && typeof d === "object" && d.data && typeof d.data === "object" && !Array.isArray(d.data)) d = d.data;
    d = d || {};
    return {
      hls: safeUrl(String(firstDefined(d, ["decoded_video_link", "video_link", "m3u8"]))),
      playerUrl: safeUrl(String(firstDefined(d, ["player_url", "playerUrl"]))),
      qualities: normalizeQualities(d.qualities),
      pdf: safeUrl(String(firstDefined(d, ["pdf_link", "file_link"]))),
      title: String(firstDefined(d, ["title", "name"]) || "")
    };
  }

  window.SFApi = {
    getJSON: getJSON,
    safeUrl: safeUrl,
    normalizeBatches: normalizeBatches,
    normalizeItems: normalizeItems,
    normalizeVideo: normalizeVideo,
    batchesPath: function () { return "/batches.json"; },
    folderPath: function (courseId, parentId, start) {
      return "/vg/get/folder_contentsv3?course_id=" + encodeURIComponent(courseId) +
        "&parent_id=" + encodeURIComponent(parentId) + "&start=" + (start || 0);
    },
    videoPath: function (courseId, videoId) {
      return "/vg/get/fetchVideoDetailsById?course_id=" + encodeURIComponent(courseId) +
        "&video_id=" + encodeURIComponent(videoId);
    }
  };
})();
