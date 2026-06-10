import React, { useState, useMemo, useCallback } from "react";
import { parse, derivative } from "mathjs";

/* ============================================================
   SIMULADOR DE ESTRUTURAS DE MERCADO
   Concorrência Perfeita vs Monopólio
   ============================================================ */

const C = {
  bg: "#0C1017",
  panel: "#141A23",
  panelDeep: "#0F141C",
  border: "#243042",
  borderSoft: "#1B2330",
  text: "#E8ECF2",
  muted: "#8C97A8",
  faint: "#5C6878",
  amber: "#FFB02E",
  amberDim: "#8a6019",
  ec: "#4FC3F7",
  ep: "#52D98A",
  dwl: "#FF5C5C",
  rmg: "#B98CFF",
  grid: "#1A2230",
};

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const SANS = "'Segoe UI', system-ui, -apple-system, sans-serif";

/* ---------------- utilidades numéricas ---------------- */

function bisect(f, a, b, it = 90) {
  let fa = f(a);
  for (let i = 0; i < it; i++) {
    const m = (a + b) / 2;
    const fm = f(m);
    if (!isFinite(fm)) { a = m; continue; }
    if (fa * fm <= 0) b = m;
    else { a = m; fa = fm; }
  }
  return (a + b) / 2;
}

function findRoot(f, a, b, n = 1200) {
  let prev = a, fp = f(a);
  for (let i = 1; i <= n; i++) {
    const x = a + ((b - a) * i) / n;
    const fx = f(x);
    if (isFinite(fp) && isFinite(fx) && fp * fx <= 0) return bisect(f, prev, x);
    prev = x; fp = fx;
  }
  return null;
}

function integ(f, a, b, n = 800) {
  if (!(b > a)) return 0;
  const h = (b - a) / n;
  let s = 0;
  for (let i = 0; i <= n; i++) {
    const w = i === 0 || i === n ? 0.5 : 1;
    const v = f(a + i * h);
    s += w * (isFinite(v) ? v : 0);
  }
  return s * h;
}

/* ---------------- parsing de equações ---------------- */

