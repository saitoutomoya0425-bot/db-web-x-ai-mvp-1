import { performance } from "node:perf_hooks";

const sizes = process.argv.slice(2).map(Number).filter((value) => Number.isInteger(value) && value > 0);
const targets = sizes.length ? sizes : [1_000, 10_000, 100_000];
const normalize = (value) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");

function measure(label, action) {
  const start = performance.now();
  const result = action();
  return { label, milliseconds: Number((performance.now() - start).toFixed(3)), matches: result };
}

for (const size of targets) {
  const memoryBefore = process.memoryUsage().heapUsed;
  const rows = Array.from({ length: size }, (_, index) => ({
    id: index,
    productCode: `MOCK-${String(index).padStart(7, "0")}`,
    normalizedCode: `MOCK${String(index).padStart(7, "0")}`,
    title: `完全架空作品 ${index}`,
    actress: `架空女優${index % 2_000}`,
    maker: `架空メーカー${index % 200}`,
    series: `架空シリーズ${index % 1_000}`,
    genre: `架空ジャンル${index % 50}`,
    popularity: (size - index) % 10_000,
  }));
  const byCode = new Map(rows.map((row) => [row.normalizedCode, row]));
  const byActress = new Map();
  const byMaker = new Map();
  const bySeries = new Map();
  const byGenre = new Map();
  for (const row of rows) {
    for (const [map, key] of [[byActress, row.actress], [byMaker, row.maker], [bySeries, row.series], [byGenre, row.genre]]) {
      const bucket = map.get(key);
      if (bucket) bucket.push(row);
      else map.set(key, [row]);
    }
  }
  const results = [
    measure("product_code_exact", () => byCode.has(normalize(`mock-${String(Math.floor(size / 2)).padStart(7, "0")}`)) ? 1 : 0),
    measure("title_partial_scan", () => rows.filter((row) => row.title.includes("作品 99")).length),
    measure("actress_index", () => byActress.get("架空女優99")?.length ?? 0),
    measure("maker_index", () => byMaker.get("架空メーカー99")?.length ?? 0),
    measure("series_index", () => bySeries.get("架空シリーズ99")?.length ?? 0),
    measure("genre_index", () => byGenre.get("架空ジャンル9")?.length ?? 0),
    measure("ranking_top_24", () => rows.slice().sort((a, b) => b.popularity - a.popularity).slice(0, 24).length),
    measure("sitemap_page_50000", () => rows.slice(0, 50_000).length),
  ];
  const heapMegabytes = Number(((process.memoryUsage().heapUsed - memoryBefore) / 1024 / 1024).toFixed(2));
  console.log(JSON.stringify({ size, heapMegabytes, results }));
}
