# Matchbox Map
An interactive map of places that give out branded matchbooks, matchboxes, toothpicks, or mints!

The current location list is from [Matchbook Traveler](https://matchbooktraveler.com/). 

## Run locally

Open `index.html` in a browser, or run a tiny static server:

```sh
python3 -m http.server 5173
```

Then visit `http://localhost:5173`.

## Rebuild the location data

The Matchbook Traveler pages list place names and addresses, but not coordinates. This script fetches the public pages, parses likely location rows, and geocodes addresses through Nominatim:

```sh
node scripts/build-matchbook-data.mjs
```

To refresh the browser-ready data file after parsing or geocoding:

```sh
node scripts/export-data-js.mjs
```

For a public project that mirrors the full Matchbook Traveler dataset, ask the site owner for permission and offer a link back/correction workflow.
