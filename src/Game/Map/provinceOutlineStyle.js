/*! Open Historia — province outline presentation © 2026 Nicholas Krol, MIT (see src/Editor/LICENSE). */

// Provinces are local detail, not the political silhouette. Keep the overview
// free of the administrative grid, then fade it in as country labels yield to
// local detail. A zero-opacity first stop avoids a pop at the layer's minzoom.
// Share the policy between stock tiles and scenario geometry so switching map
// kinds cannot bring back the early, heavy grid. Country/frontier layers and
// the fill layers used for hit-testing deliberately do not use this policy.
export const PROVINCE_OUTLINE_MIN_ZOOM = 6.5;

const PROVINCE_OUTLINE_WIDTH = [
  "interpolate", ["linear"], ["zoom"],
  PROVINCE_OUTLINE_MIN_ZOOM, 0.25,
  8, 0.4,
  12, 0.5,
];
const PROVINCE_OUTLINE_OPACITY = [
  "interpolate", ["linear"], ["zoom"],
  PROVINCE_OUTLINE_MIN_ZOOM, 0,
  7.5, 0.25,
  10, 0.38,
  12, 0.45,
];

export const buildProvinceOutlinePaint = (active) => ({
  "line-color": "rgba(8, 12, 18, 0.90)",
  // MapLibre measures line-width in CSS pixels; cap it at a hairline even at
  // maximum zoom, rather than letting the province grid rival state borders.
  "line-width": PROVINCE_OUTLINE_WIDTH,
  "line-opacity": active ? PROVINCE_OUTLINE_OPACITY : 0,
});
