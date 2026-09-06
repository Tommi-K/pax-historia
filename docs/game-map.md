# Game Map & Rendering

The in-game map is a single MapLibre GL instance (via `react-map-gl/maplibre`) mounted by `src/Game/Map/World.jsx`, with every gameplay layer added as a React child that declares its own `<Source>`/`<Layer>`. All political state flows in from `world.json` (polled every 5s by `useWorldState`) and `colors.json` (the owner→rgb palette); nothing on the map is server-rendered — owners are recoloured, labels rebuilt, and units/markers re-fed from that JSON every poll. The same code renders two ways: a flat Web-Mercator map and a decorative 3D globe (with a real-sun terminator and starfield), switched by the `projection` prop, which remounts the whole `<Map>`.

Everything below is in `src/Game/Map/` unless noted.

---

## 1. Component tree & data sources

`World.jsx` renders one `<Map>` and, inside it, these children (order = paint order, later = on top):

| Child | File | Renders | Primary data in |
|---|---|---|---|
| `<Nations>` | `Nations.jsx` | Country/region fills, borders, disputed stripes, country/owner labels | `world.json` + `colors.json` + PMTiles + `regionsGeojson` |
| `<Cities>` | `Cities.jsx` | City symbols (★/◆/■) + labels | `cities.pmtiles` (stock) or `citiesGeojson` (custom) |
| `<MarkersLayer>` | `MarkersLayer.jsx` | Built structures (bases, silos, embassies…) | `world.markers` |
| `<Units>` | `Units.jsx` | Troop counters (circle + glyph + strength) | `unitsController` (from `world.units`) |
| `<GlobeEffects>` | `GlobeEffects.jsx` | Sun, stars, day/night lighting, auto-rotation (globe only) | wall-clock sun math |
| `<RegionPopup>` / `<CountryInfoPanel>` / `<UnitPopup>` / `<FeaturePopup>` | `../Selection/*` | Selection popups | click events from `Nations.jsx` |

### Shared state hooks

| Hook | File | What it provides |
|---|---|---|
| `useWorldState()` | `useWorldState.js` | Singleton 5s poll of `world.json`; one poll shared by all consumers |
| `useCustomBackground()` | `useCustomBackground.js` | Resolves a scenario's uploaded image/vector basemap from `world.background` |
| `useMapSetting(key)` | `../../runtime/mapSettings.js` | Reactive localStorage map toggles (`hideCountryLabels`, `disableIdleRotation`) |
| `unitsController` | `unitsController.js` | Separate 5s poll of `world.units` + player order mutations |

`useWorldState` is a module-level singleton: `startPolling()` fires one `setInterval(poll, 5000)` reading `JSON_URLS.world`, and all mounted consumers subscribe. It returns a **stable object identity** across polls when nothing it exposes changed (deep/shallow compares each field — arrays like `markers`/`regionClaimants` are `JSON.stringify`-compared) so React children don't re-render on every 5s tick. See [World state](world-state.md) for the `world.json` schema.

Fields `useWorldState` derives from `world.json`:

| Field | Source key | Used by |
|---|---|---|
| `worldKnown` | `Object.keys(state).length > 0` | Gate: stock layers only paint once the world is known |
| `customRegions` (`customFlag`) | `state.customRegions` | Switches stock↔custom render path |
| `customCities` | `state.customCities` | `Cities.jsx` stock↔custom path |
| `basemap` | `state.basemap` | ESRI style variant |
| `background` | `state.background` | Uploaded image/vector basemap descriptor |
| `regionOwnershipOverrides` | `state.regionOwnershipOverrides` | region id → owner name (live conquests) |
| `regionClaimants` | `state.regionClaimants` | region id → claimant list (disputed stripes) |
| `polityOverrides` | `state.polityOverrides` | polity name → `{name, color, aliases}` registry |
| `markers` | `state.markers` | `MarkersLayer.jsx` |
| `labelFont` / `labelHaloColor` / `labelTextColor` | same | Label styling |

