(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };

  var LS_KEY = "parking.data.v1";
  var MAX_HISTORY = 20, MAX_PHOTOS = 4, DAY = 86400000;
  var GOOD_ACC = 15;        // metres; auto-save once the fix is this good
  var MAX_WAIT = 20000;     // ms; after this, save the best fix we have
  var WEAK_ACC = 50;        // metres; warn the user above this

  // record: {id, lat, lng, acc, savedAt, endedAt, floor, note, leaveBy, photos: [key]}
  var records = [], activeId = null, keepDays = 30;   // keepDays 0 = delete as soon as parking ends

  /* ---------- helpers ---------- */
  function newId() { return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function active() { return activeId ? findRec(activeId) : null; }
  function findRec(id) { for (var i = 0; i < records.length; i++) if (records[i].id === id) return records[i]; return null; }
  function hasPos(r) { return r && typeof r.lat === "number" && typeof r.lng === "number"; }
  function fmtTime(ms) { return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  function fmtDay(ms) {
    var d = new Date(ms), n = new Date();
    if (d.toDateString() === n.toDateString()) return "Today";
    var y = new Date(n); y.setDate(n.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  function fmtDur(ms) {
    var m = Math.max(0, Math.round(ms / 60000));
    if (m < 60) return m + " min";
    var h = Math.floor(m / 60), r = m % 60;
    if (h < 24) return h + " h" + (r ? " " + r + " min" : "");
    var d = Math.floor(h / 24);
    return d + " d " + (h % 24) + " h";
  }
  function fmtDist(m) {
    if (m < 1000) return Math.round(m) + " m";
    return (m / 1000).toFixed(m < 10000 ? 2 : 1) + " km";
  }
  function toast(text) {
    var t = $("toast");
    t.textContent = text; t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  /* ---------- geo math ---------- */
  var R = 6371000, rad = Math.PI / 180;
  function distance(a, b) {
    var dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearing(a, b) {
    var y = Math.sin((b.lng - a.lng) * rad) * Math.cos(b.lat * rad);
    var x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) -
      Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lng - a.lng) * rad);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }
  var DIRS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
  function dirName(deg) { return DIRS[Math.round(deg / 45) % 8]; }

  /* ---------- storage ---------- */
  function persist() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ records: records, activeId: activeId, keepDays: keepDays }));
      return true;
    } catch (e) {
      toast("Could not save. The phone may be out of space.");
      return false;
    }
  }
  function load() {
    try {
      var d = JSON.parse(localStorage.getItem(LS_KEY) || "null");
      if (d && Array.isArray(d.records)) {
        records = d.records.filter(function (r) { return r && typeof r.id === "string"; }).map(function (r) {
          return {
            id: r.id,
            lat: typeof r.lat === "number" ? r.lat : null, lng: typeof r.lng === "number" ? r.lng : null,
            acc: typeof r.acc === "number" ? r.acc : null,
            savedAt: Number(r.savedAt) || Date.now(), endedAt: r.endedAt ? Number(r.endedAt) : null,
            floor: String(r.floor || ""), note: String(r.note || ""),
            leaveBy: r.leaveBy ? Number(r.leaveBy) : null,
            photos: Array.isArray(r.photos) ? r.photos.filter(function (k) { return typeof k === "string"; }) : []
          };
        });
        activeId = typeof d.activeId === "string" && findRec(d.activeId) ? d.activeId : null;
        if ([0, 7, 30, 90].indexOf(d.keepDays) !== -1) keepDays = d.keepDays;
      }
    } catch (e) {}
  }

  /* ---------- photos (IndexedDB) ---------- */
  var dbPromise = null, urlCache = {};
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise(function (res, rej) {
        var r = indexedDB.open("parking", 1);
        r.onupgradeneeded = function () { r.result.createObjectStore("photos"); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
    }
    return dbPromise;
  }
  function idb(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var tx = d.transaction("photos", mode), req = fn(tx.objectStore("photos"));
        tx.oncomplete = function () { res(req && req.result); };
        tx.onerror = tx.onabort = function () { rej(tx.error); };
      });
    });
  }
  function putPhoto(key, blob) { return idb("readwrite", function (s) { return s.put(blob, key); }); }
  function getPhoto(key) { return idb("readonly", function (s) { return s.get(key); }); }
  function delPhoto(key) {
    if (urlCache[key]) { URL.revokeObjectURL(urlCache[key]); delete urlCache[key]; }
    return idb("readwrite", function (s) { return s.delete(key); }).catch(function () {});
  }
  function photoUrl(key) {
    if (urlCache[key]) return Promise.resolve(urlCache[key]);
    return getPhoto(key).then(function (b) {
      if (!b) return null;
      urlCache[key] = URL.createObjectURL(b);
      return urlCache[key];
    }).catch(function () { return null; });
  }
  function shrink(file) {
    return new Promise(function (res, rej) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var max = 1600, w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, max / Math.max(w, h));
        var c = document.createElement("canvas");
        c.width = Math.round(w * k); c.height = Math.round(h * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? res(b) : rej(new Error("encode")); }, "image/jpeg", 0.8);
      };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error("decode")); };
      img.src = url;
    });
  }
  function thumbButton(key, onOpen) {
    var b = document.createElement("button");
    b.type = "button"; b.className = "thumb"; b.setAttribute("aria-label", "Open photo");
    photoUrl(key).then(function (u) {
      if (!u) return;
      var i = document.createElement("img"); i.src = u; i.alt = ""; b.appendChild(i);
    });
    b.addEventListener("click", function () { onOpen(key); });
    return b;
  }

  /* ---------- saving a spot ---------- */
  var locating = false, watchId = null, best = null, locStart = 0, locTicker = null, locTarget = null, locError = null;

  function startLocating(targetId) {
    stopTracking();
    locTarget = targetId || null; best = null; locError = null; locStart = Date.now(); locating = true;
    if (!("geolocation" in navigator)) { locError = { code: 0 }; render(); return; }
    watchId = navigator.geolocation.watchPosition(function (p) {
      locError = null;
      if (!best || p.coords.accuracy < best.coords.accuracy) best = p;
      if (best.coords.accuracy <= GOOD_ACC && Date.now() - locStart > 2500) finishLocating();
      else renderLocating();
    }, function (err) {
      locError = err; renderLocating();
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
    locTicker = setInterval(function () {
      if (best && Date.now() - locStart > MAX_WAIT) finishLocating();
      else renderLocating();
    }, 500);
    render();
  }
  function stopLocating() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    clearInterval(locTicker); locTicker = null;
    locating = false;
  }
  function isLocating() { return locating; }
  function finishLocating(noPos) {
    var p = noPos ? null : best;
    var target = locTarget;
    stopLocating(); locTarget = null; locError = null;
    if (target) {
      var r = findRec(target);
      if (r && p) { r.lat = p.coords.latitude; r.lng = p.coords.longitude; r.acc = p.coords.accuracy; persist(); toast("Location updated"); }
    } else {
      saveNew(p);
    }
    render();
  }
  function cancelLocating() { stopLocating(); locTarget = null; locError = null; render(); }
  function saveNew(p) {
    var r = {
      id: newId(), lat: p ? p.coords.latitude : null, lng: p ? p.coords.longitude : null,
      acc: p ? p.coords.accuracy : null, savedAt: Date.now(), endedAt: null,
      floor: "", note: "", leaveBy: null, photos: []
    };
    records.unshift(r); activeId = r.id;
    prune(); persist();
    toast(p ? "Parking spot saved" : "Saved without location");
  }
  // Drop past spots older than the chosen retention, and anything beyond MAX_HISTORY.
  function prune() {
    var cutoff = Date.now() - keepDays * DAY, removed = 0, kept = 0;
    records.filter(function (r) { return r.id !== activeId; }).forEach(function (r) {
      if (keepDays === 0 || kept >= MAX_HISTORY || (r.endedAt || r.savedAt) < cutoff) { removeRecord(r.id, true); removed++; }
      else kept++;
    });
    return removed;
  }
  function removeRecord(id, quiet) {
    var r = findRec(id); if (!r) return;
    r.photos.forEach(delPhoto);
    records = records.filter(function (x) { return x.id !== id; });
    if (activeId === id) activeId = null;
    if (!quiet) persist();
  }

  /* ---------- live position & compass ---------- */
  var here = null, hereWatch = null, heading = null, compassOn = false;
  function startTracking() {
    if (hereWatch !== null || !("geolocation" in navigator)) return;
    hereWatch = navigator.geolocation.watchPosition(function (p) {
      here = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
      renderLive();
    }, function () {}, { enableHighAccuracy: true, maximumAge: 5000 });
  }
  function stopTracking() {
    if (hereWatch !== null) navigator.geolocation.clearWatch(hereWatch);
    hereWatch = null;
  }
  function onOrient(e) {
    var h = null;
    if (typeof e.webkitCompassHeading === "number") h = e.webkitCompassHeading;
    else if (e.absolute && typeof e.alpha === "number") h = (360 - e.alpha) % 360;
    if (h === null) return;
    if (screen.orientation && typeof screen.orientation.angle === "number") h = (h + screen.orientation.angle) % 360;
    heading = h; renderArrow();
  }
  function listenCompass() {
    if (compassOn) return;
    compassOn = true;
    window.addEventListener("deviceorientationabsolute", onOrient);
    window.addEventListener("deviceorientation", onOrient);
    renderLive();
  }
  var needsPermission = typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function";
  $("compass-btn").addEventListener("click", function () {
    if (!needsPermission) { listenCompass(); return; }
    DeviceOrientationEvent.requestPermission().then(function (r) {
      if (r === "granted") listenCompass();
      else toast("Compass permission was not granted");
    }).catch(function () { toast("Compass is not available"); });
  });

  /* ---------- rendering ---------- */
  function show(view) {
    $("view-empty").hidden = view !== "empty";
    $("view-locating").hidden = view !== "locating";
    $("view-active").hidden = view !== "active";
  }
  function render() {
    var r = active();
    if (isLocating()) { show("locating"); renderLocating(); }
    else if (r) { show("active"); renderActive(r); }
    else show("empty");
    if (r && hasPos(r) && !isLocating() && document.visibilityState === "visible") startTracking();
    else stopTracking();
    renderHistory();
  }
  function renderLocating() {
    var updating = !!locTarget;
    $("loc-title").textContent = updating ? "Updating location…" : "Finding your location…";
    $("loc-acc").textContent = best ? "±" + Math.round(best.coords.accuracy) + " m" : "–";
    var waited = Date.now() - locStart;
    $("loc-hint").textContent = !best ? "Waiting for GPS. Accuracy improves over a few seconds."
      : best.coords.accuracy > WEAK_ACC ? "Weak signal. Move outside or nearer the entrance if you can."
      : "Getting a more accurate fix…";
    $("loc-use").disabled = !best;
    $("loc-nogps").hidden = updating || !(locError || waited > 8000);
    var err = $("loc-err");
    if (locError && !best) {
      err.hidden = false;
      err.textContent = locError.code === 1
        ? "Location access is off. On iPhone: Settings › Privacy & Security › Location Services › Safari Websites › While Using the App. Then try again."
        : locError.code === 0 ? "This browser cannot read the location."
        : "No GPS signal yet. Keep waiting, or save without location.";
    } else err.hidden = true;
  }
  function renderActive(r) {
    var now = Date.now();
    $("f-parked").textContent = fmtDay(r.savedAt) + " " + fmtTime(r.savedAt);
    $("f-duration").textContent = fmtDur(now - r.savedAt);
    $("f-acc").textContent = hasPos(r) ? "±" + Math.round(r.acc) + " m" : "No location";
    $("nogps-note").hidden = hasPos(r);
    var weak = $("weak-note");
    weak.hidden = !(hasPos(r) && r.acc > WEAK_ACC);
    weak.textContent = "The saved location may be off by about " + Math.round(r.acc || 0) + " m. Add the floor and a photo so you can find the car.";
    ["nav-apple", "nav-google", "share"].forEach(function (id) { $(id).disabled = !hasPos(r); });

    if (document.activeElement !== $("floor") && $("floor").value !== r.floor) $("floor").value = r.floor;
    if (document.activeElement !== $("note") && $("note").value !== r.note) $("note").value = r.note;

    renderLeave(r);
    renderPhotos(r);
    renderLive();
  }
  function renderLeave(r) {
    var input = $("leave-by"), left = $("leave-left"), over = $("over-note");
    $("leave-clear").hidden = !r.leaveBy;
    if (!r.leaveBy) { left.textContent = ""; over.hidden = true; if (document.activeElement !== input) input.value = ""; return; }
    var d = new Date(r.leaveBy), p = function (x) { return String(x).padStart(2, "0"); };
    if (document.activeElement !== input) input.value = p(d.getHours()) + ":" + p(d.getMinutes());
    var diff = r.leaveBy - Date.now();
    if (diff >= 0) {
      left.textContent = fmtDur(diff) + " left";
      left.className = diff <= 10 * 60000 ? "left-soon" : "left-ok";
      over.hidden = true;
    } else {
      left.textContent = "Overdue by " + fmtDur(-diff);
      left.className = "left-over";
      over.hidden = false;
      over.textContent = "Time to go: you planned to leave by " + fmtTime(r.leaveBy) + ".";
    }
  }
  function renderPhotos(r) {
    var box = $("photos");
    box.textContent = "";
    r.photos.forEach(function (k) { box.appendChild(thumbButton(k, function (key) { openViewer(r.id, key); })); });
    if (r.photos.length < MAX_PHOTOS) {
      var add = document.createElement("button");
      add.type = "button"; add.className = "add-photo"; add.textContent = "+ Photo";
      add.addEventListener("click", function () { $("photo-input").click(); });
      box.appendChild(add);
    }
  }
  function renderLive() {
    var r = active();
    if (!r || $("view-active").hidden) return;
    $("compass-btn").hidden = compassOn || !hasPos(r) || !("DeviceOrientationEvent" in window);
    if (!hasPos(r)) {
      $("dist").textContent = "–"; $("dir-text").textContent = "No location saved"; $("here-acc").textContent = "";
      renderArrow(); return;
    }
    if (!here) {
      $("dist").textContent = "…"; $("dir-text").textContent = "Finding where you are now";
      $("here-acc").textContent = ""; renderArrow(); return;
    }
    var d = distance(here, r), slack = (here.acc || 0) + (r.acc || 0);
    if (d <= Math.max(15, slack * 0.6)) {
      $("dist").textContent = "Very close";
      $("dir-text").textContent = "Within about " + Math.round(Math.max(d, 5)) + " m — look around";
    } else {
      $("dist").textContent = fmtDist(d);
      $("dir-text").textContent = "Car is to the " + dirName(bearing(here, r));
    }
    $("here-acc").textContent = "Your position ±" + Math.round(here.acc) + " m" +
      (compassOn && heading !== null ? " · hold the phone flat, top pointing ahead" : compassOn ? "" : " · arrow is relative to north");
    renderArrow();
  }
  function renderArrow() {
    var r = active(), face = $("dial-face"), arrow = $("arrow");
    var h = compassOn && heading !== null ? heading : 0;
    face.style.transform = "rotate(" + (-h) + "deg)";
    if (!r || !hasPos(r) || !here) { arrow.style.opacity = ".25"; arrow.style.transform = "rotate(" + (-h) + "deg)"; return; }
    arrow.style.opacity = "1";
    arrow.style.transform = "rotate(" + (bearing(here, r) - h) + "deg)";
  }
  function renderHistory() {
    var list = $("hist"), past = records.filter(function (r) { return r.id !== activeId; });
    list.textContent = "";
    $("hist-empty").hidden = past.length > 0;
    $("hist-clear").hidden = past.length === 0;
    $("keep-days").value = String(keepDays);
    past.forEach(function (r) {
      var li = document.createElement("li"), det = document.createElement("details"), sum = document.createElement("summary");
      var main = document.createElement("div"); main.className = "h-main";
      var t = document.createElement("div"); t.className = "h-title";
      t.textContent = fmtDay(r.savedAt) + " " + fmtTime(r.savedAt) + (r.endedAt ? " · " + fmtDur(r.endedAt - r.savedAt) : "");
      var s = document.createElement("div"); s.className = "h-sub";
      s.textContent = [r.floor, r.note.replace(/\s+/g, " ")].filter(Boolean).join(" · ") || (hasPos(r) ? "±" + Math.round(r.acc) + " m" : "No location");
      main.appendChild(t); main.appendChild(s); sum.appendChild(main);
      if (r.photos.length) { var pc = document.createElement("span"); pc.className = "muted small"; pc.textContent = r.photos.length + " photo" + (r.photos.length > 1 ? "s" : ""); sum.appendChild(pc); }
      det.appendChild(sum);

      var body = document.createElement("div"); body.className = "h-body";
      det.addEventListener("toggle", function () {
        if (!det.open || body.childElementCount) return;
        if (r.photos.length) {
          var ph = document.createElement("div"); ph.className = "photos"; ph.style.marginTop = "0";
          r.photos.forEach(function (k) { ph.appendChild(thumbButton(k, function (key) { openViewer(r.id, key); })); });
          body.appendChild(ph);
        }
        var btns = document.createElement("div"); btns.className = "h-btns";
        function btn(label, fn, cls) {
          var b = document.createElement("button"); b.type = "button"; b.textContent = label;
          if (cls) b.className = cls;
          b.addEventListener("click", fn); btns.appendChild(b); return b;
        }
        if (hasPos(r)) {
          btn("Apple Maps", function () { openMaps("apple", r); });
          btn("Google Maps", function () { openMaps("google", r); });
        }
        if (!activeId) btn("Make current", function () { r.endedAt = null; activeId = r.id; records = [r].concat(records.filter(function (x) { return x !== r; })); persist(); render(); window.scrollTo(0, 0); });
        btn("Delete", function () {
          if (confirm("Delete this parking record and its photos?")) { removeRecord(r.id); render(); }
        }, "danger");
        body.appendChild(btns);
      });
      det.appendChild(body); li.appendChild(det); list.appendChild(li);
    });
  }

  /* ---------- maps & share ---------- */
  function mapsUrl(kind, r) {
    var ll = r.lat.toFixed(6) + "," + r.lng.toFixed(6);
    return kind === "apple"
      ? "https://maps.apple.com/?daddr=" + ll + "&dirflg=w"
      : "https://www.google.com/maps/dir/?api=1&destination=" + ll + "&travelmode=walking";
  }
  function openMaps(kind, r) { if (hasPos(r)) window.location.href = mapsUrl(kind, r); }
  $("nav-apple").addEventListener("click", function () { openMaps("apple", active()); });
  $("nav-google").addEventListener("click", function () { openMaps("google", active()); });
  $("share").addEventListener("click", function () {
    var r = active(); if (!hasPos(r)) return;
    var text = "My car is parked here" + (r.floor ? " (" + r.floor + ")" : "") + ": " +
      "https://maps.google.com/?q=" + r.lat.toFixed(6) + "," + r.lng.toFixed(6);
    if (navigator.share) { navigator.share({ title: "Parking spot", text: text }).catch(function () {}); return; }
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { toast("Link copied"); }, function () { toast(text); });
    else toast(text);
  });

  /* ---------- active-spot editing ---------- */
  var editTimer = null;
  function editSoon() { clearTimeout(editTimer); editTimer = setTimeout(function () { editTimer = null; persist(); }, 400); }
  $("floor").addEventListener("input", function (e) { var r = active(); if (r) { r.floor = e.target.value; editSoon(); } });
  $("note").addEventListener("input", function (e) { var r = active(); if (r) { r.note = e.target.value; editSoon(); } });
  $("leave-by").addEventListener("change", function (e) {
    var r = active(); if (!r) return;
    var v = e.target.value;
    if (!v) { r.leaveBy = null; }
    else {
      var parts = v.split(":"), d = new Date();
      d.setHours(+parts[0], +parts[1], 0, 0);
      if (d.getTime() < Date.now() - 60000) d.setDate(d.getDate() + 1);
      r.leaveBy = d.getTime();
    }
    persist(); renderLeave(r);
  });
  $("leave-clear").addEventListener("click", function () { var r = active(); if (r) { r.leaveBy = null; persist(); renderLeave(r); } });
  $("photo-input").addEventListener("change", function (e) {
    var f = e.target.files && e.target.files[0], r = active();
    e.target.value = "";
    if (!f || !r || r.photos.length >= MAX_PHOTOS) return;
    var key = r.id + "-" + Date.now().toString(36);
    toast("Saving photo…");
    shrink(f).then(function (b) { return putPhoto(key, b); }).then(function () {
      r.photos.push(key); persist(); renderPhotos(r); renderHistory(); toast("Photo saved");
    }).catch(function () { toast("Could not save the photo"); });
  });
  $("end").addEventListener("click", function () {
    var r = active(); if (!r) return;
    if (editTimer) { clearTimeout(editTimer); editTimer = null; }
    r.endedAt = Date.now(); activeId = null; here = null;
    prune(); persist(); render(); window.scrollTo(0, 0);
    toast(keepDays === 0 ? "Parking ended and deleted." : "Parking ended. It stays in History for " + keepDays + " days.");
  });
  $("relocate").addEventListener("click", function () { var r = active(); if (r) startLocating(r.id); });

  /* ---------- photo viewer ---------- */
  var viewing = null;
  function openViewer(recId, key) {
    photoUrl(key).then(function (u) {
      if (!u) { toast("Photo not found"); return; }
      viewing = { recId: recId, key: key };
      $("viewer-img").src = u; $("viewer").hidden = false;
    });
  }
  function closeViewer() { $("viewer").hidden = true; $("viewer-img").removeAttribute("src"); viewing = null; }
  $("viewer-close").addEventListener("click", closeViewer);
  $("viewer-del").addEventListener("click", function () {
    if (!viewing || !confirm("Delete this photo?")) return;
    var r = findRec(viewing.recId), key = viewing.key;
    closeViewer();
    if (r) { r.photos = r.photos.filter(function (k) { return k !== key; }); persist(); }
    delPhoto(key); render();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("viewer").hidden) closeViewer(); });

  /* ---------- buttons ---------- */
  $("save-spot").addEventListener("click", function () { startLocating(null); });
  $("save-nogps").addEventListener("click", function () { saveNew(null); render(); });
  $("loc-use").addEventListener("click", function () { if (best) finishLocating(); });
  $("loc-cancel").addEventListener("click", cancelLocating);
  $("loc-nogps").addEventListener("click", function () { finishLocating(true); });
  $("keep-days").addEventListener("change", function (e) {
    var v = Number(e.target.value);
    var losing = records.filter(function (r) {
      return r.id !== activeId && (v === 0 || (r.endedAt || r.savedAt) < Date.now() - v * DAY);
    }).length;
    if (losing && !confirm("This deletes " + losing + " older record" + (losing > 1 ? "s" : "") + " and their photos now. Continue?")) {
      e.target.value = String(keepDays); return;
    }
    keepDays = v; prune(); persist(); render();
  });
  $("hist-clear").addEventListener("click", function () {
    if (!confirm("Delete all past parking records and their photos?")) return;
    records.filter(function (r) { return r.id !== activeId; }).forEach(function (r) { removeRecord(r.id, true); });
    persist(); render();
  });

  /* ---------- lifecycle ---------- */
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { if (editTimer) { clearTimeout(editTimer); editTimer = null; persist(); } stopTracking(); }
    else { if (prune()) persist(); render(); }
  });
  window.addEventListener("pagehide", function () { if (editTimer) { clearTimeout(editTimer); editTimer = null; persist(); } });
  setInterval(function () {
    var r = active();
    if (r && !$("view-active").hidden && document.visibilityState === "visible") {
      $("f-duration").textContent = fmtDur(Date.now() - r.savedAt);
      renderLeave(r);
    }
  }, 15000);

  load();
  if (prune()) persist();
  render();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(function () {});
})();