function prep(s) {
  let t = s
    .replace(/−/g, "-")
    .replace(/,/g, ".")
    .replace(/\bq\b/g, "Q")
    .replace(/\bp\b/g, "P")
    .replace(/\bct\b/gi, "CT")
    .replace(/\bc\b/g, "CT");
  // multiplicação implícita garantida: 2Q -> 2*Q, )Q -> )*Q, Q( -> Q*(
  t = t.replace(/(\d)\s*([A-Za-z(])/g, "$1*$2");
  t = t.replace(/(\))\s*([A-Za-z0-9(])/g, "$1*$2");
  t = t.replace(/([QP])\s*(\()/g, "$1*$2");
  return t;
}

function parseDemand(input) {
  const raw = prep(input);
  let left = null, rhs = raw;
  if (raw.includes("=")) {
    const parts = raw.split("=");
    if (parts.length !== 2) throw new Error("A equação de demanda deve ter apenas um sinal de igual.");
    left = parts[0].trim().toUpperCase();
    rhs = parts[1].trim();
  }
  const node = parse(rhs);
  const code = node.compile();
  const vars = new Set();
  node.traverse((n) => { if (n.isSymbolNode) vars.add(n.name); });

  let mode;
  if (left === "P") mode = "PofQ";
  else if (left === "Q") mode = "QofP";
  else if (vars.has("Q") && !vars.has("P")) mode = "PofQ";
  else if (vars.has("P") && !vars.has("Q")) mode = "QofP";
  else throw new Error("Não consegui identificar a forma da demanda. Use P = f(Q) ou Q = f(P).");

  if (mode === "PofQ" && vars.has("P")) throw new Error("Na forma P = f(Q), o lado direito não pode conter P.");
  if (mode === "QofP" && vars.has("Q")) throw new Error("Na forma Q = f(P), o lado direito não pode conter Q.");

  if (mode === "PofQ") {
    const P = (q) => code.evaluate({ Q: q });
    let RMgFn = null;
    try {
      const rmgNode = derivative(parse(`(${rhs})*Q`), "Q");
      const rmgCode = rmgNode.compile();
      RMgFn = (q) => rmgCode.evaluate({ Q: q });
    } catch (e) { RMgFn = null; }
    return { P, RMgFn, displayed: `P = ${rhs.replace(/\*/g, "·")}` };
  } else {
    const Qd = (p) => code.evaluate({ P: p });
    const Q0 = Qd(0);
    if (!isFinite(Q0) || Q0 <= 0) throw new Error("A demanda Q(P) precisa ser positiva quando P = 0.");
    let hi = 1;
    while (Qd(hi) > 0 && hi < 1e9) hi *= 2;
    const P = (q) => {
      if (q <= 0) return bisect((p) => Qd(p) - 1e-9, 0, hi);
      if (q >= Q0) return 0;
      return bisect((p) => Qd(p) - q, 0, hi);
    };
    return { P, RMgFn: null, displayed: `Q = ${rhs.replace(/\*/g, "·")} (invertida numericamente)` };
  }
}

function parseCost(input) {
  const raw = prep(input);
  let rhs = raw;
  if (raw.includes("=")) {
    const parts = raw.split("=");
    if (parts.length !== 2) throw new Error("A equação de custo deve ter apenas um sinal de igual.");
    rhs = parts[1].trim();
  }
  const node = parse(rhs);
  const vars = new Set();
  node.traverse((n) => { if (n.isSymbolNode) vars.add(n.name); });
  if (vars.has("P")) throw new Error("O custo total deve depender apenas de Q, não de P.");
  const code = node.compile();
  const CT = (q) => code.evaluate({ Q: q });

  let CMg;
  try {
    const d = derivative(node, "Q").compile();
    CMg = (q) => d.evaluate({ Q: q });
  } catch (e) {
    CMg = (q) => {
      const h = Math.max(1e-4, Math.abs(q) * 1e-5);
      return (CT(q + h) - CT(q - h)) / (2 * h);
    };
  }
  const F = (() => { try { const v = CT(0); return isFinite(v) ? v : 0; } catch { return 0; } })();
  return { CT, CMg, F, displayed: `CT = ${rhs.replace(/\*/g, "·")}` };
}

/* ---------------- motor econômico ---------------- */

function solveModels(demandStr, costStr) {
  const D = parseDemand(demandStr);
  const K = parseCost(costStr);
  const { P } = D;
  const { CT, CMg, F } = K;

  const P0 = P(1e-6);
  if (!isFinite(P0) || P0 <= 0) throw new Error("O preço de demanda em Q ≈ 0 precisa ser positivo.");

  // limite superior do domínio: onde P(Q) chega a zero
  let qHi = 1, found = false;
  while (qHi < 1e7) {
    const v = P(qHi);
    if (!isFinite(v) || v <= 0) { found = true; break; }
    qHi *= 2;
  }
  const Qzero = found ? bisect((q) => P(q), qHi / 2, qHi) : 1000;

  const RMg = D.RMgFn
    ? D.RMgFn
    : (q) => {
        const h = Math.max(1e-4, q * 1e-5);
        return ((P(q + h) * (q + h)) - (P(q - h) * (q - h))) / (2 * h);
      };

  const eps = Qzero * 1e-5;

  const Qc = findRoot((q) => P(q) - CMg(q), eps, Qzero);
  if (Qc === null) throw new Error("Não encontrei interseção entre Demanda e CMg no domínio. Verifique as equações (a demanda deve cruzar o custo marginal).");
  const Pc = P(Qc);

  const Qm = findRoot((q) => RMg(q) - CMg(q), eps, Qzero);
  if (Qm === null) throw new Error("Não encontrei interseção entre RMg e CMg. Verifique as equações.");
  const Pm = P(Qm);

  const mk = (Q, Pr) => {
    const RT = Pr * Q;
    const CTv = CT(Q);
    const EC = integ((q) => Math.max(P(q) - Pr, 0), 0, Q);
    const EP = integ((q) => Pr - CMg(q), 0, Q);
    return { Q, P: Pr, RT, CT: CTv, lucro: RT - CTv, EC, EP, BES: EC + EP };
  };

  const cp = mk(Qc, Pc);
  const mono = mk(Qm, Pm);
  const DWL = integ((q) => P(q) - CMg(q), Qm, Qc);
  mono.DWL = Math.max(DWL, 0);
  cp.DWL = 0;

  return { cp, mono, P, CMg, RMg, CT, F, Qzero, demandLabel: D.displayed, costLabel: K.displayed };
}

/* ---------------- formatação ---------------- */

const fmt = (x, d = 2) =>
  x == null || !isFinite(x)
    ? "—"
    : x.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: d });

