const statusLabels = {
  available: "Has matches",
  low: "Running low",
  unavailable: "No matches",
};

const statusColors = {
  available: "#61735a",
  low: "#e1a93b",
  unavailable: "#6d665d",
};

const map = L.map("map", {
  zoomControl: false,
  scrollWheelZoom: true,
}).setView([39.8, -98.6], 4);

L.control.zoom({ position: "bottomright" }).addTo(map);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const markerLayer = L.layerGroup().addTo(map);
const list = document.querySelector("#location-list");
const search = document.querySelector("#search");
const suggestions = document.querySelector("#search-suggestions");
const visibleCount = document.querySelector("#visible-count");
const countLabel = document.querySelector("#count-label");
const mappedCount = document.querySelector("#mapped-count");
const filterButtons = [...document.querySelectorAll(".filter")];

let activeFilter = "all";
let locations = window.MATCHBOX_LOCATIONS || [];
let markers = new Map();
let suggestionItems = [];

render();

search.addEventListener("input", () => {
  render();
  renderSuggestions();
});

search.addEventListener("focus", renderSuggestions);

search.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideSuggestions();
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".search-wrap")) hideSuggestions();
});

filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;
    filterButtons.forEach((item) => item.classList.toggle("is-active", item === button));
    render();
  });
});

function render() {
  const query = search.value.trim().toLowerCase();
  const filtered = locations.filter((location) => {
    const matchesFilter = activeFilter === "all" || location.status === activeFilter;
    const haystack = searchableText(location);

    return matchesFilter && matchesSearch(haystack, query);
  });

  renderMarkers(filtered);
  renderList(filtered);

  visibleCount.textContent = filtered.length.toLocaleString();
  countLabel.textContent = filtered.length === 1 ? "location listed" : "locations listed";
  mappedCount.textContent = `${filtered.filter(hasCoordinates).length.toLocaleString()} mapped`;
}

function renderMarkers(items) {
  markerLayer.clearLayers();
  markers = new Map();

  const mappedItems = items.filter(hasCoordinates);

  mappedItems.forEach((location) => {
    const marker = L.circleMarker([location.lat, location.lng], {
      radius: 8,
      color: "#fffdf8",
      weight: 2,
      fillColor: statusColors[location.status] || statusColors.available,
      fillOpacity: 0.94,
    }).bindPopup(popupHtml(location));

    marker.on("click", () => focusLocation(location));
    marker.addTo(markerLayer);
    markers.set(location.id, marker);
  });

  if (mappedItems.length) {
    const bounds = L.latLngBounds(mappedItems.map((item) => [item.lat, item.lng]));
    map.fitBounds(bounds, { padding: [34, 34], maxZoom: 13 });
  }
}

function renderList(items) {
  if (!items.length) {
    const empty = document.createElement("li");
    empty.className = "location-card";
    empty.textContent = "No matching locations.";
    list.replaceChildren(empty);
    return;
  }

  list.replaceChildren(
    ...items.map((location) => {
      const item = document.createElement("li");
      item.className = "location-card";
      item.classList.toggle("is-unmapped", !hasCoordinates(location));

      const button = document.createElement("button");
      button.type = "button";
      button.innerHTML = `
        <span class="badge ${location.status}">${statusLabels[location.status]}</span>
        <span class="place-name">${escapeHtml(location.name)}</span>
        <span class="place-address">${escapeHtml(formatAddress(location))}</span>
        <span class="place-note">${escapeHtml(location.note)}</span>
      `;
      button.addEventListener("click", () => focusLocation(location));

      item.append(button);
      return item;
    }),
  );
}

function focusLocation(location) {
  if (!hasCoordinates(location)) return;

  const marker = markers.get(location.id);
  map.setView([location.lat, location.lng], 16, { animate: true });
  marker?.openPopup();
}

function popupHtml(location) {
  return `
    <p class="popup-title">${escapeHtml(location.name)}</p>
    <p class="popup-address">${escapeHtml(formatAddress(location))}</p>
    <p class="popup-note">${escapeHtml(location.note)}</p>
  `;
}

function hasCoordinates(location) {
  return Number.isFinite(location.lat) && Number.isFinite(location.lng);
}

function searchableText(location) {
  const aliases = [];

  if (location.region === "District of Columbia") {
    aliases.push("dc", "d.c.", "washington dc", "washington d.c.", "district of columbia");
  }

  return [
    location.name,
    location.address,
    location.city,
    location.region,
    location.country,
    location.note,
    location.source,
    ...aliases,
  ]
    .join(" ")
    .toLowerCase();
}

function matchesSearch(haystack, query) {
  if (!query) return true;
  return query
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

function renderSuggestions() {
  const query = search.value.trim().toLowerCase();

  if (!query) {
    hideSuggestions();
    return;
  }

  suggestionItems = buildSuggestions(query).slice(0, 8);

  if (!suggestionItems.length) {
    hideSuggestions();
    return;
  }

  suggestions.replaceChildren(
    ...suggestionItems.map((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "suggestion";
      button.setAttribute("role", "option");
      button.id = `suggestion-${index}`;
      button.innerHTML = `
        <span class="suggestion-title">${escapeHtml(item.label)}</span>
        <span class="suggestion-meta">${escapeHtml(item.meta)}</span>
      `;
      button.addEventListener("click", () => applySuggestion(item));
      return button;
    }),
  );

  suggestions.hidden = false;
  search.setAttribute("aria-expanded", "true");
}

function hideSuggestions() {
  suggestions.hidden = true;
  suggestions.replaceChildren();
  search.setAttribute("aria-expanded", "false");
}

function applySuggestion(item) {
  search.value = item.value;
  hideSuggestions();
  render();

  if (item.location && hasCoordinates(item.location)) {
    focusLocation(item.location);
  }
}

function buildSuggestions(query) {
  const matches = locations.filter((location) => matchesSearch(searchableText(location), query));
  const groupSuggestions = uniqueSuggestions(
    matches.flatMap((location) => {
      const cityRegion = [location.city, location.region].filter(Boolean).join(", ");
      return [
        {
          key: `city:${cityRegion}`,
          label: cityRegion,
          value: cityRegion,
          meta: "Area",
        },
        {
          key: `region:${location.region}`,
          label: location.region,
          value: location.region,
          meta: location.country || "Region",
        },
      ];
    }),
  ).filter((item) => item.label && matchesSearch(`${item.label} ${item.value} ${item.meta}`.toLowerCase(), query));

  const locationSuggestions = matches.slice(0, 8).map((location) => ({
    key: `place:${location.id}`,
    label: location.name,
    value: location.name,
    meta: formatAddress(location),
    location,
  }));

  return [...groupSuggestions.slice(0, 4), ...locationSuggestions];
}

function uniqueSuggestions(items) {
  const seen = new Set();

  return items.filter((item) => {
    const key = item.key.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatAddress(location) {
  return [location.address, location.city, location.region, location.country].filter(Boolean).join(", ");
}

function escapeHtml(value = "") {
  return value.replace(/[&<>"']/g, (character) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    }[character];
  });
}
