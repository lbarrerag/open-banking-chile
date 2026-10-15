import { describe, it, expect } from "vitest";
import {
  cleanCompanyName,
  clampInt,
  dedupeCompanies,
  extractRutFromText,
  isValidRut,
  matchesRutFilter,
  normalizeRut,
  parseRutFilter,
} from "./santander-office.js";

// ─── normalizeRut ────────────────────────────────────────────────

describe("normalizeRut", () => {
  it("quita puntos y deja el guión", () => {
    expect(normalizeRut("76.086.428-5")).toBe("76086428-5");
  });

  it("agrega el guión cuando viene pegado", () => {
    expect(normalizeRut("123456789")).toBe("12345678-9");
  });

  it("pasa el dígito verificador a mayúscula", () => {
    expect(normalizeRut("8.888.888-k")).toBe("8888888-K");
  });

  it("ignora espacios y basura alrededor", () => {
    expect(normalizeRut("  RUT: 76.086.428 - 5 ")).toBe("76086428-5");
  });
});

// ─── isValidRut ──────────────────────────────────────────────────

describe("isValidRut", () => {
  it("acepta RUT con dígito verificador correcto", () => {
    expect(isValidRut("12345678-5")).toBe(true);
    expect(isValidRut("76.086.428-5")).toBe(true);
    expect(isValidRut("11111111-1")).toBe(true);
  });

  it("acepta dígito verificador K", () => {
    expect(isValidRut("8888888-K")).toBe(true);
    expect(isValidRut("8.888.888-k")).toBe(true);
  });

  it("acepta dígito verificador 0", () => {
    expect(isValidRut("12345675-0")).toBe(true);
  });

  it("rechaza dígito verificador incorrecto", () => {
    expect(isValidRut("12345678-9")).toBe(false);
    expect(isValidRut("76086428-1")).toBe(false);
  });

  it("rechaza cuerpos fuera de rango", () => {
    expect(isValidRut("123-4")).toBe(false);
    expect(isValidRut("123456789012-5")).toBe(false);
  });

  it("rechaza texto que no es un RUT", () => {
    expect(isValidRut("")).toBe(false);
    expect(isValidRut("cuenta corriente")).toBe(false);
  });
});

// ─── extractRutFromText ──────────────────────────────────────────

describe("extractRutFromText", () => {
  it("encuentra el RUT en una etiqueta de empresa", () => {
    expect(extractRutFromText("76.086.428-5 COMERCIAL EJEMPLO SPA")).toBe("76086428-5");
  });

  it("encuentra el RUT sin puntos", () => {
    expect(extractRutFromText("COMERCIAL EJEMPLO SPA (76086428-5)")).toBe("76086428-5");
  });

  it("ignora números de cuenta con forma de RUT pero DV inválido", () => {
    expect(extractRutFromText("Cuenta corriente 000-12345678-9")).toBeNull();
  });

  it("salta el candidato inválido y devuelve el válido", () => {
    expect(extractRutFromText("12345678-9 | 76086428-5")).toBe("76086428-5");
  });

  it("devuelve null cuando no hay RUT", () => {
    expect(extractRutFromText("Seleccione una empresa")).toBeNull();
    expect(extractRutFromText("")).toBeNull();
  });

  it("es reutilizable entre llamadas (regex global reseteada)", () => {
    const text = "76.086.428-5 EJEMPLO SPA";
    expect(extractRutFromText(text)).toBe("76086428-5");
    expect(extractRutFromText(text)).toBe("76086428-5");
  });
});

// ─── cleanCompanyName ────────────────────────────────────────────