> **Note on the `customRegions` flag:** `readRuntimeJsonAsset` / `normalizeRuntimeWorld` forces `customRegions:true` onto every world it serves. In practice the game is *always* on the custom render path (`customFlag` true); the stock-country path (`showStockCountries`) is effectively dead — see [§4](#4-owner-colouring--the-single-resolver) and the `countries-source` note.

---

## 2. `<Map>` setup and key props

Defined in `World.jsx` (`src/Game/Map/World.jsx:286`). The `<Map>` has `key={projection}`, so **toggling globe↔mercator unmounts and remounts the entire map** (and all its GL images — which is why disputed stripe tiles are rebuilt reactively, see [§5](#5-disputed--striped-regions)).

| Prop | Value | Why |
|---|---|---|
| `key` | `projection` | Remount on projection change |
| `initialViewState` | `{longitude:0, latitude:0, zoom:3.5, bearing:0, pitch:0}` | Kept in `viewStateRef` and updated on every `onMove` so a remount restores the camera |
| `minZoom` | `2.25` | Deliberate floor (see [§10](#10-zoom-caps--why-theyre-deliberate)) |
| `maxZoom` | `16` | Deliberate ceiling; PMTiles overzoom past their z8 max |
| `maxBounds` | `[[-Inf,-80],[Inf,85]]` | Lock latitude to the usable band; longitude free (world copies wrap) |
| `doubleClickZoom` | `false` | Double-click is reserved for gameplay |
| `dragRotate` / `touchPitch` / `pitchWithRotate` | `false` | No bearing/pitch — top-down only |
| `dragPan` | on | Pan enabled |
| `cursor` | `"default"` | No grab cursor |
| `attributionControl` | `false` | Hidden |
| `fadeDuration` | `0` | No label cross-fade flicker |
| `collectResourceTiming` | `false` | Skip perf-entry overhead |
| `crossSourceCollisions` | `false` | Symbols from different sources don't fight for placement (cities vs labels vs markers) |
| `renderWorldCopies` | on | Wrap the map E/W infinitely |
| `maxTileCacheSize` | `256` | **Caps per-source retained-tile GPU textures** |
| `projection` | `useMemo(() => ({type: projection}))` | `"globe"` or `"mercator"` |
| `terrain` | memoized (below) | 3D terrain, flat non-custom maps only |
| `mapStyle` | `worldStyle` (`buildWorldStyle(...)`) | Base ESRI/terrain OR custom background |

Handlers: `onMove` → stores `viewState` in `viewStateRef` + `applyDynamicPixelRatio`; `onIdle` → fires `onInitialIdle` once (boot signal) and clears the loading toast; `onLoading` → shows a "Loading tiles…" toast with an 8s safety timeout.

### `maxTileCacheSize={256}` (the OOM cap)

Left unset, MapLibre sizes this cache dynamically to roughly `(ceil(w/256)+1)*(ceil(h/256)+1)*5` tiles **per source** — ~270 at 1080p but ~800 on a 4K viewport. With `renderWorldCopies`, panning E/W feeds successive wrapped world-copy tiles into that cache, so retained GPU textures climb until the tab OOMs. `256` caps the 4K case ~3× while being a no-op on phones. In-view tiles are a separate structure and are never evicted by this, so on-screen tiles are never re-fetched. This is orthogonal to `applyDynamicPixelRatio` (which bounds framebuffer pixels, not tiles).

### Dynamic pixel ratio (`applyDynamicPixelRatio`, `World.jsx:212`)

Zoomed far out, the whole world (every region, border, label) draws at once and native resolution wastes frames on invisible detail. So:

| Zoom | Mode | `map.setPixelRatio(...)` |
|---|---|---|
| ≤ 4.5 | `low` | `min(devicePixelRatio, 1) * 0.75` |
| ≥ 5 | `native` | `window.devicePixelRatio` |
| 4.5–5 | unchanged | hysteresis band to prevent flapping |

Applied on `onMove` **and** `onIdle`, so the soft ratio is in effect from the very first settled frame at world zoom, not only after the first pan.

### `terrain` memo (`World.jsx:197`)

`terrain = { source: "terrain-source", exaggeration: 15 }` **only** when `terrainEnabled && !isGlobe && !customBg && !bgDeclared`. Globe terrain is unsupported by MapLibre and can corrupt the shader cache across projection changes, so it's disabled on the globe and on any custom-background map (which has no terrain source).

---

## 3. The base style (`buildWorldStyle`)

`buildWorldStyle(basemapId, customBg, backgroundDeclared, isGlobe)` (`World.jsx:57`) returns a MapLibre style JSON. It picks **one of four** branches:

| # | Condition | Sources | Layers |
|---|---|---|---|
| 1 | `customBg.kind === "image"` | `custom-bg` (image, corners per `WORLD_IMAGE_COORDS_*`) | `custom-bg-base` (solid `#0b1a2b`), `custom-bg-layer` (raster) |
| 2 | `customBg.kind === "vector"` | `custom-bg-vec` (geojson) | `custom-bg-sea` (bg), `custom-bg-fill` (per-feature `fill`), `custom-bg-line` |
| 3 | `backgroundDeclared` (payload not loaded yet) | none | `custom-bg-loading` (solid `#0b1a2b`) |
| 4 | default (stock world) | ESRI satellite + terrain (below) | satellite + hillshade |

Branches 1–3 **drop ESRI entirely** so a custom-map game never flashes satellite Earth or fires basemap tile requests it won't use. Branch 3 is the pre-load placeholder: `useCustomBackground` flips `declared:true` from the light `world.json` poll *before* the heavy background payload loads.

Every branch sets `sky: { "atmosphere-blend": 0 }` — MapLibre's uniform atmosphere is off because `GlobeEffects` supplies directional surface light instead, and transparent space lets the stars/sun show through the canvas.

### Default stock style (branch 4)

| Source id | Type | Tiles / template | Notes |
|---|---|---|---|
| `satellite-lowres` | raster | `esriTileTemplate(basemapId)` | z0–2 always have real data; `maxzoom:2` |
| `satellite` | raster | `basemapProtocolTemplate(basemapId)` → `ohbase://…` | High-res via the **ohbase protocol** so ESRI "Map Data Not Yet Available" placeholders get replaced with upscaled ancestor tiles; `maxzoom` = the basemap's native max |
| `terrain-source` | raster-dem | `TERRAIN_TILE_TEMPLATE` (AWS terrarium) | `encoding:"terrarium"`, `maxzoom:5` |
| `hillshade-source` | raster-dem | same terrarium tiles | for the `hills` layer |

Layers: `satellite-lowres-layer`, `satellite-layer` (both with `SATELLITE_PAINT` grading — brightness cap, slight desaturation/contrast so it sits against the dark UI), and `hills` (hillshade, exaggeration 0.1). The default basemap is `DEFAULT_BASEMAP_ID = "ocean"`; Settings → Map has a basemap picker (Continuum's), stored in this browser as `map_basemap_style`; empty (the default) keeps the scenario author's background and basemap, and a built-in id replaces both for this player only. `ensureBasemapProtocol()` (called at module load) registers the `ohbase://` protocol handler. Basemap helpers live in `src/runtime/assets.js` (`ESRI_BASEMAPS`, `esriTileTemplate`, `basemapProtocolTemplate`, `basemapMaxZoom`).

### World-image corner coordinates

Two constants (`World.jsx:44`) give the image-source corners:

- `WORLD_IMAGE_COORDS_FLAT` — ±85.0511° (the Mercator projection limit).
- `WORLD_IMAGE_COORDS_GLOBE` — ±89.9° (the globe shows to the poles; **not** exactly ±90 because `mercatorYfromLat(±90)` is ±Infinity and `ImageSource.setCoordinates` throws — the `custom-bg-base` layer fills the negligible sliver).

`styleUsesGlobeCoords = customBg?.kind === "image" && isGlobe` selects between them.

---

## 4. Region & country layers (`Nations.jsx`)

`Nations.jsx` (the `WorldMap` component) declares four sources. The core idea is a **crossfade**: at low zoom, GADM region *fills* come from a coarse seed GeoJSON (`regionsGeojson`); past z6.5 they hand off to crisp stock vector tiles (`regions.pmtiles`). Author-drawn/edited geometry always comes from the GeoJSON, on top.

### 4.1 Sources & layers

| Source id | Type | Data | Gated on | Layers |
|---|---|---|---|---|
| `countries-source` | vector | `PMTILES_PROTOCOL_URLS.countries`, `maxzoom 8` | `!customFlag` | `countries-fill`, `countries-outline` |
| `regions-source` | vector | `PMTILES_PROTOCOL_URLS.regions`, `maxzoom 8` | **never gated** | `regions-fill`, `regions-disputed`, `regions-outline` |
| `custom-regions-source` | geojson | the authored regions URL itself (`regionsGeojsonUrl`, `promoteId: id`, `tolerance 0.6`); live ownership reaches it through feature-state | mounted whenever `customFlag` | `custom-regions-fill-far`, `custom-regions-fill`, `custom-regions-local-outline` |
| `country-curved-label-source` | geojson | `activeCurvedLabelData` | — | `country-curved-labels` |
| `country-point-label-source` | geojson | `activePointLabelData` | — | `country-labels` |

**`countries-source` is dead code by design.** Its `countries-fill` uses `fillStyle`, whose `match` is the only expression that keys on a country **code** (`["get","GID_0"]`). Because `customRegions` is forced true everywhere, `showStockCountries` (`worldKnown && !customFlag`) is always false and the source never mounts. It's left intact (not half-fixed) for a future dead-code sweep. The layer that actually paints the political map is `regions-fill` via `stockRegionsFillPaint`, which matches `GID_1` (a region id) and needs no code→name bridge.

**`regions-source` is NOT gated on `customFlag`** — this is load-bearing. On a re-ownership scenario (Modern Day, Rome, WWII: stock GADM geometry, nothing hand-drawn) `regions-fill` is the *only* thing painting owners above z6.5, because `custom-regions-fill-far` stops at `maxzoom 7` and `FAR_FILL_FADE` has already faded it to 0 by z6.5. Unmounting it once left every such map blank past 6.5 and (via the `getLayer()` filter in the click handler) unclickable too.

### 4.2 The crossfade constants

| Constant | Value | Meaning |
|---|---|---|
| `FAR_FILL_FADE` | interpolate zoom 5.5→0.72, 6.5→0 | seed-GeoJSON fill opacity (fades **out** on zoom in) |
| `TILE_FILL_FADE` | interpolate zoom 5.5→0, 6.5→0.72 | stock-tile fill opacity (fades **in**) |
| `GADM_GEOMETRY_FILTER` | `index-of "." in id >= 0` | GADM region (dotted id like `USA.1_1`) |
| `CUSTOM_GEOMETRY_FILTER` | `index-of "." in id == -1` | author-drawn (`reg_…`, no dot) |
| `AUTHORED_GEOMETRY_FILTER` | `custom OR edited==true` | geometry that lives **only** in the GeoJSON |
| `STOCK_GEOMETRY_FILTER` | `GADM AND edited!=true` | unedited GADM → paints via tiles |

The crossfade band is z5.5–6.5 because the seed geometry was extracted at tile-zoom 5; hand-off happens just past that. The **`edited` split** matters: a GADM region the editor *reshaped* has a dotted id but its true shape is now in the GeoJSON, while the stock tile still carries the *original* shape. Painting both stacks two 0.72 fills and darkens the reshaped area, so edited GADM ids are pulled out of the tile layers (`editedStockIds`, computed in `Nations.jsx:949`) and rendered from the GeoJSON like author-drawn shapes.

### 4.3 Fill / outline paint objects

| Layer | Paint driver | Behaviour |
|---|---|---|
| `regions-fill` | `stockRegionsFillPaint` | `match GID_1 → ownerColorCss(owner)` for every non-drawn, non-edited region; opacity `TILE_FILL_FADE` (0 unless `customActive`) |
| `regions-outline` | `buildProvinceOutlinePaint` | Stock-world province hairlines only (`worldKnown && !customActive`); hidden through z6.5, then fade in; excludes `editedStockIds`. Shares the scenario-grid style below. |
| `custom-regions-fill-far` | `["get","_fillColor"]` | seed-GeoJSON fill for GADM regions, `maxzoom 7`, opacity `FAR_FILL_FADE` |
| `custom-regions-fill` | `["get","_fillColor"]` | author-drawn/edited geometry, opacity constant `0.72` at all zooms |
| `custom-regions-local-outline` | `buildProvinceOutlinePaint` | Scenario province grid (`customActive && worldKnown`): hidden through z6.5; opacity `6.5→0, 7.5→0.25, 10→0.38, 12→0.45`; width `6.5→0.25, 8→0.4, 12→0.5` CSS px, capped above z12. Country/frontier strokes stay visible, and fill-based province selection is unchanged. |

`_fillColor` is carried by the dissolved polity surfaces (`enrichedPolitySurfaceData`). The authored regions source is the URL itself — nothing on the UI thread parses or clones the regions file — and live ownership reaches it through `setFeatureState` (`fillColor`), so an ownership change is a tiny state diff rather than a GeoJSON replacement.

---

## 5. Owner colouring — the single resolver

There is **one** owner→rgb resolver, `resolveOwnerRgb(owner)` (`Nations.jsx:727`), used by every paint path (region fills, stripes, and — via `ownerColorCss` — labels). Owners are **names now** (`"Russia"`, `"Roman Empire"`), not GADM codes. Resolution order:

1. `colorMap[owner]` — exact hit in `colors.json` (loaded by `getNationColors`).
2. `parseColorToRgb(polityOverrides[owner].color)` — the live polity registry from `world.json` (stores CSS strings; `colors.json` stores `[r,g,b]` triplets, so `parseColorToRgb` bridges the two namespaces).
3. Case/diacritic/punctuation-folded match (`ownerFoldKey`) against `colorMap` keys, then against `polityOverrides` keys **and their `aliases`**.
4. `fallbackRgbFromOwner(owner)` — a procedural hash of the first three A–Z letters.

The two-namespace merge is the whole point: a polity can be correctly *named* by the registry while `colors.json` has no key for it (shipped example: "British Empire" owns 426 regions in `world-war-ii-1939-copy` with its colour only in `polityOverrides`). Resolving the name but not the colour painted those regions a muddy procedural fallback — reading to players as "the map didn't annex it."

`ownerColorCss(owner)` wraps it into a `rgb(...)` string (or `NEUTRAL_LAND_COLOR`). `fallbackRgbFromOwner` strips to A–Z first so accented/two-word names hash usefully instead of collapsing to a dark corner; it's the JS twin of `buildFallbackColorExpression` (which still hashes the *code* off the stock tiles, because tile properties are baked GADM and never become names).

### Palette live-reload

`colors.json` can be rewritten mid-game (every AI turn, or the faction creator writing the player's colour). `getNationColors` memoizes on the scenario token and won't see a runtime write, so the asset layer dispatches a `oh:colors-updated` window event on write; `Nations.jsx` listens (`colorsEpoch`) and re-reads. `shallowEqualColors` guards against swapping in a fresh object with identical contents, which would needlessly rebuild every MapLibre match expression.

---

## 6. Disputed / striped regions

A region whose `claimants` list names contesting countries renders **diagonally striped** in their colours (current administrator's band first).

| Piece | Location | Role |
|---|---|---|
| `stripeImageId(rgbList)` | `Nations.jsx:158` | Encodes the rgb list into an image id: `oh-stripes-r_g_b-r_g_b…` |
| `parseStripeImageId(id)` | `Nations.jsx:160` | Decodes it back |
| `buildStripeImage(rgbList)` | `Nations.jsx:173` | Raw RGBA diagonal-stripe tile; band = `(x+y) mod period` (tiles seamlessly), `STRIPE_BAND_PX = 8` |
| `styleimagemissing` handler | `Nations.jsx:512` | On demand, builds and `addImage`s any stripe tile the style asks for |

Because the image id **encodes its own colours**, the `styleimagemissing` handler can rebuild *any* combination — including after a globe↔mercator remount wipes all GL images. This is why stripes are reactive rather than pre-registered.

Claimants come from `world.regionClaimants[id]` first (how the modern-world scenario declares disputes, since its geometry is an immutable seed), else the region feature's own `claimants` prop (editor maps). `enrichedCustomRegionData` bakes a `_stripes` property (the image id) onto disputed features; layers select on `["has","_stripes"]` and paint with `fill-pattern` instead of the solid fill:

- `custom-regions-disputed-vnext` — the worker's `disputedData` (every claimant-carrying region with its live owner and claimants), striped at `0.90` whenever `customActive && worldKnown`.
- `regions-disputed` — the tile twin for GADM disputed regions (uses `disputedTileStops`, opacity `TILE_FILL_FADE`), excluding `editedStockIds`.

`DISPUTED_TERRITORY_CLAIMANT` (`Nations.jsx:338`) maps GADM's `Z01`–`Z09` disputed codes (Kashmir, Aksai Chin, Arunachal Pradesh…) to a claimant country so the map shows `"Disputed (India)"` instead of a bare `"Z01"` label.

---

## 7. Country / owner labels

Two label render paths, selected by the world flag:

| State | Point labels | Curved labels |
|---|---|---|
| `!worldKnown` | empty | empty (no flash before load) |
| `customFlag` (custom map) | `ownerLabelData` (per-owner) | empty |
| stock world | `pointLabelData` | `curvedLabelData` |

### Stock labels — `src/runtime/countryLabels.js`

`loadCountryLabelCollections({ force, ownedCodes })` reads the **z0 tile** of `countries.pmtiles`, decodes it, and for each country builds either a **curved** multi-glyph label (one Point feature per letter, following the country's principal axis — `buildCurvedLabelPath` + `buildCurvedLabelGlyphFeatures`) or a single **point** label when the shape is too compact/round to curve text along. Names run through `resolveCountryDisplayName` + `translateLabel` (labels are baked into map features, not DOM, so they must be pre-translated). `ownedCodes` filters out countries owning no territory this scenario (so modern names don't float over medieval land). Results are cached in runtime JSON, keyed on `tile-hash + byteLength + archiveUrl + language + owner-set` (`COUNTRY_LABELS_CACHE_KEY = "country-labels-v3"`; an empty build is served once but never cached, since an empty z0 read is almost always a degraded tile, not a label-less world).

### Owner labels for custom maps — `buildOwnerLabelCollection` (`Nations.jsx:343`)

The stock pipeline labels *modern* countries, which is wrong on scenario maps (it printed "Russia"/"Ukraine" over the USSR). Instead, one label per **owner per contiguous landmass**:

1. `buildRegionAdjacency` (`Nations.jsx:278`) — which regions physically touch, by hashing every vertex on a ~11 m (`1e-4°`) grid. Geometry-only, so it's memoized per world and survives ownership changes.
2. Union-find groups same-owner **adjacent** regions into one territory each. Contiguity (not distance) is what keeps a colony separate from its metropole (France's mainland vs French West Africa) while keeping a touching chain like Siberia a single label.
3. `mergeOwnerClusters` then does a small centroid mop-up (`CLUSTER_JOIN_DEGREES = 10`) to fold islands into nearby mainland and heal adjacency near-misses.
4. Each cluster becomes a Point feature named by `polityOverrides[owner].name || countryNameByCode.get(owner) || owner`, run through `resolveCountryDisplayName` + `translateLabel`, uppercased. Every owner keeps its largest cluster; extra clusters must clear `MIN_CLUSTER_AREA = 1.5` (deg²).

`ownerLabelData` recomputes as `regionOwnershipOverrides` poll in, so **labels follow conquests**. A `labelEpoch` (bumped on the `i18n:updated` event) forces a rebuild when translations land.

### Label layers & styling

Both label sources feed `type:"symbol"` layers (`country-labels`, `country-curved-labels`). Shared config:

| Property | Value |
|---|---|
| `text-font` | `labelFontStack` = `[world.labelFont || "Georgia", "Georgia", "Times New Roman", "Palatino Linotype", "serif"]` (drawn locally as a CSS font-family — MapLibre v5 has no glyphs endpoint here) |
| `text-size` | `buildCountryTextSize(mult, isGlobe, prop)` — exponential-in-zoom with a stop at every integer zoom, each the uncapped size, so the two sizes MapLibre mixes per tile are exactly 2× apart and a label doubles with the map. MapLibre itself clamps glyphs at 255 px, so `buildCountryTextOpacity` keys each layer's `text-opacity` to the same size expression and fades a label out between 140 and 230 px, on top of the layer's zoom ramp (z5.8–z7.1) |
| `text-color` / `text-halo-color` | `world.labelTextColor || "#FFFFFF"` / `world.labelHaloColor || "rgba(0,0,0,0.5)"` |
| `text-opacity` | interp zoom `5→0.75, 8→0` (labels fade out as you zoom in and cities take over) |
| `visibility` | `none` when `hideCountryLabels` map setting is on |
| `text-pitch/rotation-alignment` | `"map"`, `text-keep-upright:false` |

**Globe text-size fix (issue #6):** globe projection oversizes a label's own high-latitude text relative to its outline. `GLOBE_LAT_CORRECTION = cos(feature.lat * π/180)` undoes it, applied via `buildCountryTextSize(..., correctForGlobe=true)` **only** in globe mode (the factor is visibly wrong in Mercator at high latitude). Every label feature carries its own `lat` for this — the reason `countryLabels.js` bumped its cache to `v3`.

---

## 8. Cities & markers

### Cities — `Cities.jsx`

`<Cities>` picks a path from `world.customCities`:

| Path | Source | Visibility filter | Sort |
|---|---|---|---|
| `StockCities` | `cities.pmtiles` (vector, layer `cities`) | `populationFilter` — capitals always; else population thresholds that step down as you zoom (2.5M at z<5 → 100k at z8+) | by population |
| `CustomCities` | `citiesGeojson` (geojson) | `customTierFilter` — authored tier: 4=capital, 3=major, 2=city (z≥4.3), 1=town (z≥5.8) | `customSortKey` (tier then population) |

Custom scenarios never show the 70k modern database (anachronistic), and while the custom set loads they render nothing rather than flash modern names. Both paths use the same visual language and the same two layers (`minzoom 3.4`):

- `cities-shapes` — a glyph per city: `★` capital / `◆` major / `■` other (transparent text, white halo, so only the outline shows).
- `cities-labels` — the city name (`Open Sans Semibold`, white with dark halo, variable anchor).

### Markers (built structures) — `MarkersLayer.jsx`

Fed from `world.markers` (structures founded during play — bases, silos, embassies…). Each valid marker (`Number.isFinite(lng/lat) && name`) becomes a Point feature. Shape by keyword: `MILITARY_KIND` regex → `▲`, else `■`. Colour by owner via `ownerColorString(colorMap, ownerCode)` (from `getNationColors`; unowned = neutral parchment `rgb(226,222,205)`). Two layers: `markers-shapes` (glyph, owner-coloured) and `markers-labels` (`minzoom 2.6`).

---

## 9. Units (troops)

### Render — `Units.jsx`

`units-source` (geojson) is fed from `unitsController.getUnits()`. Each unit → a Point feature with a `TYPE_GLYPH` (`infantry:I, armor:A, air:F, naval:N, artillery:G, garrison:C`) and an owner colour. Three stacked layers:

| Layer | Type | Encodes |
|---|---|---|
| `units-fill` | circle | owner colour; radius scales with zoom |
| `units-icons` | symbol | the type glyph |
| `units-strength` | symbol | numeric strength, offset below (`minzoom 3`) |

Status drives styling — **pending** (player-requested, not yet AI-confirmed) units are translucent (`circle-opacity 0.32`) with a blue stroke; **moving** = amber stroke; **engaged** = red stroke; else white.

### Controller — `unitsController.js`

A module-level store, separate from `useWorldState` but with the same 5s cadence (`startUnitsSync`). It holds `units`, `playerCode`, `round`, `gameDate`, `allowedUnitTypes`, and an `interactionMode` (`idle | deploy | move | attack`), plus a `subscribeUnits` pub/sub the map/popups/Forces panel listen to.

| Function | Effect | Instant feedback | AI hand-off |
|---|---|---|---|
| `deployUnit` | Add a `pending` unit (translucent) | placed locally | queues a "Deploy request" order; revert = remove |
| `moveUnitTo` | Within era/type leash → move + `moving`; beyond `moveLeashKm` → stay put, `moving` | snaps or holds | queues Move / Long-range order |
| `attackWith` | In `engagementRangeKm` → `resolveClash` (seeded, instant); out of range → approach order | strength/positions update, losers filtered out | queues Attack order (`regionTransfer` hint) |
| `attackFeature` | Attack a city/marker; no local clash — positional only | closes on objective, reads `engaged` | queues assault order (`markerOps`/`regionTransfer` hints) |

Player deploy is purely local; move/attack write to `world.units` immediately **and** queue a machine-readable `action` (via `queueOrder`) so the AI honours/contests them on the next time-jump. `queueOrder` records a `unitRevert` so deleting the queued action before the jump undoes the on-map change (#368). Combat maths (`resolveClash`, `distanceKm`, `engagementRangeKm`, `moveLeashKm`) live in `unitCombat.js`. `busy` suppresses the poll from clobbering an in-flight commit.

### Interaction dispatch — `Nations.jsx` `handleRegionClick`

The map's single `click` handler (`Nations.jsx:564`) routes by `getInteractionMode()`:

- **deploy/move/attack modes** intercept the click as a *target* (`deployUnit` / `moveUnitTo` / `attackWith` or `attackFeature`), then `clearInteractionMode()`.
- **normal click** priority: unit (`units-fill`) → feature (`markers-shapes` > `cities-shapes`/`cities-labels`) → region. Region query uses `["custom-regions-fill","custom-regions-fill-far"]` on drawn-geometry maps but `["custom-regions-fill","regions-fill"]` on re-ownership maps (so a click on fantasy ocean resolves to nothing, not the leftover real country underneath — `hasDrawnGeometry`). The resolved region is handed to `onRegionSelected` with the **owner name** resolved (via `ownerLookupRef`), the underlying GADM `gid0` kept as a flag fallback.

The staged-reveal system (`setUnitsOverride` / `setWorldStateOverride`) lets the map show units/world as of the last revealed event during a turn's event playback, snapping back to live state when cleared (see [World state](world-state.md) and the turn/time system).

---

## 10. The decorative globe (`GlobeEffects.jsx`)

Active only when `projection === "globe"` (`active` prop). It drives four things, all outside MapLibre's own render: the sun sprite (`#oh-globe-sun`), the starfield canvas (`#oh-globe-stars`), the day/night lighting canvas (`#oh-globe-lighting`), and idle auto-rotation. Those DOM elements are declared in `World.jsx` around the transparent `<Map>` canvas so the globe provides correct sun occlusion.

- **Real sun:** `sunWorldPosition = subsolarPoint()` — the actual subsolar point for the current wall clock (seasonal declination + Earth's rotation). Moving the camera changes perspective without sliding light across the countries; the terminator matches the planet outside your window. `LIVE_SUN_REFRESH_MS = 60_000` refreshes it even when the map is fully idle.
- **Auto-rotation:** `ROTATION_DEG_PER_MS = 360 / (10 min)`. Disabled by the `disableIdleRotation` map setting, and interrupted by any drag/zoom/pointerdown.
- **Aggressive idle throttling (the main perf lever):** while actively dragging/zooming, sun+lighting+stars redraw at 60 fps; while idle (including auto-rotate) they drop to ~15 fps (`*_FRAME_MS_IDLE`), and the auto-rotate `jumpTo` itself steps at 15 fps (`IDLE_ROTATE_FRAME_MS`) using real elapsed time so rotation *speed* is unchanged. Idle auto-rotate previously forced a full MapLibre re-render + from-scratch lighting repaint 60×/s forever — this was cooking phones.
- **Projection morph:** the globe↔mercator morph fades stars/lighting via `projectionTransition` (1 on settled globe, 0 on flat, between only mid-fade). The morph fires no map "move" event, so `isMorphing` forces full-rate redraws during the fade; only the settled globe throttles.
- **WebGL context loss** is handled: on `webglcontextlost` it cancels the rAF loop and releases the canvases; on restore it resyncs and resets the rotation clock so the first tick doesn't jump the globe by the whole lost interval.

Sun/star/lighting math is in `globeSunMath.js`, `globeCanvasLighting.js`, `globeCelestialCanvas.js` (with `globeLightingPixels.js`, `globeCelestialCanvas.js`, `globeSunMath.js`).

---

## 11. Zoom caps & why they're deliberate

| Cap | Where | Rationale |
|---|---|---|
| `minZoom 2.25` | `<Map>` | World-view floor |
| `maxZoom 16` | `<Map>` | Camera ceiling; past PMTiles' z8 the tiles overzoom |
| `maxBounds` lat `-80…85` | `<Map>` | Keep the camera in the usable latitude band |
| PMTiles `maxzoom 8` | `countries-source`, `regions-source` | **Not the archive's z10.** `extract-regions.mjs` can't stitch a z10 seed (dies in `JSON.stringify` past V8's 512 MB max string); z9's 4.1 M vertices OOM'd the editor renderer; z8's 2.6 M is stable — and rendering finer than the editor can author only draws detail no map can be built against. MapLibre overzooms past z8. |
| `custom-regions-fill-far maxzoom 7` | seed-GeoJSON far layer | Stops just past the z5.5–6.5 crossfade; the stock tiles own the crisp zoom |
| Crossfade band z5.5–6.5 | `FAR_FILL_FADE`/`TILE_FILL_FADE` | Seed extracted at tile-zoom 5; hand off just past it |
| Pixel-ratio switch z4.5 / z5 | `applyDynamicPixelRatio` | Soften the whole-world view; hysteresis prevents flapping |
| Cities `minzoom 3.4`, city thresholds step by zoom | `Cities.jsx` | Thin out symbols as you zoom out |
| Label `text-opacity` fades to 0 by z8 | `labelLayerPaint` | Country/owner labels hand the screen to city labels on zoom in |
| Markers labels `minzoom 2.6` | `MarkersLayer.jsx` | Structure names appear slightly earlier than cities |

---

## 12. Data-flow summary

```
world.json ──(useWorldState, 5s)──► customRegions, regionOwnershipOverrides,
   │                                 regionClaimants, polityOverrides, markers,
   │                                 labelFont/Color, basemap, background, units
   │
   ├─► Nations.jsx ──► polity boundary worker (dissolved surfaces, frontiers, disputed data)
   │                   live polity labels (buildPolityLabelCollections; follow conquests)
   │                   stockRegionsFillPaint (GID_1 → owner colour)
   │
   ├─► useCustomBackground ──► buildWorldStyle (image/vector/placeholder/ESRI)
   ├─► MarkersLayer ──► markers-source
   └─► unitsController (own 5s poll of world.units) ──► Units.jsx / popups

colors.json ──(getNationColors, oh:colors-updated event)──► colorMap
   └─► resolveOwnerRgb ──► every fill / stripe / label / marker / unit colour

regionsGeojson / citiesGeojson ──(readJson, force)──► custom region & city geometry
countries.pmtiles / regions.pmtiles / cities.pmtiles ──► stock tile geometry
   └─► countryLabels.js (z0 countries tile) ──► point + curved stock labels
```

Every owner recolour, label rebuild, and unit/marker update is a consequence of a `world.json` (or `colors.json`) change surfacing through the 5s polls — there is no push channel; the map is a pure function of that polled state plus the static per-scenario geometry.

### Cross-references

- [World state](world-state.md) — the `world.json` schema, `regionOwnershipOverrides`, `polityOverrides`, `regionClaimants`, `markers`, `units`, staged-reveal overrides.
- Runtime asset layer (`src/runtime/assets.js`) — `JSON_URLS`, `PMTILES_PROTOCOL_URLS`, the `ohbase://` protocol, `getNationColors`, `resolveCountryDisplayName`, scenario-token cache sweeping.
- Selection popups (`src/Game/Selection/*`) — consumers of `onRegionSelected` / `onFeatureSelected` / `onUnitSelected`.

## Readiness signals

`src/runtime/mapReadiness.js` records two things on `window.__OH_MAP_READINESS__` and dispatches them as events: `oh:map-polities-ready` (Nations.jsx, with the regions asset URL the polity layers were built for — after the boundary worker answers or fails, or at once on a stock map) and `oh:map-idle` (World.jsx, every idle). The loading screen a game opens under (`GameUI/gameLoadingScreen.jsx`) waits for the first, then for the next idle.
