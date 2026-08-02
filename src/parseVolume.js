// Parse a Google Trends approx_traffic string into an integer lower bound.
//   "500+"     -> 500
//   "10,000+"  -> 10000
//   "1M+"      -> 1000000
//   "1.5K+"    -> 1500
//   ""/null    -> 0
export function parseVolume(raw) {
  if (!raw) return 0;
  const s = String(raw).trim().replace(/[,\s+]/g, '');
  const m = s.match(/^([\d.]+)\s*([kKmMbB]?)$/);
  if (!m) {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
  }
  const num = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const mul = unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : unit === 'b' ? 1e9 : 1;
  return Math.round(num * mul);
}