describe("cleanCompanyName", () => {
  it("saca el RUT con puntos del comienzo", () => {
    expect(cleanCompanyName("76.086.428-5 COMERCIAL EJEMPLO SPA", "76086428-5")).toBe(
      "COMERCIAL EJEMPLO SPA",
    );
  });

  it("saca el RUT sin puntos del final y el separador", () => {
    expect(cleanCompanyName("COMERCIAL EJEMPLO SPA - 76086428-5", "76086428-5")).toBe(
      "COMERCIAL EJEMPLO SPA",
    );
  });

  it("colapsa espacios múltiples", () => {
    expect(cleanCompanyName("  EMPRESA    DOS   SPA ", null)).toBe("EMPRESA DOS SPA");
  });

  it("trunca nombres muy largos", () => {
    const long = "A".repeat(120);
    const result = cleanCompanyName(long, null);
    expect(result).toHaveLength(80);
    expect(result.endsWith("...")).toBe(true);
  });

  it("devuelve vacío cuando el texto es solo el RUT", () => {
    expect(cleanCompanyName("76.086.428-5", "76086428-5")).toBe("");
  });

  it("saca el número de convenio y el rol que el portal pega en la fila", () => {
    expect(
      cleanCompanyName(
        "76.086.428-5 000690015168460  COMERCIAL EJEMPLO S A Controller Entrar",
        "76086428-5",
      ),
    ).toBe("COMERCIAL EJEMPLO S A");
  });

  it("saca también el rol Apoderado", () => {
    expect(cleanCompanyName("CONSTRUCTORA EJEMPLO SPA Apoderado Entrar", null)).toBe(
      "CONSTRUCTORA EJEMPLO SPA",
    );
  });
});

// ─── parseRutFilter / matchesRutFilter ───────────────────────────

describe("parseRutFilter", () => {
  it("parsea una lista separada por comas", () => {
    expect(parseRutFilter("76.086.428-5, 12345678-5")).toEqual(["76086428-5", "12345678-5"]);
  });

  it("acepta separadores mixtos", () => {
    expect(parseRutFilter("76086428-5; 12345678-5")).toEqual(["76086428-5", "12345678-5"]);
  });

  it("devuelve lista vacía sin valor", () => {
    expect(parseRutFilter(undefined)).toEqual([]);
    expect(parseRutFilter("")).toEqual([]);
    expect(parseRutFilter("   ")).toEqual([]);
  });
});

describe("matchesRutFilter", () => {
  it("un filtro vacío deja pasar todos los RUT", () => {
    expect(matchesRutFilter("76086428-5", [])).toBe(true);
  });

  it("compara normalizando el formato", () => {
    expect(matchesRutFilter("76.086.428-5", ["76086428-5"])).toBe(true);
  });

  it("excluye los que no están en el filtro", () => {
    expect(matchesRutFilter("12345678-5", ["76086428-5"])).toBe(false);
  });
});

// ─── dedupeCompanies ─────────────────────────────────────────────

describe("dedupeCompanies", () => {
  it("conserva la primera aparición de cada RUT", () => {
    const result = dedupeCompanies([
      { rut: "76086428-5", kind: "select" },
      { rut: "76086428-5", kind: "element" },
      { rut: "12345678-5", kind: "element" },
    ]);
    expect(result).toEqual([
      { rut: "76086428-5", kind: "select" },
      { rut: "12345678-5", kind: "element" },
    ]);
  });

  it("no toca listas sin repetidos", () => {
    const input = [{ rut: "76086428-5" }, { rut: "12345678-5" }];
    expect(dedupeCompanies(input)).toEqual(input);
  });
});

// ─── clampInt ────────────────────────────────────────────────────

describe("clampInt", () => {
  it("usa el default cuando no hay valor o no es número", () => {
    expect(clampInt(undefined, 20, 1, 100)).toBe(20);
    expect(clampInt("abc", 20, 1, 100)).toBe(20);
  });

  it("acota al rango", () => {
    expect(clampInt("0", 20, 1, 100)).toBe(1);
    expect(clampInt("999", 20, 1, 100)).toBe(100);
  });

  it("respeta valores dentro del rango", () => {
    expect(clampInt("5", 20, 1, 100)).toBe(5);
  });
});
