// osm-api.mjs
// Minimal OpenStreetMap API access: the tags of one node.

const API = 'https://api.openstreetmap.org/api/0.6';

/** Fetches the tags of an OSM node by id. */
export async function fetchNodeTags(nodeId) {
  const response = await fetch(`${API}/node/${nodeId}.json`, {
    headers: { 'User-Agent': 'orm-tools render-node' },
  });
  if (!response.ok) throw new Error(`OSM API: node ${nodeId}: HTTP ${response.status}`);
  const data = await response.json();
  return data.elements?.[0]?.tags ?? {};
}
