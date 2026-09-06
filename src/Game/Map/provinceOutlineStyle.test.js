/*! Open Historia — province outline regression tests © 2026 Nicholas Krol, MIT (see src/Editor/LICENSE). */
import test from "node:test";
import assert from "node:assert/strict";
import { createPropertyExpression, latest, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { buildProvinceOutlinePaint, PROVINCE_OUTLINE_MIN_ZOOM } from "./provinceOutlineStyle.js";

// Evaluate the real paint expressions with MapLibre, not a second implementation
// of interpolation: invalid camera expressions should fail here, not at runtime.
const evaluate = (paint, property, zoom) => {
  const compiled = createPropertyExpression(paint[property], latest.paint_line[property]);
  assert.equal(compiled.result, "success", JSON.stringify(compiled.value));
  return compiled.value.evaluate({ zoom });
};

test("province paint is valid for both GeoJSON and stock vector layers", () => {
  const errors = validateStyleMin({
    version: 8,
    sources: {
      authored: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      stock: { type: "vector", tiles: ["https://example.com/{z}/{x}/{y}.pbf"] },
    },
    layers: [
      { id: "authored", type: "line", source: "authored", minzoom: PROVINCE_OUTLINE_MIN_ZOOM, paint: buildProvinceOutlinePaint(true) },
      { id: "stock", type: "line", source: "stock", "source-layer": "regions", minzoom: PROVINCE_OUTLINE_MIN_ZOOM, paint: buildProvinceOutlinePaint(true) },
    ],
  });
  assert.deepEqual(errors, []);
});

test("overview has no province strokes, including the start of the fade", () => {
  const paint = buildProvinceOutlinePaint(true);
  assert.equal(PROVINCE_OUTLINE_MIN_ZOOM, 6.5);
  for (const zoom of [0, 2.25, 3.5, 4.2, 5, 6, 6.49, 6.5]) {
    assert.equal(evaluate(paint, "line-opacity", zoom), 0, `zoom ${zoom}`);
  }
});

test("local grid fades in smoothly and stays subpixel through maximum zoom", () => {
  const paint = buildProvinceOutlinePaint(true);
  let previous = 0;
  for (let zoom = PROVINCE_OUTLINE_MIN_ZOOM; zoom <= 24; zoom += 0.05) {
    const opacity = evaluate(paint, "line-opacity", zoom);
    const width = evaluate(paint, "line-width", zoom);
    assert.ok(opacity >= previous && opacity <= 0.45);
    assert.ok(opacity - previous < 0.02, `no opacity jump at ${zoom}`);
    assert.ok(width >= 0.25 && width <= 0.5, `hairline at ${zoom}`);
    previous = opacity;
  }
  assert.equal(evaluate(paint, "line-opacity", 7.5), 0.25);
  assert.equal(evaluate(paint, "line-width", 16), 0.5);
});

test("inactive or not-yet-known worlds never show province strokes", () => {
  const paint = buildProvinceOutlinePaint(false);
  for (const zoom of [0, 3.5, 6.5, 8, 12, 16, 24]) {
    assert.equal(evaluate(paint, "line-opacity", zoom), 0);
  }
});
