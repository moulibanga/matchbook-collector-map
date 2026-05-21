import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const CACHE_DIR = new URL("../.cache/", import.meta.url);
const RAW_FILE = new URL("../.cache/raw-locations.json", import.meta.url);
const OUTPUT_FILE = new URL("../data/locations.json", import.meta.url);
const GEOCODE_CACHE_FILE = new URL("../.cache/geocode-cache.json", import.meta.url);
const USER_AGENT = "matchbox-map/0.1 contact: local-project";

const [field = "region", value = "District of Columbia"] = process.argv.slice(2);

await mkdir(CACHE_DIR, { recursive: true });

const rawLocations = JSON.parse(await readFile(RAW_FILE, "utf8"));
const existingLocations = existsSync(OUTPUT_FILE) ? JSON.parse(await readFile(OUTPUT_FILE, "utf8")) : [];
const geocodeCache = existsSync(GEOCODE_CACHE_FILE) ? JSON.parse(await readFile(GEOCODE_CACHE_FILE, "utf8")) : {};
const byId = new Map(existingLocations.map((location) => [location.id, location]));
const selected =
  field === "all"
    ? rawLocations
    : rawLocations.filter((location) => String(location[field] || "").toLowerCase() === value.toLowerCase());

console.log(field === "all" ? `Geocoding all ${selected.length} locations` : `Geocoding ${selected.length} locations where ${field} is ${value}`);

let addedSinceCheckpoint = 0;
let checked = 0;
let failed = 0;

for (const [index, location] of selected.entries()) {
  checked += 1;

  if (hasCoordinates(byId.get(location.id))) {
    if (checked % 100 === 0) await checkpoint(`Checked ${checked}/${selected.length}; ${mappedCount()} mapped so far`);
    continue;
  }

  const query = geocodeQuery(location);
  const result = await geocodeWithRetry(query, geocodeCache);

  if (!result) {
    failed += 1;
    console.warn(`No geocode: ${query}`);
    if (checked % 100 === 0) await checkpoint(`Checked ${checked}/${selected.length}; ${mappedCount()} mapped so far`);
    continue;
  }

  byId.set(location.id, {
    ...location,
    lat: Number(result.lat),
    lng: Number(result.lon),
  });

  addedSinceCheckpoint += 1;
  console.log(`${index + 1}/${selected.length}: ${location.name}`);

  if (addedSinceCheckpoint >= 25) {
    await checkpoint(`Checked ${checked}/${selected.length}; ${mappedCount()} mapped so far`);
    addedSinceCheckpoint = 0;
  }
}

await checkpoint(`Done. Checked ${checked}/${selected.length}; ${mappedCount()} mapped; ${failed} misses`);

async function checkpoint(message) {
  const locations = sortedLocations();

  await writeFile(OUTPUT_FILE, `${JSON.stringify(locations, null, 2)}\n`);
  await writeFile(GEOCODE_CACHE_FILE, `${JSON.stringify(geocodeCache, null, 2)}\n`);

  const exportResult = spawnSync(process.execPath, ["scripts/export-data-js.mjs"], {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
  });

  if (exportResult.status !== 0) {
    throw new Error(exportResult.stderr || exportResult.stdout || "Could not export data/locations.js");
  }

  console.log(`${message}. Wrote ${locations.length} geocoded locations.`);
}

function sortedLocations() {
  return [...byId.values()].sort((a, b) => {
    return a.country.localeCompare(b.country) || a.region.localeCompare(b.region) || a.city.localeCompare(b.city) || a.name.localeCompare(b.name);
  });
}

function mappedCount() {
  return [...byId.values()].filter(hasCoordinates).length;
}

function hasCoordinates(location) {
  return Number.isFinite(location?.lat) && Number.isFinite(location?.lng);
}

function geocodeQuery(location) {
  return [
    location.address,
    geocodeCity(location),
    location.region,
    location.country,
  ]
    .filter(Boolean)
    .join(", ");
}

function geocodeCity(location) {
  if (location.region === "District of Columbia") return "Washington";
  if (location.region === "New York" && location.city === "South of Houston Street") return "New York";
  return location.city;
}

async function geocode(query, cache) {
  if (Object.hasOwn(cache, query)) return cache[query];

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("q", query);

  await sleep(1100);
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`Geocode failed ${response.status}: ${query}`);

  const [result] = await response.json();
  cache[query] = result || null;
  return cache[query];
}

async function geocodeWithRetry(query, cache) {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await geocode(query, cache);
    } catch (error) {
      if (attempt === maxAttempts) throw error;

      const waitMs = attempt * 5000;
      console.warn(`Geocode error, retrying in ${waitMs / 1000}s: ${query}`);
      await checkpoint(`Network retry checkpoint after ${mappedCount()} mapped`);
      await sleep(waitMs);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
