const CATEGORIES = ["Haldi", "Mehendi", "Wedding", "Reception", "Others"];
const STORAGE_KEY = "wedding_photo_organizer_records_v1";
const DB_NAME = "weddingPhotoOrganizerDB";
const DB_STORE = "uploads";
const PAGE_SIZE = 80;

const state = {
  records: [],
  filteredIds: [],
  renderedCount: 0,
  selectedIds: new Set(),
  activeFilter: "All",
  query: "",
  db: null,
  lightbox: { open: false, index: -1 },
};

const el = {
  fileInput: document.getElementById("fileInput"),
  driveForm: document.getElementById("driveForm"),
  driveLinks: document.getElementById("driveLinks"),
  gallery: document.getElementById("gallery"),
  sentinel: document.getElementById("sentinel"),
  categoryFilters: document.getElementById("categoryFilters"),
  searchInput: document.getElementById("searchInput"),
  assignCategory: document.getElementById("assignCategory"),
  assignBtn: document.getElementById("assignBtn"),
  clearSelectionBtn: document.getElementById("clearSelectionBtn"),
  selectionCount: document.getElementById("selectionCount"),
  emptyState: document.getElementById("emptyState"),
  template: document.getElementById("imageCardTemplate"),
  lightbox: document.getElementById("lightbox"),
  lightboxImage: document.getElementById("lightboxImage"),
  lightboxMeta: document.getElementById("lightboxMeta"),
  lightboxClose: document.getElementById("lightboxClose"),
  lightboxPrev: document.getElementById("lightboxPrev"),
  lightboxNext: document.getElementById("lightboxNext"),
};

init();

async function init() {
  state.db = await openDB();
  renderCategoryControls();
  await restoreRecords();
  bindEvents();
  applyFiltersAndRender(true);
  setupInfiniteScroll();
}

function bindEvents() {
  el.fileInput.addEventListener("change", (event) => handleFileUpload(event.target.files));

  el.driveForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const raw = el.driveLinks.value.trim();
    if (!raw) return;
    const links = raw
      .split(/[\n,]+/)
      .map((v) => v.trim())
      .filter(Boolean);
    addLinks(links);
    el.driveLinks.value = "";
  });

  el.searchInput.addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLowerCase();
    applyFiltersAndRender(true);
  });

  el.assignBtn.addEventListener("click", assignSelectedToCategory);
  el.clearSelectionBtn.addEventListener("click", () => {
    state.selectedIds.clear();
    rerenderSelectionState();
  });

  el.lightboxClose.addEventListener("click", closeLightbox);
  el.lightboxPrev.addEventListener("click", () => moveLightbox(-1));
  el.lightboxNext.addEventListener("click", () => moveLightbox(1));

  document.addEventListener("keydown", (event) => {
    if (!state.lightbox.open) return;
    if (event.key === "Escape") closeLightbox();
    if (event.key === "ArrowLeft") moveLightbox(-1);
    if (event.key === "ArrowRight") moveLightbox(1);
  });
}

function renderCategoryControls() {
  const categories = ["All", ...CATEGORIES];

  el.categoryFilters.innerHTML = "";
  categories.forEach((category) => {
    const chip = document.createElement("button");
    chip.className = `chip ${category === state.activeFilter ? "active" : ""}`;
    chip.textContent = category;
    chip.dataset.category = category;

    chip.addEventListener("click", () => {
      state.activeFilter = category;
      renderCategoryControls();
      applyFiltersAndRender(true);
    });

    chip.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (category === "All") return;
      chip.classList.add("drop-target");
    });
    chip.addEventListener("dragleave", () => chip.classList.remove("drop-target"));
    chip.addEventListener("drop", async (e) => {
      e.preventDefault();
      chip.classList.remove("drop-target");
      if (category === "All") return;
      const id = e.dataTransfer.getData("text/plain");
      const rec = state.records.find((r) => r.id === id);
      if (!rec) return;
      rec.category = category;
      await persistRecords();
      applyFiltersAndRender(true);
    });

    el.categoryFilters.appendChild(chip);
  });

  el.assignCategory.innerHTML = '<option value="">Assign category...</option>';
  CATEGORIES.forEach((category) => {
    const opt = document.createElement("option");
    opt.value = category;
    opt.textContent = category;
    el.assignCategory.appendChild(opt);
  });
}

async function handleFileUpload(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    const fingerprint = `upload:${file.name}:${file.size}:${file.lastModified}`;
    if (state.records.some((r) => r.fingerprint === fingerprint)) continue;

    const id = crypto.randomUUID();
    await saveBlobToDB(id, file);
    state.records.push({
      id,
      type: "upload",
      name: file.name,
      category: "Others",
      fingerprint,
      createdAt: Date.now(),
    });
  }

  await persistRecords();
  applyFiltersAndRender(true);
  el.fileInput.value = "";
}

function normalizeDriveUrl(url) {
  const match = url.match(/drive\.google\.com\/file\/d\/([^/]+)/i);
  if (match?.[1]) return `https://drive.google.com/uc?export=view&id=${match[1]}`;
  return url;
}

async function addLinks(links) {
  for (const raw of links) {
    const normalized = normalizeDriveUrl(raw);
    try {
      new URL(normalized);
    } catch {
      continue;
    }

    const fingerprint = `link:${normalized}`;
    if (state.records.some((r) => r.fingerprint === fingerprint)) continue;

    state.records.push({
      id: crypto.randomUUID(),
      type: "link",
      url: normalized,
      name: extractNameFromUrl(normalized),
      category: "Others",
      fingerprint,
      createdAt: Date.now(),
    });
  }

  await persistRecords();
  applyFiltersAndRender(true);
}

function extractNameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const raw = pathname.split("/").filter(Boolean).pop() || "linked-image";
    return decodeURIComponent(raw);
  } catch {
    return "linked-image";
  }
}

async function restoreRecords() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    state.records = [];
    return;
  }

  try {
    const parsed = JSON.parse(raw);
    state.records = Array.isArray(parsed) ? parsed : [];
  } catch {
    state.records = [];
  }
}

async function persistRecords() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.records));
}

function applyFiltersAndRender(reset = false) {
  const q = state.query;
  state.filteredIds = state.records
    .filter((r) => {
      const matchesCategory = state.activeFilter === "All" || r.category === state.activeFilter;
      const hay = `${r.name} ${r.category}`.toLowerCase();
      const matchesQuery = !q || hay.includes(q);
      return matchesCategory && matchesQuery;
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((r) => r.id);

  if (reset) {
    state.renderedCount = 0;
    el.gallery.innerHTML = "";
  }

  renderNextPage();
  el.emptyState.classList.toggle("hidden", state.filteredIds.length > 0);
  rerenderSelectionState();
}

function renderNextPage() {
  const start = state.renderedCount;
  const end = Math.min(start + PAGE_SIZE, state.filteredIds.length);
  if (start >= end) return;

  const fragment = document.createDocumentFragment();

  for (let i = start; i < end; i++) {
    const id = state.filteredIds[i];
    const rec = state.records.find((r) => r.id === id);
    if (!rec) continue;
    fragment.appendChild(createCard(rec));
  }

  el.gallery.appendChild(fragment);
  state.renderedCount = end;
}

function createCard(rec) {
  const node = el.template.content.firstElementChild.cloneNode(true);
  const img = node.querySelector("img");
  const selectBtn = node.querySelector(".select-toggle");
  const categoryPill = node.querySelector(".category-pill");
  const name = node.querySelector(".name");

  node.dataset.id = rec.id;
  categoryPill.textContent = rec.category;
  name.textContent = rec.name;
  name.title = rec.name;

  if (state.selectedIds.has(rec.id)) node.classList.add("selected");

  if (rec.type === "upload") {
    getBlobFromDB(rec.id).then((blob) => {
      if (!blob) {
        node.classList.add("broken");
        return;
      }
      const objectUrl = URL.createObjectURL(blob);
      img.src = objectUrl;
      img.dataset.objectUrl = objectUrl;
    });
  } else {
    img.src = rec.url;
  }

  img.addEventListener("error", () => {
    node.classList.add("broken");
  });

  img.addEventListener("click", () => openLightboxById(rec.id));

  selectBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleSelected(rec.id, node);
  });

  node.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", rec.id);
  });

  node.addEventListener("DOMNodeRemoved", () => {
    const objectUrl = img.dataset.objectUrl;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });

  return node;
}

function toggleSelected(id, cardNode) {
  if (state.selectedIds.has(id)) {
    state.selectedIds.delete(id);
    cardNode?.classList.remove("selected");
  } else {
    state.selectedIds.add(id);
    cardNode?.classList.add("selected");
  }
  rerenderSelectionState();
}

function rerenderSelectionState() {
  el.selectionCount.textContent = `${state.selectedIds.size} selected`;
  el.gallery.querySelectorAll(".card").forEach((card) => {
    card.classList.toggle("selected", state.selectedIds.has(card.dataset.id));
  });
}

async function assignSelectedToCategory() {
  const category = el.assignCategory.value;
  if (!category || state.selectedIds.size === 0) return;

  state.records.forEach((record) => {
    if (state.selectedIds.has(record.id)) record.category = category;
  });

  await persistRecords();
  applyFiltersAndRender(true);
}

function setupInfiniteScroll() {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) renderNextPage();
      });
    },
    { rootMargin: "800px" }
  );

  observer.observe(el.sentinel);
}

async function openLightboxById(id) {
  const index = state.filteredIds.indexOf(id);
  if (index < 0) return;
  state.lightbox.open = true;
  state.lightbox.index = index;
  el.lightbox.classList.remove("hidden");
  await renderLightbox();
}

async function renderLightbox() {
  const rec = state.records.find((r) => r.id === state.filteredIds[state.lightbox.index]);
  if (!rec) return;

  if (rec.type === "upload") {
    const blob = await getBlobFromDB(rec.id);
    if (!blob) return;
    const objectUrl = URL.createObjectURL(blob);
    el.lightboxImage.src = objectUrl;
    if (el.lightboxImage.dataset.objectUrl) URL.revokeObjectURL(el.lightboxImage.dataset.objectUrl);
    el.lightboxImage.dataset.objectUrl = objectUrl;
  } else {
    el.lightboxImage.src = rec.url;
  }

  el.lightboxMeta.textContent = `${rec.name} • ${rec.category}`;
}

function closeLightbox() {
  state.lightbox.open = false;
  state.lightbox.index = -1;
  el.lightbox.classList.add("hidden");
}

async function moveLightbox(direction) {
  if (!state.lightbox.open || state.filteredIds.length === 0) return;
  const total = state.filteredIds.length;
  state.lightbox.index = (state.lightbox.index + direction + total) % total;
  await renderLightbox();
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function saveBlobToDB(id, blob) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function getBlobFromDB(id) {
  return new Promise((resolve) => {
    const tx = state.db.transaction(DB_STORE, "readonly");
    const req = tx.objectStore(DB_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}