const pct = (a, b) => (b === 0 || !isFinite(a / b) ? "—" : (((a - b) / Math.abs(b)) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "%");

/* ---------------- gráfico SVG ---------------- */

function sample(fn, a, b, n = 160) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const q = a + ((b - a) * i) / n;
    const v = fn(q);
    if (isFinite(v)) pts.push([q, v]);
  }
  return pts;
}

function MarketChart({ model, P, CMg, RMg, showRMg, res, xMax, yMax, dwlRange, idSuffix }) {
  const W = 540, H = 380;
  const padL = 52, padR = 18, padT = 18, padB = 42;
  const iw = W - padL - padR, ih = H - padT - padB;
  const sx = (q) => padL + (q / xMax) * iw;
  const sy = (p) => padT + ih - (Math.max(0, Math.min(p, yMax)) / yMax) * ih;

  const toPath = (pts) => pts.map(([q, p], i) => `${i === 0 ? "M" : "L"}${sx(q).toFixed(1)},${sy(p).toFixed(1)}`).join(" ");
  const toPoly = (pts) => pts.map(([q, p]) => `${sx(q).toFixed(1)},${sy(p).toFixed(1)}`).join(" ");

  const dPts = sample(P, 0, xMax);
  const cPts = sample(CMg, 0, xMax).filter(([, v]) => v >= -yMax * 0.05);
  const rPts = showRMg ? sample(RMg, 0, xMax).filter(([, v]) => v >= -yMax * 0.2 && v <= yMax * 1.2) : [];

  const Qs = res.Q, Ps = res.P;

  // polígono EC: demanda de 0 a Q*, fecha na horizontal P*
  const ecPoly = [...sample(P, 0, Qs, 120), [Qs, Ps], [0, Ps]];
  // polígono EP: horizontal P* de 0 a Q*, volta pela CMg
  const epPoly = [[0, Ps], [Qs, Ps], ...sample(CMg, 0, Qs, 120).reverse().map(([q, v]) => [q, Math.max(v, 0)])];
  // peso morto
  const dwlPoly = dwlRange
    ? [...sample(P, dwlRange[0], dwlRange[1], 80), ...sample(CMg, dwlRange[0], dwlRange[1], 80).reverse()]
    : null;

  const xticks = 5, yticks = 5;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} role="img"
      aria-label={`Gráfico do modelo ${model}`}>
      <defs>
        <pattern id={`hatch-${idSuffix}`} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="7" height="7" fill={C.dwl} opacity="0.16" />
          <line x1="0" y1="0" x2="0" y2="7" stroke={C.dwl} strokeWidth="2.2" opacity="0.85" />
        </pattern>
      </defs>

      {/* grade */}
      {Array.from({ length: yticks + 1 }, (_, i) => {
        const v = (yMax * i) / yticks;
        return (
          <g key={"gy" + i}>
            <line x1={padL} x2={W - padR} y1={sy(v)} y2={sy(v)} stroke={C.grid} strokeWidth="1" />
            <text x={padL - 8} y={sy(v) + 4} textAnchor="end" fontSize="10.5" fill={C.faint} fontFamily={MONO}>{fmt(v, 0)}</text>
          </g>
        );
      })}
      {Array.from({ length: xticks + 1 }, (_, i) => {
        const v = (xMax * i) / xticks;
        return (
          <text key={"gx" + i} x={sx(v)} y={H - padB + 18} textAnchor="middle" fontSize="10.5" fill={C.faint} fontFamily={MONO}>{fmt(v, 0)}</text>
        );
      })}

      {/* áreas */}
      <polygon points={toPoly(ecPoly)} fill={C.ec} opacity="0.22" />
      <polygon points={toPoly(epPoly)} fill={C.ep} opacity="0.20" />
      {dwlPoly && <polygon points={toPoly(dwlPoly)} fill={`url(#hatch-${idSuffix})`} stroke={C.dwl} strokeWidth="1.4" strokeOpacity="0.9" />}

      {/* curvas */}
      <path d={toPath(dPts)} fill="none" stroke={C.amber} strokeWidth="2.4" />
      <path d={toPath(cPts)} fill="none" stroke={C.ep} strokeWidth="2.2" />
      {showRMg && rPts.length > 1 && <path d={toPath(rPts)} fill="none" stroke={C.rmg} strokeWidth="2" strokeDasharray="7 5" />}

      {/* linhas de equilíbrio */}
      <line x1={sx(Qs)} x2={sx(Qs)} y1={sy(0)} y2={sy(Ps)} stroke={C.muted} strokeWidth="1.2" strokeDasharray="3 4" />
      <line x1={padL} x2={sx(Qs)} y1={sy(Ps)} y2={sy(Ps)} stroke={C.muted} strokeWidth="1.2" strokeDasharray="3 4" />
      <circle cx={sx(Qs)} cy={sy(Ps)} r="4.5" fill={C.bg} stroke={C.text} strokeWidth="2" />

      {/* rótulos das curvas */}
      <text x={sx(xMax * 0.78)} y={sy(P(xMax * 0.78)) - 8} fontSize="11.5" fill={C.amber} fontFamily={MONO} fontWeight="700">D</text>
      <text x={sx(xMax * 0.82)} y={sy(CMg(xMax * 0.82)) - 8} fontSize="11.5" fill={C.ep} fontFamily={MONO} fontWeight="700">CMg</text>
      {showRMg && <text x={sx(xMax * 0.42)} y={sy(Math.max(RMg(xMax * 0.42), 0)) - 8} fontSize="11.5" fill={C.rmg} fontFamily={MONO} fontWeight="700">RMg</text>}

      {/* rótulos de P* e Q* */}
      <text x={padL + 4} y={sy(Ps) - 6} fontSize="11" fill={C.text} fontFamily={MONO}>P* = {fmt(Ps)}</text>
      <text x={sx(Qs) + 6} y={sy(0) - 6} fontSize="11" fill={C.text} fontFamily={MONO}>Q* = {fmt(Qs)}</text>

      {/* eixos */}
      <line x1={padL} x2={padL} y1={padT} y2={H - padB} stroke={C.border} strokeWidth="1.5" />
      <line x1={padL} x2={W - padR} y1={H - padB} y2={H - padB} stroke={C.border} strokeWidth="1.5" />
      <text x={W - padR} y={H - padB + 32} textAnchor="end" fontSize="11" fill={C.muted} fontFamily={SANS}>Quantidade (Q)</text>
      <text x={14} y={padT + 8} fontSize="11" fill={C.muted} fontFamily={SANS}>P</text>
    </svg>
  );
}

