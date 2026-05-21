import { readFile, writeFile } from "node:fs/promises";

const rawLocations = JSON.parse(await readFile(new URL("../.cache/raw-locations.json", import.meta.url), "utf8"));
const geocodedLocations = JSON.parse(await readFile(new URL("../data/locations.json", import.meta.url), "utf8"));
const geocodedByKey = new Map(geocodedLocations.flatMap((location) => keysFor(location).map((key) => [key, location])));

const mergedRaw = rawLocations.map((location) => {
  const geocoded = keysFor(location).map((key) => geocodedByKey.get(key)).find(Boolean);
  if (!geocoded) return location;

  return {
    ...location,
    lat: geocoded.lat,
    lng: geocoded.lng,
  };
});

const seen = new Set(mergedRaw.flatMap(keysFor));
const extras = geocodedLocations.filter((location) => {
  const duplicate = keysFor(location).some((key) => seen.has(key));
  keysFor(location).forEach((key) => seen.add(key));
  return !duplicate;
});
const locations = [...mergedRaw, ...extras].sort((a, b) => {
  return a.country.localeCompare(b.country) || a.region.localeCompare(b.region) || a.city.localeCompare(b.city) || a.name.localeCompare(b.name);
});

await writeFile(
  new URL("../data/locations.js", import.meta.url),
  `window.MATCHBOX_LOCATIONS = ${JSON.stringify(locations, null, 2)};\n`,
);

console.log(`Wrote ${locations.length} locations to data/locations.js`);

function keysFor(location) {
  return [
    cleanKey([location.id]),
    cleanKey([location.name, location.city, location.region, location.country]),
    cleanKey([location.name, location.address, location.region, location.country]),
  ];
}

function cleanKey(parts) {
  return parts
    .filter(Boolean)
    .join("|")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w|]+/g, "");
}
