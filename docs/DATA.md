# The free data Free Clay uses

## 1. US businesses: 15.5 million places, downloaded once

**Repo:** https://github.com/mertozcetinwd-lab/free-clay-data (public, about 1.2 GB)

15,482,799 US businesses and places in all 50 states and DC, from
[Overture Maps Places](https://docs.overturemaps.org/guides/places/) release `2026-09-23.0`: name,
category, phone, website, email, address, city, state, zip and location, one gzipped CSV folder per
state. Commercial use is allowed.

**Licences:** CDLA Permissive 2.0 (Overture, Meta, Microsoft and others), Apache 2.0 (Foursquare
records), CC0 (AllThePlaces records). **Credit it as:** "Data: Overture Maps Foundation, Overture
Places (CDLA Permissive 2.0)". The Find leads page shows this line under every result list.

**How Free Clay uses it:**

```bash
node dev/get-places.mjs --states FL,GA     # or no --states for every state
npx wrangler deploy
```

`get-places` downloads the state files (cached in `dev/.places-cache`, so a second run is quick),
then cuts them into map tiles in `public/data/places` (adaptive: busy cities get smaller tiles; all
states make 5,898 tiles, 3.1 GB). `wrangler deploy` uploads the tiles as static files, which
Cloudflare's free plan serves at no cost (up to 20,000 files of 25 MiB each). Searching then
happens in the browser: no request leaves your site, and there is no per-search bill.

Other uses of the same files: open a state's CSV in Excel, load it into a database, or search it
with a script.

**Rebuild it yourself** from Overture (for a newer release): the repo's `build/extract.py` and
`build/merge.py` (Python, `pip install pyarrow requests`).

## 2. Live free sources (no key, no bill)

| Source | Used for | Terms to know |
|---|---|---|
| SEC EDGAR | Every US public company (tickers file), company details, Form D and 8-K filings | Needs a contact email in the User-Agent (Settings, Data sources); at most 10 requests a second |
| Wikidata SPARQL | Companies by industry and state | CC0; be gentle with query volume |
| GLEIF | Legal entity identifiers | Free API |
| Greenhouse, Lever, Ashby | Open roles on public job boards | Public board APIs |
| Google News RSS | News signals | Public RSS |
| OpenStreetMap Nominatim | Turning a town name into a map point | Needs a contact email; 1 request a second; results cached 30 days |
| OpenStreetMap Overpass | The OSM source on Find leads | Public servers are often busy; open data is the default for that reason |
| OpenStreetMap tiles | The map background | Attribution shown on the map |

Free Clay sends a User-Agent naming itself (and your contact email where a service asks), caches
answers (Nominatim 30 days, boards a day, companies 7 days), and never scrapes LinkedIn.

## 3. Paid data, on your keys only

People, work emails, phones and company firmographics are not in open data. Free Clay reaches them
through [treg](https://treg.to) (one token, routed across many providers at their own price) or
direct keys (Hunter, Prospeo, Exa, Google Maps). See [KEYS.md](KEYS.md).

Check a business or person before you contact them: listings go out of date. Marketing messages
are regulated (CAN-SPAM, TCPA, state telemarketing rules in the US; GDPR in the EU), and those
duties sit with the sender.