/* ---------------- componentes de UI ---------------- */

function Metric({ label, value, color, strong }) {
  return (
    <div style={{
      background: C.panelDeep, border: `1px solid ${strong ? (color || C.border) : C.borderSoft}`,
      borderRadius: 10, padding: "10px 12px",
    }}>
      <div style={{ fontSize: 11, color: C.muted, letterSpacing: "0.04em", textTransform: "uppercase", fontFamily: SANS }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 700, color: color || C.text, fontFamily: MONO, marginTop: 3 }}>{value}</div>
    </div>
  );
}

function Legend() {
  const items = [
    { c: C.ec, t: "Excedente do Consumidor (EC)", swatch: true },
    { c: C.ep, t: "Excedente do Produtor (EP)", swatch: true },
    { c: C.dwl, t: "Peso Morto (DWL)", hatch: true },
    { c: C.amber, t: "Demanda", line: true },
    { c: C.ep, t: "Custo Marginal", line: true },
    { c: C.rmg, t: "Receita Marginal", line: true, dash: true },
  ];
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 18px", padding: "10px 4px" }}>
      {items.map((it, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: C.muted, fontFamily: SANS }}>
          {it.line ? (
            <svg width="22" height="10"><line x1="0" y1="5" x2="22" y2="5" stroke={it.c} strokeWidth="2.4" strokeDasharray={it.dash ? "5 4" : "0"} /></svg>
          ) : (
            <span style={{
              width: 14, height: 14, borderRadius: 3, display: "inline-block",
              background: it.hatch
                ? `repeating-linear-gradient(45deg, ${it.c} 0 2px, transparent 2px 6px)`
                : it.c, opacity: it.hatch ? 0.95 : 0.45,
              border: `1px solid ${it.c}`,
            }} />
          )}
          {it.t}
        </div>
      ))}
    </div>
  );
}

const EXAMPLES = [
  { nome: "Linear clássico", d: "P = 120 - Q", c: "CT = 0.5Q^2 + 20Q + 400" },
  { nome: "Demanda direta Q(P)", d: "Q = 200 - 2P", c: "CT = 10Q + 0.25Q^2" },
  { nome: "Custo cúbico", d: "P = 90 - 0.8Q", c: "CT = 0.01Q^3 - 0.5Q^2 + 25Q + 300" },
];

