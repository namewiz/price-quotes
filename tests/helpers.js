import { loadCatalog } from "../dist/index.js";

export function load(csv, defaults = {}) {
  return loadCatalog(csv, defaults);
}

export function expectCode(fn, code) {
  try {
    fn();
  } catch (e) {
    const codes = e.issues ? e.issues.map((i) => i.code) : [e.code];
    if (!codes.includes(code)) {
      throw new Error(`expected error code "${code}", got [${codes.join(", ")}]: ${e.message}`);
    }
    return;
  }
  throw new Error(`expected error code "${code}", but no error was thrown`);
}
