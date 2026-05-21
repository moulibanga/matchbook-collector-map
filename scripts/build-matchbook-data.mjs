import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const HOME_URL = "https://matchbooktraveler.com/";
const CACHE_DIR = new URL("../.cache/", import.meta.url);
const OUTPUT_FILE = new URL("../data/locations.json", import.meta.url);
const GEOCODE_CACHE_FILE = new URL("../.cache/geocode-cache.json", import.meta.url);
const USER_AGENT = "matchbox-map/0.1 contact: local-project";
const PARSE_ONLY = process.argv.includes("--parse-only");

await mkdir(CACHE_DIR, { recursive: true });

const geocodeCache = await readJson(GEOCODE_CACHE_FILE, {});
const pageLinks = await getPageLinks();
const rawLocations = [];

for (const page of pageLinks) {
  const html = await fetchText(page.url);
  const pageLocations = parseLocations(html, page);
  rawLocations.push(...pageLocations);
}

console.log(`Parsed ${rawLocations.length} candidate locations from ${pageLinks.length} pages.`);

if (PARSE_ONLY) {
  const rawOutput = new URL("raw-locations.json", CACHE_DIR);
  await writeFile(rawOutput, `${JSON.stringify(rawLocations, null, 2)}\n`);
  console.log(`Wrote parser preview to ${rawOutput.pathname}`);
  process.exit(0);
}

const locations = [];

for (const [index, location] of rawLocations.entries()) {
  if (index > 0 && index % 50 === 0) console.log(`Geocoded ${index}/${rawLocations.length} candidates...`);

  const query = [location.address, location.city, location.region, location.country].filter(Boolean).join(", ");
  const geocoded = await geocode(query);

  if (!geocoded) {
    console.warn(`No geocode: ${query}`);
    continue;
  }

  locations.push({
    ...location,
    lat: Number(geocoded.lat),
    lng: Number(geocoded.lon),
  });
}

locations.sort((a, b) => a.region.localeCompare(b.region) || a.city.localeCompare(b.city) || a.name.localeCompare(b.name));
await writeFile(OUTPUT_FILE, `${JSON.stringify(locations, null, 2)}\n`);
await writeFile(GEOCODE_CACHE_FILE, `${JSON.stringify(geocodeCache, null, 2)}\n`);

console.log(`Wrote ${locations.length} geocoded locations to ${OUTPUT_FILE.pathname}`);

async function getPageLinks() {
  const html = await fetchText(HOME_URL);
  const links = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis)]
    .map((match) => ({
      url: new URL(match[1], HOME_URL).href,
      title: decodeHtml(stripTags(match[2])).trim(),
    }))
    .filter((link) => link.url.startsWith(HOME_URL) && !["Matchbooktraveler", "Contact", "Links"].includes(link.title));

  return uniqueBy(links, (link) => link.url);
}

function parseLocations(html, page) {
  const heading = decodeHtml(stripTags(html.match(/<h1[^>]*>(.*?)<\/h1>/is)?.[1] || page.title)).trim();
  const contentHtml = extractContent(html);
  const country = inferCountry(heading);
  const region = heading
    .replace(/\s+[–-].*$/, "")
    .replace(/-.*/, "")
    .replace(/-Statewide/i, "")
    .replace(/-Los Angeles/i, "")
    .trim();
  const lines = htmlToLines(markCityHeadings(contentHtml));
  const locations = [];
  let currentCity = inferCityFromHeading(heading);

  for (const line of lines) {
    if (line.startsWith("CITY:")) {
      const cityLine = line.replace(/^CITY:\s*/, "").trim();
      const cityLocation = cityLine.match(/^(.+?)\s+[–-]\s+(.+)$/);

      if (cityLocation) {
        currentCity = cityLocation[1].trim();
        const parsed = parseLine(cityLocation[2], currentCity, region, country, page.url);
        if (parsed) locations.push(parsed);
      } else {
        currentCity = cityLine;
      }

      continue;
    }

    if (!looksLikeLocation(line)) {
      if (isLikelyCityHeading(line, heading)) currentCity = line;
      continue;
    }

    const parsed = parseLine(line, currentCity, region, country, page.url);
    if (parsed) locations.push(parsed);
  }

  return locations;
}