/* ---------------- App ---------------- */

export default function App() {
  const [demand, setDemand] = useState(EXAMPLES[0].d);
  const [cost, setCost] = useState(EXAMPLES[0].c);
  const [applied, setApplied] = useState({ d: EXAMPLES[0].d, c: EXAMPLES[0].c });
  const [erro, setErro] = useState(null);

  const result = useMemo(() => {
    try {
      const r = solveModels(applied.d, applied.c);
      return r;
    } catch (e) {
      return { _err: e.message || "Erro ao processar as equações." };
    }
  }, [applied]);

  const calcular = useCallback(() => {
    setErro(null);
    if (!demand.trim() || !cost.trim()) { setErro("Preencha as duas equações."); return; }
    setApplied({ d: demand, c: cost });
  }, [demand, cost]);

  const ok = result && !result._err;
  const { cp, mono } = ok ? result : { cp: null, mono: null };

  const xMax = ok ? Math.min(result.Qzero, Math.max(cp.Q, mono.Q) * 1.45) : 1;
  const yMax = ok
    ? Math.max(result.P(1e-6), cp.P, mono.P, result.CMg(xMax * 0.95)) * 1.12
    : 1;

  const rows = ok ? [
    ["Preço (P*)", cp.P, mono.P],
    ["Quantidade (Q*)", cp.Q, mono.Q],
    ["Receita Total (RT)", cp.RT, mono.RT],
    ["Custo Total (CT)", cp.CT, mono.CT],
    ["Lucro (π)", cp.lucro, mono.lucro],
    ["Excedente do Consumidor (EC)", cp.EC, mono.EC],
    ["Excedente do Produtor (EP)", cp.EP, mono.EP],
    ["Bem-Estar Social (BES)", cp.BES, mono.BES],
    ["Peso Morto (DWL)", 0, mono.DWL],
  ] : [];

  // barras de decomposição do BES (assinatura visual)
  const besMax = ok ? cp.BES : 1;
  const barSeg = (v) => `${Math.max((v / besMax) * 100, 0)}%`;

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: SANS, padding: "0 0 60px" }}>
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "0 18px" }}>

        {/* ---------- cabeçalho ---------- */}
        <header style={{ padding: "38px 0 8px", borderBottom: `1px solid ${C.borderSoft}`, marginBottom: 26 }}>
          <div style={{ fontFamily: MONO, fontSize: 12, color: C.amber, letterSpacing: "0.14em", textTransform: "uppercase" }}>
            Microeconomia · Estruturas de Mercado
          </div>
          <h1 style={{ fontSize: "clamp(26px, 4vw, 40px)", fontWeight: 800, margin: "10px 0 6px", lineHeight: 1.12 }}>
            Concorrência Perfeita <span style={{ color: C.faint, fontWeight: 400 }}>vs</span> Monopólio
          </h1>
          <p style={{ color: C.muted, fontSize: 15, maxWidth: 720, margin: "6px 0 22px", lineHeight: 1.55 }}>
            Insira a equação de demanda e a função de custo total. O simulador resolve os dois equilíbrios,
            calcula excedentes e mostra graficamente por que <span style={{ color: C.text }}>P = CMg maximiza o bem-estar social</span> —
            e onde o monopólio gera <span style={{ color: C.dwl }}>peso morto</span>.
          </p>
        </header>

        {/* ---------- entrada ---------- */}
        <section style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, padding: 20, marginBottom: 26 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
            <div>
              <label htmlFor="eq-demanda" style={{ fontSize: 12, color: C.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Equação de Demanda
              </label>
              <input
                id="eq-demanda" value={demand} onChange={(e) => setDemand(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && calcular()}
                placeholder="ex.: P = 120 - Q  ou  Q = 200 - 2P"
                style={{
                  width: "100%", boxSizing: "border-box", marginTop: 6, padding: "12px 14px",
                  background: C.panelDeep, color: C.text, border: `1px solid ${C.border}`,
                  borderRadius: 9, fontFamily: MONO, fontSize: 15, outline: "none",
                }}
              />
            </div>
            <div>
              <label htmlFor="eq-custo" style={{ fontSize: 12, color: C.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Custo Total
              </label>
              <input
                id="eq-custo" value={cost} onChange={(e) => setCost(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && calcular()}
                placeholder="ex.: CT = 0.5Q^2 + 20Q + 400"
                style={{
                  width: "100%", boxSizing: "border-box", marginTop: 6, padding: "12px 14px",
                  background: C.panelDeep, color: C.text, border: `1px solid ${C.border}`,
                  borderRadius: 9, fontFamily: MONO, fontSize: 15, outline: "none",
                }}
              />
            </div>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginTop: 16 }}>
            <button onClick={calcular} style={{
              background: C.amber, color: "#1A1205", fontWeight: 800, border: "none",
              borderRadius: 9, padding: "12px 26px", fontSize: 14.5, cursor: "pointer", fontFamily: SANS,
            }}>
              Calcular equilíbrios
            </button>
            <span style={{ fontSize: 12.5, color: C.faint }}>Exemplos:</span>
            {EXAMPLES.map((ex, i) => (
              <button key={i} onClick={() => { setDemand(ex.d); setCost(ex.c); setApplied({ d: ex.d, c: ex.c }); setErro(null); }}
                style={{
                  background: "transparent", color: C.muted, border: `1px solid ${C.border}`,
                  borderRadius: 8, padding: "8px 13px", fontSize: 12.5, cursor: "pointer", fontFamily: MONO,
                }}>
                {ex.nome}
              </button>
            ))}
          </div>

          <div style={{ marginTop: 12, fontSize: 12, color: C.faint, lineHeight: 1.6 }}>
            Sintaxe: use <code style={{ color: C.muted }}>Q</code> e <code style={{ color: C.muted }}>P</code>, potências com <code style={{ color: C.muted }}>^</code> (ex.: Q^2),
            multiplicação implícita aceita (2Q = 2·Q), decimais com ponto ou vírgula. Aceita demanda como P = f(Q) ou Q = f(P).
          </div>

          {(erro || (result && result._err)) && (
            <div style={{
              marginTop: 14, background: "rgba(255,92,92,0.08)", border: `1px solid ${C.dwl}`,
              color: "#FFB4B4", borderRadius: 9, padding: "12px 14px", fontSize: 13.5,
            }}>
              {erro || result._err}
            </div>
          )}
        </section>

        {ok && (
          <>
            {/* ---------- equações interpretadas ---------- */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 20, fontFamily: MONO, fontSize: 13, color: C.muted }}>
              <span style={{ border: `1px solid ${C.borderSoft}`, borderRadius: 7, padding: "6px 12px" }}>{result.demandLabel}</span>
              <span style={{ border: `1px solid ${C.borderSoft}`, borderRadius: 7, padding: "6px 12px" }}>{result.costLabel}</span>
              <span style={{ border: `1px solid ${C.borderSoft}`, borderRadius: 7, padding: "6px 12px" }}>Custo fixo F = {fmt(result.F)}</span>
            </div>

            <Legend />

            {/* ---------- os dois modelos ---------- */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(330px, 1fr))", gap: 20, marginTop: 8 }}>

              {/* CP */}
              <section style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, padding: 18 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                  <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>Concorrência Perfeita</h2>
                  <span style={{ fontFamily: MONO, fontSize: 12.5, color: C.ec }}>P = CMg</span>
                </div>
                <p style={{ fontSize: 12.5, color: C.muted, margin: "2px 0 10px", lineHeight: 1.5 }}>
                  Firmas tomadoras de preço. Produz-se até o ponto em que o preço iguala o custo marginal —
                  eficiência alocativa: <strong style={{ color: C.text }}>BES máximo, peso morto zero</strong>.
                </p>
                <MarketChart
                  model="Concorrência Perfeita" P={result.P} CMg={result.CMg} RMg={result.RMg}
                  showRMg={false} res={cp} xMax={xMax} yMax={yMax} dwlRange={null} idSuffix="cp"
                />
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8, marginTop: 12 }}>
                  <Metric label="Preço" value={fmt(cp.P)} />
                  <Metric label="Quantidade" value={fmt(cp.Q)} />
                  <Metric label="Receita" value={fmt(cp.RT)} />
                  <Metric label="Lucro (π)" value={fmt(cp.lucro)} color={cp.lucro >= 0 ? C.ep : C.dwl} />
                  <Metric label="EC" value={fmt(cp.EC)} color={C.ec} strong />
                  <Metric label="EP" value={fmt(cp.EP)} color={C.ep} strong />
                  <Metric label="BES" value={fmt(cp.BES)} color={C.amber} strong />
                  <Metric label="Peso Morto" value="0" color={C.muted} />
                </div>
              </section>

              {/* Monopólio */}
              <section style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, padding: 18 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                  <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>Monopólio</h2>
                  <span style={{ fontFamily: MONO, fontSize: 12.5, color: C.rmg }}>RMg = CMg</span>
                </div>
                <p style={{ fontSize: 12.5, color: C.muted, margin: "2px 0 10px", lineHeight: 1.5 }}>
                  Firma formadora de preço. Como RMg &lt; P, produz menos e cobra mais (P &gt; CMg) —
                  parte do excedente vira lucro, parte simplesmente <strong style={{ color: C.dwl }}>desaparece: o peso morto</strong>.
                </p>
                <MarketChart
                  model="Monopólio" P={result.P} CMg={result.CMg} RMg={result.RMg}
                  showRMg={true} res={mono} xMax={xMax} yMax={yMax} dwlRange={[mono.Q, cp.Q]} idSuffix="mono"
                />
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8, marginTop: 12 }}>
                  <Metric label="Preço" value={fmt(mono.P)} />
                  <Metric label="Quantidade" value={fmt(mono.Q)} />
                  <Metric label="Receita" value={fmt(mono.RT)} />
                  <Metric label="Lucro (π)" value={fmt(mono.lucro)} color={mono.lucro >= 0 ? C.ep : C.dwl} />
                  <Metric label="EC" value={fmt(mono.EC)} color={C.ec} strong />
                  <Metric label="EP" value={fmt(mono.EP)} color={C.ep} strong />
                  <Metric label="BES" value={fmt(mono.BES)} color={C.amber} strong />
                  <Metric label="Peso Morto" value={fmt(mono.DWL)} color={C.dwl} strong />
                </div>
              </section>
            </div>

            {/* ---------- decomposição do BES (assinatura) ---------- */}
            <section style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, padding: 20, marginTop: 22 }}>
              <h2 style={{ fontSize: 17, fontWeight: 800, margin: "0 0 4px" }}>Para onde vai o bem-estar?</h2>
              <p style={{ fontSize: 13, color: C.muted, margin: "0 0 16px", lineHeight: 1.55 }}>
                As duas barras têm a mesma escala. Na concorrência perfeita, todo o potencial de bem-estar é capturado por
                consumidores e produtores. No monopólio, o EC encolhe, o EP cresce — e a fatia hachurada não vai para ninguém.
              </p>

              {[
                { nome: "Concorrência Perfeita", ec: cp.EC, ep: cp.EP, dwl: 0 },
                { nome: "Monopólio", ec: mono.EC, ep: mono.EP, dwl: mono.DWL },
              ].map((b, i) => (
                <div key={i} style={{ marginBottom: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 6 }}>
                    <span style={{ color: C.text, fontWeight: 700 }}>{b.nome}</span>
                    <span style={{ fontFamily: MONO, color: C.muted }}>BES = {fmt(b.ec + b.ep)} {b.dwl > 0 && <span style={{ color: C.dwl }}>(−{fmt(b.dwl)})</span>}</span>
                  </div>
                  <div style={{ display: "flex", height: 34, borderRadius: 8, overflow: "hidden", border: `1px solid ${C.borderSoft}`, background: C.panelDeep }}>
                    <div title={`EC = ${fmt(b.ec)}`} style={{ width: barSeg(b.ec), background: C.ec, opacity: 0.85, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11.5, fontFamily: MONO, color: "#062436", fontWeight: 800, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden" }}>EC</div>
                    <div title={`EP = ${fmt(b.ep)}`} style={{ width: barSeg(b.ep), background: C.ep, opacity: 0.85, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11.5, fontFamily: MONO, color: "#06301A", fontWeight: 800, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden" }}>EP</div>
                    {b.dwl > 0 && (
                      <div title={`Peso Morto = ${fmt(b.dwl)}`} style={{
                        width: barSeg(b.dwl),
                        background: `repeating-linear-gradient(45deg, rgba(255,92,92,0.85) 0 4px, rgba(255,92,92,0.15) 4px 10px)`,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 11.5, fontFamily: MONO, color: "#FFD9D9", fontWeight: 800, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden",
                      }}>DWL</div>
                    )}
                  </div>
                </div>
              ))}
            </section>

            {/* ---------- tabela comparativa ---------- */}
            <section style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, padding: 20, marginTop: 22, overflowX: "auto" }}>
              <h2 style={{ fontSize: 17, fontWeight: 800, margin: "0 0 14px" }}>Comparativo numérico</h2>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5, minWidth: 560 }}>
                <thead>
                  <tr>
                    {["Indicador", "Conc. Perfeita", "Monopólio", "Δ (Mono − CP)", "Δ %"].map((h, i) => (
                      <th key={i} style={{
                        textAlign: i === 0 ? "left" : "right", padding: "9px 10px",
                        borderBottom: `1.5px solid ${C.border}`, color: C.muted, fontSize: 11.5,
                        textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700,
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(([nome, a, b], i) => {
                    const diff = b - a;
                    const destaque = nome.includes("Peso Morto") || nome.includes("BES");
                    return (
                      <tr key={i} style={{ background: destaque ? "rgba(255,176,46,0.05)" : "transparent" }}>
                        <td style={{ padding: "9px 10px", borderBottom: `1px solid ${C.borderSoft}`, color: destaque ? C.text : C.muted, fontWeight: destaque ? 700 : 400 }}>{nome}</td>
                        <td style={{ padding: "9px 10px", borderBottom: `1px solid ${C.borderSoft}`, textAlign: "right", fontFamily: MONO, color: C.text }}>{fmt(a)}</td>
                        <td style={{ padding: "9px 10px", borderBottom: `1px solid ${C.borderSoft}`, textAlign: "right", fontFamily: MONO, color: C.text }}>{fmt(b)}</td>
                        <td style={{ padding: "9px 10px", borderBottom: `1px solid ${C.borderSoft}`, textAlign: "right", fontFamily: MONO, color: diff > 1e-9 ? C.ep : diff < -1e-9 ? C.dwl : C.faint }}>
                          {diff > 0 ? "+" : ""}{fmt(diff)}
                        </td>
                        <td style={{ padding: "9px 10px", borderBottom: `1px solid ${C.borderSoft}`, textAlign: "right", fontFamily: MONO, color: C.muted }}>
                          {nome.includes("Peso Morto") ? "—" : pct(b, a)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>

            {/* ---------- leitura teórica ---------- */}
            <section style={{ background: C.panelDeep, border: `1px solid ${C.borderSoft}`, borderRadius: 14, padding: 20, marginTop: 22, fontSize: 13.5, lineHeight: 1.7, color: C.muted }}>
              <h2 style={{ fontSize: 15, fontWeight: 800, margin: "0 0 8px", color: C.text }}>Leitura do resultado</h2>
              <p style={{ margin: "0 0 8px" }}>
                Com essas equações, o monopolista restringe a produção em <strong style={{ color: C.text }}>{fmt(cp.Q - mono.Q)}</strong> unidades
                ({pct(mono.Q, cp.Q)}) e eleva o preço em <strong style={{ color: C.text }}>{fmt(mono.P - cp.P)}</strong> ({pct(mono.P, cp.P)}).
                O excedente do consumidor cai de <span style={{ color: C.ec }}>{fmt(cp.EC)}</span> para <span style={{ color: C.ec }}>{fmt(mono.EC)}</span> —
                parte é transferida ao produtor como lucro, mas <strong style={{ color: C.dwl }}>{fmt(mono.DWL)}</strong> de
                bem-estar deixa de existir: transações mutuamente vantajosas (consumidores dispostos a pagar mais do que o CMg)
                simplesmente não acontecem.
              </p>
              <p style={{ margin: 0 }}>
                Esse é o triângulo de Harberger. A concorrência perfeita maximiza o BES porque produz exatamente até onde
                a disposição a pagar marginal iguala o custo marginal de produzir — nem uma unidade a menos, nem a mais.
              </p>
            </section>
          </>
        )}

        <footer style={{ marginTop: 36, paddingTop: 16, borderTop: `1px solid ${C.borderSoft}`, fontSize: 12, color: C.faint, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <span>Simulador de Estruturas de Mercado · equilíbrios resolvidos numericamente</span>
          <span style={{ fontFamily: MONO }}>EC = ∫(P(q) − P*)dq · DWL = ∫[Qm→Qc](P − CMg)dq</span>
        </footer>
      </div>
    </div>
  );
}
