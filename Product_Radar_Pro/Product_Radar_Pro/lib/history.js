import fs from "fs";
import path from "path";

const dir = path.resolve("data");
const file = path.join(dir, "history.jsonl");

export function appendRun(run) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(run) + "\n", "utf8");
}

export function readHistory(product = "", limit = 30) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const x = JSON.parse(lines[i]);
      if (!product || String(x.product || "").toLowerCase() === product.toLowerCase()) {
        out.push(x);
      }
    } catch {}
  }
  return out;
}