function extractContent(html) {
  const contentStart = html.search(/<div[^>]*class=["'][^"']*\bentry-content\b[^"']*["'][^>]*>/i);
  if (contentStart < 0) return html;

  const articleEnd = html.indexOf("</article>", contentStart);
  return html.slice(contentStart, articleEnd > contentStart ? articleEnd : undefined);
}

function parseLine(line, currentCity, region, country, source) {
  const cleaned = line.replace(/\s+/g, " ").trim();
  const citySplit = cleaned.match(/^([^–-]+)\s+[–-]\s+(.+)$/);
  const body = citySplit ? citySplit[2] : cleaned;
  const city = citySplit ? citySplit[1].trim() : currentCity || inferCityFromRegion(region);
  const chunks = body.split(/\s+[–-]\s+|,\s+report received|;\s+report received|\s+report received|\s+has matches|\s+no matches/i);
  const lead = chunks[0]?.trim();

  if (!lead || !lead.includes(",")) return null;

  const [namePart, ...addressParts] = lead.split(",");
  const name = namePart.replace(/^\*\s*/, "").trim();
  const address = cleanAddress(addressParts.join(","));
  const status = /running low|very low/i.test(cleaned)
    ? "low"
    : /no matches/i.test(cleaned)
      ? "unavailable"
      : "available";

  return {
    id: slug([name, city, region].join("-")),
    name,
    address,
    city,
    region,
    country,
    status,
    note: cleaned,
    source,
  };
}

async function geocode(query) {
  if (geocodeCache[query]) return geocodeCache[query];

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("q", query);

  await sleep(1100);
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`Geocode failed ${response.status}: ${query}`);

  const [result] = await response.json();
  geocodeCache[query] = result || null;
  return geocodeCache[query];
}

async function fetchText(url) {
  const cacheName = slug(url) + ".html";
  const cacheUrl = new URL(cacheName, CACHE_DIR);

  if (existsSync(cacheUrl)) return readFile(cacheUrl, "utf8");

  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`Fetch failed ${response.status}: ${url}`);

  const text = await response.text();
  await writeFile(cacheUrl, text);
  return text;
}

function htmlToLines(html) {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<\/(li|p|h1|h2|h3|div)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function looksLikeLocation(line) {
  return /\b(has|no)\s+(generic\s+)?match|running low|toothpick|mints?/i.test(line) && /\d/.test(line);
}

function markCityHeadings(html) {
  return html
    .replace(
      /<strong\b[^>]*>[\s\S]{0,80}?<em\b[^>]*>(.*?)<\/em>[\s\S]{0,80}?<\/strong>\s*(?:&nbsp;|\s)*(?:&#8211;|&ndash;|–|-)\s*/gi,
      "\nCITY: $1 - ",
    )
    .replace(
      /<strong\b[^>]*>[\s\S]{0,80}?<em\b[^>]*>(.*?)<\/em>[\s\S]{0,80}?<\/strong>/gi,
      "\nCITY: $1\n",
    )
    .replace(
      /<em\b[^>]*>[\s\S]{0,80}?<strong\b[^>]*>(.*?)<\/strong>[\s\S]{0,80}?<\/em>\s*(?:&nbsp;|\s)*(?:&#8211;|&ndash;|–|-)\s*/gi,
      "\nCITY: $1 - ",
    )
    .replace(
      /<em\b[^>]*>[\s\S]{0,80}?<strong\b[^>]*>(.*?)<\/strong>[\s\S]{0,80}?<\/em>/gi,
      "\nCITY: $1\n",
    );
}

function isLikelyCityHeading(line, pageHeading) {
  const ignored = new Set(["Submit", "Search", "Search for:", "Matchbooktraveler", "Menu"]);
  if (line === pageHeading || line === "Restaurants with Matchbooks") return false;
  if (ignored.has(line)) return false;
  if (line.length > 42) return false;
  return /^[A-Z][A-Za-z .'-]+$/.test(line);
}

function cleanAddress(value) {
  const address = value
    .split(";")[0]
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/,\s*(boutique|cannabis|candles?|clothing|coffee|furniture|gifts?|restaurant|salon|smoke shop|stationery store|store|women's apparel|women's clothing).*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/^,|,$/g, "")
    .trim();

  const [street, ...parts] = address.split(",").map((part) => part.trim()).filter(Boolean);
  const keep = parts.filter((part) => {
    return /^(?:N|S|E|W|NE|NW|SE|SW)\.?$/i.test(part) || /^(?:suite|ste\.?|unit|apt\.?|floor|fl\.?|#)/i.test(part);
  });

  return [street, ...keep].join(", ");
}

function inferCountry(region) {
  const canada = new Set(["Alberta", "British Columbia", "Nova Scotia", "Ontario", "Quebec"]);
  const unitedStates = /Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|District|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|Puerto Rico/.test(region);

  if (canada.has(region)) return "Canada";
  if (unitedStates) return "United States";
  return region;
}

function inferCityFromRegion(region) {
  if (/Los Angeles/i.test(region)) return "Los Angeles";
  if (/Chicago/i.test(region)) return "Chicago";
  if (/Detroit/i.test(region)) return "Detroit";
  if (/Las Vegas/i.test(region)) return "Las Vegas";
  if (/Philadelphia/i.test(region)) return "Philadelphia";
  if (/Manhattan|Brooklyn|New York City/i.test(region)) return "New York";
  return "";
}

function inferCityFromHeading(heading) {
  if (/Los Angeles/i.test(heading)) return "Los Angeles";
  if (/Chicago/i.test(heading)) return "Chicago";
  if (/Detroit/i.test(heading)) return "Detroit";
  if (/Las Vegas/i.test(heading)) return "Las Vegas";
  if (/Philadelphia/i.test(heading)) return "Philadelphia";
  if (/Manhattan|Brooklyn|New York City/i.test(heading)) return "New York";
  return "";
}

function stripTags(value) {
  return value.replace(/<[^>]+>/g, " ");
}

function decodeHtml(value) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&rsquo;/g, "'")
    .replace(/&mdash;|&ndash;/g, "-");
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function uniqueBy(items, key) {
  const seen = new Set();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

async function readJson(url, fallback) {
  if (!existsSync(url)) return fallback;
  return JSON.parse(await readFile(url, "utf8"));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
