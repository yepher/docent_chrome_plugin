// Onshape skill. The generic agent can't model in Onshape: the toolbar is icons,
// the viewport is a WebGL canvas, and a feature is a multi-step dialog. But the
// page is logged in to Onshape's REST API (same origin, session cookies), and a
// Part Studio is just a list of features. So this skill builds features as data:
//
//   request ──► plan (typed ops) ──► Jev checks ──► POST features ──► Onshape re-renders
//
// Simple requests (a cube, a box, a cylinder, a hole) are planned by Jev alone:
// a Choice for the shape and a Choice per dimension over the numbers in the prompt.
// Anything more complex needs the text model (LiveKit Inference) to write the plan
// as JSON; code validates it, Jev checks it matches the request, and you confirm
// if Jev isn't sure. Every feature Jev adds can be removed again from the popup.

import { choice, noul } from "./jev.js";
import { chat } from "./lk.js";

const API = "/api/v9";

export function onshapeContext(url) {
  const m = /^https:\/\/[a-z0-9.-]*onshape\.com\/documents\/([0-9a-f]{24})\/w\/([0-9a-f]{24})\/e\/([0-9a-f]{24})/i.exec(url || "");
  return m ? { did: m[1], wid: m[2], eid: m[3] } : null;
}

// ---------- page function: call the Onshape API with the page's session ----------
export async function onshapeFetch(method, path, body) {
  const headers = { Accept: "application/json;charset=UTF-8; qs=0.09" };
  if (body != null) headers["Content-Type"] = "application/json;charset=UTF-8; qs=0.09";
  const xsrf = document.cookie.split(/;\s*/).map((c) => c.split("=")).find(([k]) => /xsrf|csrf/i.test(k));
  if (xsrf) headers["X-XSRF-TOKEN"] = decodeURIComponent(xsrf.slice(1).join("="));
  const res = await fetch(path, { method, credentials: "include", headers, body: body == null ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, ok: res.ok, json, text: json ? "" : text.slice(0, 500) };
}

// ---------- dimensions from the prompt ----------
const UNITS = [
  [/^(mm|millimet(er|re)s?)$/i, 0.001, "mm"],
  [/^(cm|centimet(er|re)s?)$/i, 0.01, "cm"],
  [/^(m|met(er|re)s?)$/i, 1, "m"],
  [/^(in|inch|inches|")$/i, 0.0254, "in"],
  [/^(ft|foot|feet|')$/i, 0.3048, "ft"],
];
const unitOf = (u) => UNITS.find(([re]) => re.test(u || ""));
const UNIT_RE = String.raw`(mm|millimet(?:er|re)s?|cm|centimet(?:er|re)s?|m|met(?:er|re)s?|in|inch(?:es)?|"|ft|foot|feet)`;

export function parseDims(goal) {
  const defaultUnit = /\b(inch|inches|in)\b|"/i.test(goal) ? "in" : "mm";
  const out = [];
  // "50x30x10 mm" / "2 x 1 in": the trailing unit applies to every number.
  const tripleRe = new RegExp(String.raw`(\d+(?:\.\d+)?)\s*${UNIT_RE}?\s*[x×]\s*(\d+(?:\.\d+)?)\s*${UNIT_RE}?(?:\s*[x×]\s*(\d+(?:\.\d+)?))?\s*${UNIT_RE}?`, "gi");
  const triples = [];
  for (const m of goal.matchAll(tripleRe)) {
    const unit = m[6] || m[4] || m[2] || defaultUnit;
    triples.push([m[1], m[3], m[5]].filter(Boolean).map((n) => toDim(n, unit)));
  }
  const singleRe = new RegExp(String.raw`(\d+(?:\.\d+)?)\s*${UNIT_RE}?(?![\d.])`, "gi");
  for (const m of goal.matchAll(singleRe)) out.push(toDim(m[1], m[2] || defaultUnit));
  return { dims: dedupe(out), triples, defaultUnit };
}
function toDim(num, unit) {
  const u = unitOf(unit) || unitOf("mm");
  const n = Number(num);
  return { text: `${num} ${u[2]}`, m: n * u[1], unit: u[2], value: n };
}
const dedupe = (arr) => arr.filter((d, i) => arr.findIndex((e) => e.text === d.text) === i);
const expr = (m, unit = "mm") => {
  const u = unitOf(unit) || unitOf("mm");
  return `${+(m / u[1]).toFixed(6)} ${u[2]}`;
};

// ---------- feature JSON ----------
const PLANES = ["Top", "Front", "Right"];

function sketchFeature(name, plane, entities) {
  return {
    btType: "BTFeatureDefinitionCall-1406",
    feature: {
      btType: "BTMSketch-151",
      featureType: "newSketch",
      name,
      suppressed: false,
      parameters: [{
        btType: "BTMParameterQueryList-148",
        parameterId: "sketchPlane",
        queries: [{ btType: "BTMIndividualQuery-138", queryString: `query=qCreatedBy(makeId("${plane}"), EntityType.FACE);` }],
      }],
      entities,
      constraints: [],
    },
  };
}

function rectEntities(cx, cy, w, h, tag) {
  const x0 = cx - w / 2, y0 = cy - h / 2, x1 = cx + w / 2, y1 = cy + h / 2;
  const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  return pts.map((p, i) => {
    const q = pts[(i + 1) % 4];
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const len = Math.hypot(dx, dy);
    const id = `${tag}.line${i}`;
    return {
      btType: "BTMSketchCurveSegment-155",
      entityId: id,
      startPointId: `${id}.start`,
      endPointId: `${id}.end`,
      startParam: 0,
      endParam: len,
      geometry: { btType: "BTCurveGeometryLine-117", pntX: p[0], pntY: p[1], dirX: dx / len, dirY: dy / len },
    };
  });
}

function circleEntity(cx, cy, r, tag) {
  return {
    btType: "BTMSketchCurve-4",
    entityId: `${tag}.circle`,
    centerId: `${tag}.circle.center`,
    geometry: { btType: "BTCurveGeometryCircle-115", radius: r, xCenter: cx, yCenter: cy, xDir: 1, yDir: 0, clockwise: false },
  };
}

function extrudeFeature(name, sketchId, depthExpr, operation, through, flip) {
  const p = [
    { btType: "BTMParameterEnum-145", parameterId: "bodyType", enumName: "ExtendedToolBodyType", value: "SOLID" },
    { btType: "BTMParameterEnum-145", parameterId: "operationType", enumName: "NewBodyOperationType", value: operation },
    { btType: "BTMParameterQueryList-148", parameterId: "entities", queries: [{ btType: "BTMIndividualSketchRegionQuery-140", featureId: sketchId }] },
    { btType: "BTMParameterEnum-145", parameterId: "endBound", enumName: "BoundingType", value: through ? "THROUGH_ALL" : "BLIND" },
  ];
  if (!through) p.push({ btType: "BTMParameterQuantity-147", parameterId: "depth", expression: depthExpr });
  if (flip) p.push({ btType: "BTMParameterBoolean-144", parameterId: "oppositeDirection", value: true });
  if (operation !== "NEW") {
    p.push({ btType: "BTMParameterBoolean-144", parameterId: "defaultScope", value: false });
    p.push({ btType: "BTMParameterQueryList-148", parameterId: "booleanScope", queries: [{ btType: "BTMIndividualQuery-138", queryString: "query=qAllModifiableSolidBodies();" }] });
  }
  return {
    btType: "BTFeatureDefinitionCall-1406",
    feature: { btType: "BTMFeature-134", featureType: "extrude", name, suppressed: false, returnAfterSubfeatures: false, parameters: p },
  };
}

function cubeFeature(name, sideExpr) {
  return {
    btType: "BTFeatureDefinitionCall-1406",
    feature: {
      btType: "BTMFeature-134", featureType: "cube", name, suppressed: false, returnAfterSubfeatures: false,
      parameters: [{ btType: "BTMParameterQuantity-147", parameterId: "sideLength", expression: sideExpr, isInteger: false }],
    },
  };
}

// ---------- plans ----------
// op: { shape: "cube"|"box"|"cylinder", x, y, z (box sizes, metres) | d, h (cylinder),
//       cx, cy (sketch-plane centre), plane, operation: "NEW"|"ADD"|"REMOVE", through, unit }
export function describeOp(op) {
  const u = op.unit || "mm";
  const at = op.cx || op.cy ? ` centred at (${expr(op.cx, u)}, ${expr(op.cy, u)})` : "";
  const verb = { NEW: "New", ADD: "Add", REMOVE: "Cut" }[op.operation] || "New";
  if (op.shape === "cube") return `${verb} cube, ${expr(op.x, u)} sides${op.corner ? ", corner at the origin" : at} on the ${op.plane} plane`;
  if (op.shape === "box") return `${verb} box ${expr(op.x, u)} × ${expr(op.y, u)} × ${expr(op.z, u)}${at} on the ${op.plane} plane`;
  return `${verb} cylinder ⌀${expr(op.d, u)}${op.through ? ", through all" : ` × ${expr(op.h, u)} tall`}${at} on the ${op.plane} plane`;
}

function validateOp(o, unit) {
  const f = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  const mm = (v) => (f(v) === null ? null : v / 1000);
  const op = {
    shape: ["cube", "box", "cylinder"].includes(o.shape) ? o.shape : null,
    plane: PLANES.includes(o.plane) ? o.plane : "Top",
    operation: { new: "NEW", add: "ADD", remove: "REMOVE", cut: "REMOVE" }[String(o.operation || "new").toLowerCase()] || "NEW",
    cx: mm(o.center?.[0]) ?? 0,
    cy: mm(o.center?.[1]) ?? 0,
    through: !!o.through,
    flip: !!o.flip,
    unit,
  };
  if (!op.shape) throw new Error(`unknown shape "${o.shape}"`);
  if (op.shape === "cube") { op.shape = "box"; op.x = op.y = op.z = mm(o.size); }
  else if (op.shape === "box") { [op.x, op.y, op.z] = (o.size || []).map(mm); }
  else { op.d = mm(o.diameter); op.h = mm(o.height); }
  const dims = op.shape === "box" ? [op.x, op.y, op.z] : [op.d, op.through ? 1 : op.h];
  if (dims.some((v) => !(v > 0) || v > 10)) throw new Error(`bad dimensions in ${JSON.stringify(o)}`);
  return op;
}

// ---------- planning with Jev only ----------
async function planWithJev(ctx, goal) {
  const { dims, triples, defaultUnit } = parseDims(goal);
  const numOpts = (what) => ({
    ...Object.fromEntries(dims.map((d) => [d.text, null])),
    none: `The request doesn't give the ${what}`,
  });
  const q = {
    shape: choice("What does `request` ask to create in the CAD Part Studio?", {
      cube: "A cube: all sides the same length",
      box: "A rectangular box, block or plate with length, width and height",
      cylinder: "A cylinder, rod, disc, peg or other round solid",
      hole: "A round hole cut into the part that already exists",
      complex: "Something more complex: several features, other shapes, patterns, fillets, text, etc.",
      not_modeling: "Not a request to create geometry (for example navigating, renaming, sharing or exporting)",
    }),
  };
  if (dims.length) {
    Object.assign(q, {
      side: choice("Which number in `request` is the cube's side length?", numOpts("side length")),
      length: choice("Which number in `request` is the length (X) of the box?", numOpts("length")),
      width: choice("Which number in `request` is the width (Y) of the box?", numOpts("width")),
      height: choice("Which number in `request` is the height or thickness (Z) of the shape?", numOpts("height")),
      diameter: choice("Which number in `request` is the diameter or radius of the round shape or hole?", numOpts("diameter")),
      is_radius: noul("Does `request` give the round shape's radius rather than its diameter?"),
    });
  }
  const res = await ctx.ask({ request: goal, app: "Onshape Part Studio (3D CAD)" }, q);
  const A = res.answers;
  const shape = A.shape.choice;
  ctx.log("info", `Jev: ${shape.replace("_", " ")}`, `confidence ${Math.round(A.shape.confidence * 100)}%`);
  if (shape === "not_modeling") return { handled: false };
  if (shape === "complex") return { complex: true };

  const pick = (k) => {
    const a = A[k];
    if (!a || a.choice === "none") return null;
    return dims.find((d) => d.text === a.choice) || null;
  };
  const unit = dims[0]?.unit || defaultUnit;
  const DEF = defaultUnit === "in" ? 0.0254 : 0.025; // 1 in or 25 mm
  const defaults = [];
  const val = (k, fallback, label) => {
    const d = pick(k);
    if (d) return d.m;
    defaults.push(`${label} ${expr(fallback, unit)}`);
    return fallback;
  };

  let op;
  if (shape === "cube") {
    const s = val("side", DEF, "side");
    op = { shape: "cube", x: s, y: s, z: s, plane: "Top", operation: "NEW", cx: 0, cy: 0, corner: true, unit };
  } else if (shape === "box") {
    const t = triples.find((x) => x.length === 3);
    const [x, y, z] = t ? t.map((d) => d.m) : [val("length", DEF * 2, "length"), val("width", DEF * 1.2, "width"), val("height", DEF * 0.8, "height")];
    op = { shape: "box", x, y, z, plane: "Top", operation: "NEW", cx: 0, cy: 0, unit };
  } else if (shape === "cylinder" || shape === "hole") {
    let d = val("diameter", shape === "hole" ? DEF / 5 : DEF * 0.8, "diameter");
    if (pick("diameter") && (A.is_radius?.noul ?? 0) >= 0.5) d *= 2;
    const hole = shape === "hole";
    op = {
      shape: "cylinder", d, h: hole ? 0 : val("height", DEF * 1.2, "height"), plane: "Top",
      operation: hole ? "REMOVE" : "NEW", through: hole, cx: 0, cy: 0, unit,
    };
  }
  return { ops: [op], defaults, confidence: A.shape.confidence };
}

// ---------- planning with the text model ----------
const PLAN_PROMPT = `You plan solid-modelling operations for an Onshape Part Studio. Reply with JSON only:
{"ops":[...], "unsupported":"what you could not express, or empty"}
Each op is one of:
  {"shape":"box","size":[x,y,z],"center":[cx,cy],"plane":"Top|Front|Right","operation":"new|add|remove"}
  {"shape":"cube","size":s,"center":[cx,cy],"plane":"Top","operation":"new|add|remove"}
  {"shape":"cylinder","diameter":d,"height":h,"center":[cx,cy],"plane":"Top|Front|Right","operation":"new|add|remove","through":true|false}
All numbers are millimetres. Each op is a sketch on the given default plane (Top = XY, extruding +Z; Front = XZ; Right = YZ), centred at center in that plane's 2-D coordinates, extruded by the height (z for boxes). The first solid uses "new"; later solids that touch it use "add"; holes and cuts use "remove" (use "through":true for through-holes). Everything starts on the plane, so stacked features must be expressed as ops that start at the plane and are tall enough. If the request gives no sizes, choose sensible ones. Use as few ops as possible, at most 20.`;

async function planWithLLM(ctx, goal, llm) {
  ctx.log("info", `Planning with ${llm.lkModel}…`);
  const { defaultUnit } = parseDims(goal);
  const text = await chat(llm, [
    { role: "system", content: PLAN_PROMPT },
    { role: "user", content: goal },
  ], { signal: ctx.signal, maxTokens: 1500 });
  const json = JSON.parse((text.match(/\{[\s\S]*\}/) || ["{}"])[0]);
  const ops = (json.ops || []).slice(0, 20).map((o) => validateOp(o, defaultUnit));
  if (!ops.length) throw new Error("The text model's plan had no operations.");
  // Jev checks the plan against the request.
  const summary = ops.map((op, i) => `${i + 1}. ${describeOp(op)}`);
  const v = await ctx.ask(
    { request: goal, plan: summary, not_supported: json.unsupported || "nothing" },
    { matches: noul("Does `plan` build what `request` asks for?", { true: "The plan creates the requested shape and features", false: "The plan is missing something or builds something else" }) }
  );
  return { ops, unsupported: json.unsupported || "", confidence: v.answers.matches.noul, llm: true };
}

// ---------- run ----------
// ctx: { tabId, url, goal, signal, ask, log, inject(func, args), confirm(label) → Promise<bool>, llm, minConfidence }
// Returns null when the request isn't for this skill, else { status, text, answer }.
export async function runOnshape(ctx) {
  const oc = onshapeContext(ctx.url);
  if (!oc) return null;
  const api = async (method, path, body) => {
    const r = await ctx.inject(onshapeFetch, [method, API + path, body ?? null]);
    if (!r) throw new Error("Couldn't reach the Onshape API from this tab.");
    if (!r.ok) {
      const msg = r.json?.message || r.text || "";
      throw new Error(`Onshape API ${method} ${path.split("?")[0]} → HTTP ${r.status}${msg ? `: ${String(msg).slice(0, 200)}` : ""}`);
    }
    return r.json;
  };

  // Plan.
  let plan = await planWithJev(ctx, ctx.goal);
  if (plan.handled === false) return null;
  if (plan.complex) {
    if (!ctx.llm) {
      return { status: "stopped", text: "That needs more than one simple shape. Set up the text model (⚙ → LiveKit Inference) so it can plan multi-feature parts; Jev alone can build a cube, box, cylinder or hole." };
    }
    plan = await planWithLLM(ctx, ctx.goal, ctx.llm);
  }
  const lines = plan.ops.map((op, i) => `${i + 1}. ${describeOp(op)}`);
  ctx.log("info", `Plan:\n${lines.join("\n")}`, [
    plan.defaults?.length ? `not given, so using ${plan.defaults.join(", ")}` : "",
    plan.unsupported ? `not supported: ${plan.unsupported}` : "",
    plan.llm ? `Jev: ${Math.round(plan.confidence * 100)}% sure the plan matches the request` : "",
  ].filter(Boolean).join(" · ") || undefined);
  if (plan.llm && plan.confidence < 0.5) {
    const ok = await ctx.confirm(`Jev isn't sure this plan matches your request:\n${lines.join("\n")}`);
    if (!ok) return { status: "stopped", text: "You declined the plan." };
  }

  // Check we're in a Part Studio.
  const els = await api("GET", `/documents/d/${oc.did}/w/${oc.wid}/elements?elementId=${oc.eid}`);
  const el = (els || [])[0];
  if (el && String(el.elementType).toUpperCase() !== "PARTSTUDIO") {
    return { status: "stopped", text: `This tab ("${el.name}") is ${el.elementType}; open a Part Studio tab and try again.` };
  }
  const base = `/partstudios/d/${oc.did}/w/${oc.wid}/e/${oc.eid}/features`;

  // Build: each op is a sketch + extrude (or the standard cube feature).
  const added = [];
  const add = async (body) => {
    const r = await api("POST", base, body);
    const fid = r?.feature?.featureId;
    if (fid) added.push({ id: fid, name: body.feature.name });
    const st = r?.featureState?.featureStatus;
    if (st === "ERROR") throw new Error(`Onshape reported an error on "${body.feature.name}".`);
    return fid;
  };
  const stamp = Date.now().toString(36).slice(-4);
  try {
    for (const [i, op] of plan.ops.entries()) {
      if (ctx.signal.aborted) throw new Error("Stopped.");
      const n = i + 1, u = op.unit;
      if (op.corner && op.x === op.y && op.y === op.z && op.operation === "NEW") {
        await add(cubeFeature(`Jev cube ${n}`, expr(op.x, u)));
      } else {
        const tag = `jev${stamp}${n}`;
        const entities = op.shape === "box" ? rectEntities(op.cx, op.cy, op.x, op.y, tag) : [circleEntity(op.cx, op.cy, op.d / 2, tag)];
        const sk = await add(sketchFeature(`Jev sketch ${n}`, op.plane, entities));
        if (!sk) throw new Error("Onshape didn't return the sketch's feature id.");
        const depth = op.shape === "box" ? op.z : op.h;
        await add(extrudeFeature(`Jev ${op.operation === "REMOVE" ? "cut" : "extrude"} ${n}`, sk, expr(depth, u), op.operation, op.through, op.flip));
      }
      ctx.log("step", `${n}. ${describeOp(op)}`, "added");
    }
  } catch (e) {
    // Roll back anything half-built so the Part Studio isn't left broken.
    for (const f of added.slice().reverse()) await api("DELETE", `${base}/featureid/${encodeURIComponent(f.id)}`).catch(() => {});
    return { status: "error", text: `${e.message} Nothing was left behind.` };
  }

  return {
    status: "done",
    text: `Added ${added.length} feature${added.length === 1 ? "" : "s"} to the Part Studio.`,
    answer: {
      text: plan.ops.length === 1 ? describeOp(plan.ops[0]).replace(/ on the Top plane$/, "") : `${plan.ops.length} operations`,
      note: `Added: ${added.map((f) => f.name).join(", ")}. Use Onshape's undo, or the button below, to take them out.`,
      items: [],
      undo: { kind: "onshape", tabId: ctx.tabId, base, featureIds: added.map((f) => f.id) },
    },
  };
}

export async function undoOnshape(injectFn, undo) {
  let n = 0;
  for (const id of undo.featureIds.slice().reverse()) {
    const r = await injectFn(onshapeFetch, ["DELETE", `${API}${undo.base}/featureid/${encodeURIComponent(id)}`, null]);
    if (r?.ok) n++;
  }
  return n;
}
