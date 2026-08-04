// Order-independent CSS comparison at declaration granularity.
// An "atom" is `selector { single-declaration }`; moving rules between
// files reorders the bundle without changing the atom multiset.

// Escapes a literal string for exact use inside a RegExp, including the
// backslashes CSS itself puts in front of Tailwind's escaped selector
// characters (e.g. `\[`, `\(`).
function escapeForExactMatch(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Sanctioned baseline-parity allowlist (adjudicated 2026-08-04, T6 blocker;
// see docs/superpowers/specs/2026-08-04-agrolink-gui-parity-design.md).
// Two categories, both exact-match only:
// 1. The --error-bg/--error-text token fix (light + dark theme rows).
// 2. Exactly one Tailwind JIT-scan artifact, introduced by ui-core
//    Chip.tsx and Banner.tsx (T3/T4): both className strings reference
//    `border-[var(--danger-fg)]`, a class not used anywhere else in the
//    repo before these files existed. Tailwind's `src/**` content scan is
//    purely textual, so it emits this rule the moment the file lands on
//    disk, before any call site imports Chip/Banner — unrelated to index.css's
//    own edits. Unused, additive-only rule. Do NOT loosen this to a
//    pattern; any other atom must still fail the gate.
const DANGER_FG_BORDER_ATOM =
  '.border-\\[var\\(--danger-fg\\)\\] { border-color:var(--danger-fg) }';

export const ALLOW = new RegExp(
  `(--error-(bg|text)\\s*:)|(^${escapeForExactMatch(DANGER_FG_BORDER_ATOM)}$)`
);

export function atoms(css) {
  const out = [];
  for (const fragment of css.split('}')) {
    const brace = fragment.indexOf('{');
    if (brace === -1) continue;
    const selector = fragment.slice(0, brace).trim();
    for (const declaration of fragment.slice(brace + 1).split(';')) {
      const trimmed = declaration.trim();
      if (trimmed) out.push(`${selector} { ${trimmed} }`);
    }
  }
  return out;
}

export function diffAtoms(beforeCss, afterCss) {
  const counts = new Map();
  for (const atom of atoms(beforeCss)) counts.set(atom, (counts.get(atom) ?? 0) + 1);
  for (const atom of atoms(afterCss)) counts.set(atom, (counts.get(atom) ?? 0) - 1);
  return [...counts.entries()].filter(([, count]) => count !== 0).map(([atom]) => atom);
}
