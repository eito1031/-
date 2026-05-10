/**
 * 使い方: node geocode.mjs
 * public/customers.json の lat:null のエントリを Nominatim でジオコーディングして上書きします。
 */
import { readFileSync, writeFileSync } from "fs";

const customers = JSON.parse(readFileSync("public/customers.json", "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function geocode(address) {
  const url =
    "https://nominatim.openstreetmap.org/search?" +
    new URLSearchParams({ q: address, format: "json", limit: 1, countrycodes: "jp" });
  const res = await fetch(url, {
    headers: { "User-Agent": "routeopt-geocoder/1.0" },
  });
  const data = await res.json();
  if (data.length > 0) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  return null;
}

let updated = 0, failed = [];
for (const c of customers) {
  if (c.lat !== null || !c.address) continue;
  await sleep(1200); // Nominatim rate limit: 1 req/sec
  const result = await geocode(c.address);
  if (result) {
    c.lat = result.lat;
    c.lng = result.lng;
    console.log(`✓ ${c.name}: ${result.lat}, ${result.lng}`);
    updated++;
  } else {
    console.log(`✗ ${c.name}: 取得失敗`);
    failed.push(c.name);
  }
}

writeFileSync("public/customers.json", JSON.stringify(customers, null, 2), "utf8");
console.log(`\n完了: ${updated}件更新`);
if (failed.length) console.log(`失敗: ${failed.join(", ")}`);
