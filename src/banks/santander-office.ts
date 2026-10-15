import type { Frame, Page } from "puppeteer-core";
import type {
  AccountBalance,
  BankMovement,
  BankScraper,
  ScrapeResult,
  ScraperOptions,
} from "../types.js";
import { closePopups, delay, deduplicateMovements } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";
import { clickSubmit, detectLoginError, fillPassword, fillRut } from "../actions/login.js";
import { dismissBanners } from "../actions/navigation.js";
import { detect2FA, waitFor2FA } from "../actions/two-factor.js";
import { extractAccountMovements } from "../actions/extraction.js";
import { extractBalance } from "../actions/balance.js";

/**
 * Santander Office Banking (empresas) — scraper multi-RUT.
 *
 * A diferencia de `santander` (portal personas, un solo RUT), acá un usuario
 * de acceso puede tener mandato sobre varios RUT de empresa. El scraper:
 *   1. Entra con el RUT del usuario (+ RUT empresa si el login lo pide)
 *   2. Descubre todos los RUT a los que el usuario tiene acceso
 *   3. Recorre uno por uno: selecciona empresa → cartola → movimientos
 *   4. Devuelve un AccountBalance por cuenta, etiquetado con holderRut
 *
 * El portal de empresas no expone una API JSON estable como el de personas y
 * sus IDs de DOM cambian entre releases, así que la navegación es por texto
 * visible y los RUT se descubren validando módulo 11 sobre el texto de la
 * página — no con selectores CSS fijos. Las funciones puras de este archivo
 * están cubiertas por tests; el recorrido del DOM hay que validarlo contra el
 * portal real con `--headful --screenshots`.
 */

// ─── Constantes ──────────────────────────────────────────────────────

const BANK_URL = "https://www.officebanking.cl";

/** Entradas al login, en orden. Se usa la primera que muestre un formulario. */
const LOGIN_URL_CANDIDATES = [
  "https://empresas.officebanking.cl/",
  BANK_URL,
  "https://banco.santander.cl/empresas",
];

/**
 * El formulario de login no vive en la página: es un iframe cross-origin
 * servido por api.officebanking.cl. Ese iframe a veces rechaza la primera
 * conexión, así que hay que esperarlo y reintentar.
 */
const LOGIN_FRAME_MARKER = "party_authentication_fob_login";
const LOGIN_HOST_MARKER = "api.officebanking.cl";

const LOGIN_SELECTORS = {
  rutSelectors: [
    "#username",
    'input[name="username"]',
    "#rutUsuario",
    'input[name*="rutUsuario" i]',
  ],
  passwordSelectors: [
    "#password",
    'input[name="password"]',
    "#clave",
    'input[type="password"]',
  ],
  submitSelectors: ["#doLoginButton", 'button[type="submit"]'],
  // #username tiene maxlength 13 → espera el RUT con puntos y guión
  rutFormat: "formatted" as const,
  submitTexts: ["ingresar", "entrar", "continuar", "aceptar"],
};

/** Campo extra del login de empresas: RUT de la empresa (no siempre existe) */
const COMPANY_RUT_SELECTORS = [
  "#rutEmpresa",
  'input[name*="rutEmpresa" i]',
  'input[id*="empresa" i]',
  'input[name*="empresa" i]',
];

const TWO_FACTOR_CONFIG = {
  keywords: [
    "santander pass",
    "clave dinámica",
    "clave dinamica",
    "segundo factor",
    "código de verificación",
    "codigo de verificacion",
    "autoriza tu ingreso",
    "aprueba el ingreso",
  ],
  timeoutEnvVar: "SANTANDER_OFFICE_2FA_TIMEOUT_SEC",
  defaultTimeoutSec: 180,
};

/** Textos del menú que llevan a la cartola / movimientos */
const CARTOLA_TEXTS = [
  "cartola",
  "cartolas",
  "saldos y movimientos",
  "consulta de saldos",
  "consulta de cuentas",
  "posición consolidada",
  "posicion consolidada",
  "cuentas corrientes",
  "últimos movimientos",
  "ultimos movimientos",
  "movimientos",
  "saldos",
];

/**
 * Textos que abren el selector de empresas cuando está colapsado.
 * Deliberadamente específicos: un "empresas" suelto matchea los banners de
 * marketing del sitio público y nos saca de la sesión.
 */
const SWITCHER_TEXTS = [
  "volver a selector de empresas",
  "selector de empresas",
  "cambiar empresa",
  "seleccionar empresa",
  "seleccione empresa",
  "cambiar cliente",
  "cambio de empresa",
  "mis empresas",
  "cambiar",
];

/** Textos de botones que confirman una selección */
const CONFIRM_TEXTS = ["consultar", "buscar", "aceptar", "continuar", "ver movimientos"];

/** Textos que abren el menú principal cuando la cartola está detrás de él */
const MENU_TEXTS = ["menú", "menu", "mis productos", "productos", "consultas", "cuentas"];

/** Pantalla donde el portal lista los RUT mandatados */
const SELECTION_URL = "https://privado.officebanking.cl/seleccion-empresa";
const SELECTION_MARKER = "seleccion-empresa";

// ─── Helpers puros (testeables sin navegador) ────────────────────────

/** RUT con o sin puntos, con guión: 76.086.428-5 | 76086428-5 */
const RUT_REGEX = /(\d{1,2}(?:\.\d{3}){2}|\d{7,8})\s*-\s*([\dkK])/g;

/** Normaliza un RUT a "76086428-5" (sin puntos, DV en mayúscula) */
export function normalizeRut(raw: string): string {
  const clean = raw.replace(/[^\dkK]/g, "").toUpperCase();
  if (clean.length < 2) return clean;
  return `${clean.slice(0, -1)}-${clean.slice(-1)}`;
}

/** Valida el dígito verificador (módulo 11) */
export function isValidRut(raw: string): boolean {
  const normalized = normalizeRut(raw);
  const [body, dv] = normalized.split("-");
  if (!body || !dv || body.length < 7 || body.length > 8) return false;
  if (!/^\d+$/.test(body)) return false;

  let sum = 0;
  let multiplier = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += parseInt(body[i], 10) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }

  const remainder = 11 - (sum % 11);
  const expected = remainder === 11 ? "0" : remainder === 10 ? "K" : String(remainder);
  return expected === dv;
}

/** Devuelve el primer RUT válido que aparezca en un texto, o null */
export function extractRutFromText(text: string): string | null {
  if (!text) return null;
  RUT_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RUT_REGEX.exec(text)) !== null) {
    const candidate = normalizeRut(`${match[1]}-${match[2]}`);
    if (isValidRut(candidate)) return candidate;
  }
  return null;
}

/**
 * Ruido que el portal mete en la misma fila que la razón social:
 * el rol del usuario y el texto del botón de acción.
 */
const COMPANY_NOISE = /\b(controller|apoderado|administrador|representante|entrar|ingresar|seleccionar)\b/gi;

/** Limpia la etiqueta de una empresa dejando solo la razón social */
export function cleanCompanyName(text: string, rut?: string | null): string {
  let name = (text || "").replace(/\s+/g, " ").trim();
  if (rut) {
    const [body, dv] = rut.split("-");
    const dotted = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    name = name.replace(new RegExp(`${dotted}\\s*-\\s*${dv}`, "gi"), "");
    name = name.replace(new RegExp(`${body}\\s*-\\s*${dv}`, "gi"), "");
  }
  // Números de contrato/convenio que acompañan al RUT en la fila
  name = name.replace(/\b\d{9,}\b/g, " ");
  name = name.replace(COMPANY_NOISE, " ");
  name = name.replace(/\s+/g, " ");
  name = name.replace(/^[\s\-–—:|,.]+|[\s\-–—:|,.]+$/g, "").trim();
  return name.length > 80 ? `${name.slice(0, 77)}...` : name;
}

/** Parsea SANTANDER_OFFICE_RUTS ("76086428-5, 12345678-5") a RUT normalizados */
export function parseRutFilter(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;\s]+/)
    .map((r) => r.trim())
    .filter(Boolean)
    .map(normalizeRut)
    .filter((r) => r.includes("-"));
}

/** Un filtro vacío significa "todos los RUT" */
export function matchesRutFilter(rut: string, filter: string[]): boolean {
  if (filter.length === 0) return true;
  return filter.includes(normalizeRut(rut));
}

/** Elimina empresas repetidas conservando la primera aparición */
export function dedupeCompanies<T extends { rut: string }>(companies: T[]): T[] {
  const seen = new Set<string>();
  return companies.filter((c) => {
    if (seen.has(c.rut)) return false;
    seen.add(c.rut);
    return true;
  });
}

/** Lee un entero de env con default y rango acotado */
export function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = parseInt(raw ?? "", 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// ─── Descubrimiento de empresas ──────────────────────────────────────

export interface CompanyRef {
  /** RUT normalizado, ej: "76086428-5" */
  rut: string;
  /** Razón social, si el portal la muestra junto al RUT */
  name: string;
  /** Cómo seleccionarla: opción de <select> o elemento clickeable */
  kind: "select" | "element";
  /** kind="select": índice del <select> marcado con data-obc-select */
  selectIndex?: number;
  /** kind="select": value de la opción */
  optionValue?: string;
  /** kind="element": índice marcado con data-obc-company */
  markerIndex?: number;
}

interface RawCandidate {
  text: string;
  kind: "select" | "element";
  selectIndex?: number;
  optionValue?: string;
  markerIndex?: number;
}

/** Todos los contextos donde puede vivir el contenido: página + iframes */
function contextsOf(page: Page): Array<Page | Frame> {
  return [page, ...page.frames().filter((f) => f !== page.mainFrame())];
}

/**
 * Marca en el DOM y devuelve todo texto que contenga algo con forma de RUT.
 * La validación de módulo 11 se hace en Node (acá no hay helpers compartidos).
 */
async function discoverCandidates(ctx: Page | Frame): Promise<RawCandidate[]> {
  return await ctx.evaluate(() => {
    const RUT_SHAPE = /(\d{1,2}(?:\.\d{3}){2}|\d{7,8})\s*-\s*[\dkK]/;
    const found: Array<{
      text: string;
      kind: "select" | "element";
      selectIndex?: number;
      optionValue?: string;
      markerIndex?: number;
    }> = [];

    const selects = Array.from(document.querySelectorAll("select"));
    selects.forEach((select, selectIndex) => {
      select.setAttribute("data-obc-select", String(selectIndex));
      for (const option of Array.from(select.options)) {
        const text = (option.text || "").replace(/\s+/g, " ").trim();
        if (!text || !RUT_SHAPE.test(text)) continue;
        found.push({ text, kind: "select", selectIndex, optionValue: option.value });
      }
    });

    const clickable = Array.from(
      document.querySelectorAll(
        'a, li, button, tr, [role="option"], [role="menuitem"], [class*="empresa"], [class*="company"], [class*="cliente"]',
      ),
    );
    let markerIndex = 0;
    for (const element of clickable) {
      const node = element as HTMLElement;
      const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 140 || !RUT_SHAPE.test(text)) continue;
      node.setAttribute("data-obc-company", String(markerIndex));
      found.push({ text, kind: "element", markerIndex });
      markerIndex++;
    }

    return found;
  });
}

/** Intenta abrir el selector de empresas si está colapsado */
async function openCompanySwitcher(page: Page, debugLog: string[]): Promise<void> {
  for (const ctx of contextsOf(page)) {
    const opened = await ctx
      .evaluate((texts: string[]) => {
        const candidates = Array.from(document.querySelectorAll("a, button, span, div, li"));
        for (const candidate of candidates) {
          const node = candidate as HTMLElement;
          const text = (node.innerText || "").trim().toLowerCase();
          if (!text || text.length > 60) continue;
          if (!texts.some((t) => text.includes(t))) continue;
          const rect = node.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          node.click();
          return text;
        }
        return null;
      }, SWITCHER_TEXTS)
      .catch(() => null);

    if (opened) {
      debugLog.push(`  Selector de empresas abierto desde: "${opened}"`);
      await delay(2000);
      return;
    }
  }
}

/** Descubre los RUT a los que el usuario tiene acceso */
export async function discoverCompanies(page: Page, debugLog: string[]): Promise<CompanyRef[]> {
  const companies: CompanyRef[] = [];

  for (const ctx of contextsOf(page)) {
    const candidates = await discoverCandidates(ctx).catch(() => [] as RawCandidate[]);
    for (const candidate of candidates) {
      const rut = extractRutFromText(candidate.text);
      if (!rut) continue;
      companies.push({
        rut,
        name: cleanCompanyName(candidate.text, rut),
        kind: candidate.kind,
        selectIndex: candidate.selectIndex,
        optionValue: candidate.optionValue,
        markerIndex: candidate.markerIndex,
      });
    }
  }

  // Un <select> es más confiable que un div clickeable: si el mismo RUT
  // aparece en ambos, dedupeCompanies conserva el primero, así que los
  // ordenamos antes de deduplicar.
  companies.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "select" ? -1 : 1));
  const unique = dedupeCompanies(companies);
  debugLog.push(`  RUT detectados: ${unique.length}`);
  return unique;
}

/** Selecciona una empresa. Devuelve true si logró accionarla. */
export async function selectCompany(
  page: Page,
  company: CompanyRef,
  debugLog: string[],
): Promise<boolean> {
  for (const ctx of contextsOf(page)) {
    if (company.kind === "select") {
      const done = await ctx
        .evaluate(
          (selectIndex: number, value: string) => {
            const select = document.querySelector(
              `select[data-obc-select="${selectIndex}"]`,
            ) as HTMLSelectElement | null;
            if (!select) return false;
            select.value = value;
            select.dispatchEvent(new Event("input", { bubbles: true }));
            select.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          },
          company.selectIndex ?? -1,
          company.optionValue ?? "",
        )
        .catch(() => false);
      if (done) {
        await delay(1500);
        await clickByTexts(page, CONFIRM_TEXTS);
        return true;
      }
      continue;
    }

    const done = await ctx
      .evaluate(
        (markerIndex: number, rut: string) => {
          // Cada fila trae su propio botón "Entrar": clickear la fila no basta.
          const clickAction = (root: HTMLElement): string | null => {
            const actions = Array.from(
              root.querySelectorAll("button, a, [role='button'], input[type='submit']"),
            );
            for (const action of actions) {
              const node = action as HTMLElement;
              const text = (node.innerText || (node as HTMLInputElement).value || "")
                .trim()
                .toLowerCase();
              if (["entrar", "ingresar", "seleccionar", "continuar"].includes(text)) {
                node.click();
                return text;
              }
            }
            return null;
          };

          const marked = document.querySelector(
            `[data-obc-company="${markerIndex}"]`,
          ) as HTMLElement | null;
          if (marked) {
            const action = clickAction(marked);
            if (action) return `botón "${action}"`;
            marked.click();
            return "fila marcada";
          }

          // El DOM pudo re-renderizarse y perder la marca: buscar por RUT visible.
          const body = rut.split("-")[0];
          const dotted = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
          const candidates = Array.from(document.querySelectorAll("tr, li, a, div"));
          for (const candidate of candidates) {
            const node = candidate as HTMLElement;
            const text = (node.innerText || "").trim();
            if (text.length > 140) continue;
            if (!text.includes(body) && !text.includes(dotted)) continue;
            const action = clickAction(node);
            if (action) return `botón "${action}" (por RUT)`;
            node.click();
            return "fila (por RUT)";
          }
          return null;
        },
        company.markerIndex ?? -1,
        company.rut,
      )
      .catch(() => null);

    if (done) {
      debugLog.push(`  Entrando a ${company.rut} vía ${done}`);
      await waitForCompanyHome(page);
      return true;
    }
  }

  debugLog.push(`  No se pudo seleccionar ${company.rut}`);
  return false;
}

// ─── Navegación ──────────────────────────────────────────────────────

/**
 * Click por texto visible, en la página o cualquier iframe.
 *
 * Busca sobre hojas del DOM en vez de una lista de etiquetas: el portal pone
 * textos como "Menú" en divs e íconos, no en <a> o <button>. Una vez
 * encontrada la hoja, clickea su ancestro accionable si lo tiene.
 */
async function clickByTexts(page: Page, texts: string[]): Promise<string | null> {
  for (const ctx of contextsOf(page)) {
    const clicked = await ctx
      .evaluate((candidates: string[]) => {
        // Texto propio del elemento (sus nodos de texto directos), no el de
        // sus descendientes. Así matchea <a>Ingresar<i icono/></a> sin
        // matchear el <div> que envuelve media página.
        const ownText = (element: Element): string => {
          const direct = Array.from(element.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent || "")
            .join(" ");
          const value = (element as HTMLInputElement).value;
          return (direct || value || "").replace(/\s+/g, " ").trim().toLowerCase();
        };

        const all = Array.from(document.querySelectorAll("*"));

        // Dos pasadas: primero coincidencia exacta. Si no, "office banking"
        // matchearía el banner "App Office Banking" antes que el botón real.
        for (const exact of [true, false]) {
          for (const element of all) {
            const node = element as HTMLElement;
            const text = ownText(element);
            if (!text || text.length > 80) continue;
            if (!candidates.some((c) => (exact ? text === c : text.includes(c)))) continue;

            // offsetParent es null en elementos position:fixed (el header del
            // portal lo es), así que la visibilidad se mide por su caja.
            const rect = node.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;

            const target =
              (node.closest(
                "a, button, [role='button'], [role='menuitem'], li",
              ) as HTMLElement | null) ?? node;
            target.click();
            return text.slice(0, 40);
          }
        }
        return null;
      }, texts)
      .catch(() => null);

    if (clicked) return clicked;
  }
  return null;
}

/** Espera a que el portal salga de la pantalla de selección de empresa */
async function waitForCompanyHome(page: Page, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!page.url().includes(SELECTION_MARKER)) return true;
    await delay(1000);
  }
  return false;
}

/** Vuelve al listado de empresas para pasar al siguiente RUT */
async function returnToCompanySelector(page: Page, debugLog: string[]): Promise<void> {
  if (page.url().includes(SELECTION_MARKER)) return;

  const clicked = await clickByTexts(page, SWITCHER_TEXTS);
  if (clicked) {
    debugLog.push(`  Volviendo al selector vía "${clicked}"`);
    await delay(3000);
  }

  if (!page.url().includes(SELECTION_MARKER)) {
    await page.goto(SELECTION_URL, { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
    await delay(2000);
    debugLog.push("  Volviendo al selector por URL directa");
  }
}

/**
 * Lista las opciones visibles de la pantalla. Es la única forma de saber cómo
 * se llaman realmente los menús del portal cuando la navegación falla.
 */
async function describeOptions(page: Page): Promise<string> {
  for (const ctx of contextsOf(page)) {
    const options = await ctx
      .evaluate(() => {
        const texts = Array.from(
          document.querySelectorAll("a, button, [role='menuitem'], li, h1, h2, h3"),
        )
          .map((el) => ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim())
          .filter((text) => text && text.length <= 40);
        return Array.from(new Set(texts)).slice(0, 45);
      })
      .catch(() => [] as string[]);
    if (options.length) return `Opciones visibles: ${options.join(" | ")}`;
  }
  return "(sin opciones visibles)";
}

/** Entra a la cartola / movimientos de la empresa seleccionada */
async function navigateToCartola(page: Page, debugLog: string[]): Promise<boolean> {
  let clicked = await clickByTexts(page, CARTOLA_TEXTS);

  if (!clicked) {
    // Puede estar detrás del menú principal: abrirlo y reintentar
    const menu = await clickByTexts(page, MENU_TEXTS);
    if (menu) {
      await delay(2500);
      // Dejar registro de lo que ofrece el menú: así se ajustan los textos
      // sin tener que adivinar desde afuera.
      debugLog.push(`  Menú abierto con "${menu}". ${await describeOptions(page)}`);
      clicked = await clickByTexts(page, CARTOLA_TEXTS);
    }
  }

  if (!clicked) {
    debugLog.push(`  No se encontró enlace a cartola. ${await describeOptions(page)}`);
    return false;
  }
  debugLog.push(`  Cartola: click en "${clicked}"`);
  await delay(4000);
  await clickByTexts(page, CONFIRM_TEXTS);
  await delay(3000);
  return true;
}

// ─── Extracción ──────────────────────────────────────────────────────

/** Extrae movimientos de la página y de todos sus iframes */
async function extractFromAllFrames(page: Page): Promise<BankMovement[]> {
  const movements: BankMovement[] = [];
  for (const ctx of contextsOf(page)) {
    try {
      movements.push(...(await extractAccountMovements(ctx)));
    } catch {
      // el frame pudo desmontarse entre medio
    }
  }
  return deduplicateMovements(movements);
}

/** Pagina sobre la cartola acumulando movimientos */
async function paginateCartola(page: Page, debugLog: string[], maxPages: number): Promise<BankMovement[]> {
  const all: BankMovement[] = [];

  for (let i = 0; i < maxPages; i++) {
    all.push(...(await extractFromAllFrames(page)));

    const next = await clickByTexts(page, ["siguiente", "ver más", "ver mas", "mostrar más"]);
    if (!next) break;
    debugLog.push(`  Paginación: página ${i + 2}`);
    await delay(2500);
  }

  return deduplicateMovements(all);
}

interface AccountOption {
  selectIndex: number;
  optionValue: string;
  label: string;
}

/** Busca un <select> de cuentas dentro de la cartola (ej: varias cuentas corrientes) */
async function listAccountOptions(page: Page): Promise<AccountOption[]> {
  for (const ctx of contextsOf(page)) {
    const options = await ctx
      .evaluate(() => {
        const ACCOUNT_SHAPE = /cuenta|corriente|vista|\d{6,}/i;
        const result: Array<{ selectIndex: number; optionValue: string; label: string }> = [];

        const selects = Array.from(document.querySelectorAll("select"));
        selects.forEach((select, selectIndex) => {
          select.setAttribute("data-obc-account-select", String(selectIndex));
          const matching = Array.from(select.options)
            .map((option) => ({
              selectIndex,
              optionValue: option.value,
              label: (option.text || "").replace(/\s+/g, " ").trim(),
            }))
            .filter(
              (option) =>
                option.label &&
                option.optionValue &&
                ACCOUNT_SHAPE.test(option.label) &&
                !/seleccione|todas/i.test(option.label),
            );
          // Nos quedamos con el select que más opciones de cuenta tenga
          if (matching.length > result.length) {
            result.length = 0;
            result.push(...matching);
          }
        });

        return result;
      })
      .catch(() => [] as AccountOption[]);

    if (options.length > 0) return options;
  }
  return [];
}

/** Cambia la cuenta seleccionada dentro de la cartola */
async function selectAccount(page: Page, option: AccountOption): Promise<boolean> {
  for (const ctx of contextsOf(page)) {
    const done = await ctx
      .evaluate(
        (selectIndex: number, value: string) => {
          const select = document.querySelector(
            `select[data-obc-account-select="${selectIndex}"]`,
          ) as HTMLSelectElement | null;
          if (!select) return false;
          select.value = value;
          select.dispatchEvent(new Event("input", { bubbles: true }));
          select.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        },
        option.selectIndex,
        option.optionValue,
      )
      .catch(() => false);

    if (done) {
      await delay(1500);
      await clickByTexts(page, CONFIRM_TEXTS);
      await delay(3000);
      return true;
    }
  }
  return false;
}

/** Recorre las cuentas de una empresa y devuelve un AccountBalance por cada una */
async function scrapeCompanyAccounts(
  page: Page,
  company: CompanyRef,
  debugLog: string[],
  limits: { maxAccounts: number; maxPages: number },
): Promise<AccountBalance[]> {
  const accountOptions = await listAccountOptions(page);
  const accounts: AccountBalance[] = [];

  if (accountOptions.length === 0) {
    const movements = await paginateCartola(page, debugLog, limits.maxPages);
    const balance = await extractBalance(page).catch(() => undefined);
    debugLog.push(`  ${company.rut}: ${movements.length} movimiento(s) (cuenta única)`);
    return [
      {
        label: company.name ? `${company.name} — Cartola` : `Cartola ${company.rut}`,
        balance,
        movements,
        holderRut: company.rut,
        ...(company.name && { holderName: company.name }),
      },
    ];
  }

  debugLog.push(`  ${company.rut}: ${accountOptions.length} cuenta(s) en la cartola`);

  for (const option of accountOptions.slice(0, limits.maxAccounts)) {
    const switched = await selectAccount(page, option);
    if (!switched) {
      debugLog.push(`  No se pudo seleccionar la cuenta ${option.label}`);
      continue;
    }
    const movements = await paginateCartola(page, debugLog, limits.maxPages);
    const balance = await extractBalance(page).catch(() => undefined);
    debugLog.push(`  ${company.rut} / ${option.label}: ${movements.length} movimiento(s)`);
    accounts.push({
      label: option.label,
      balance,
      movements,
      holderRut: company.rut,
      ...(company.name && { holderName: company.name }),
    });
  }

  return accounts;
}

// ─── Login ───────────────────────────────────────────────────────────

/** Devuelve el iframe del formulario de login, solo si ya tiene los campos */
async function findLoginFrame(page: Page): Promise<Frame | null> {
  for (const frame of page.frames()) {
    const url = frame.url();
    if (!url.includes(LOGIN_FRAME_MARKER) && !url.includes(LOGIN_HOST_MARKER)) continue;
    const ready = await frame
      .evaluate(() => !!document.querySelector('input[type="password"]'))
      .catch(() => false);
    if (ready) return frame;
  }
  return null;
}

/**
 * Espera a que cargue el iframe del login. Si api.officebanking.cl rechaza la
 * conexión (pasa de forma intermitente), recarga y vuelve a abrir el panel.
 */
async function waitForLoginFrame(
  page: Page,
  debugLog: string[],
  attempts = 3,
): Promise<Frame | null> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const frame = await findLoginFrame(page);
      if (frame) return frame;
      await delay(1000);
    }

    if (attempt === attempts) break;
    debugLog.push(`  El iframe de login no cargó (intento ${attempt}/${attempts}); recargando...`);
    await page.reload({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
    await delay(3000);
    await dismissBanners(page);
    await clickByTexts(page, ["ingresar", "iniciar sesión"]);
    await delay(3000);
  }

  return null;
}

/** Abre la primera URL que termine mostrando el iframe de login */
async function openLogin(page: Page, debugLog: string[]): Promise<Frame | null> {
  const urls = [process.env.SANTANDER_OFFICE_URL, ...LOGIN_URL_CANDIDATES].filter(
    (u): u is string => !!u,
  );

  for (const url of urls) {
    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    } catch {
      debugLog.push(`  No cargó ${url}`);
      continue;
    }
    await delay(2500);
    await dismissBanners(page);

    const clicked = await clickByTexts(page, ["ingresar", "iniciar sesión"]);
    if (clicked) {
      debugLog.push(`  Click en "${clicked}" para abrir el panel de login`);
      await delay(3000);
    }

    const frame = await waitForLoginFrame(page, debugLog);
    if (frame) {
      debugLog.push(`  Formulario de login: ${frame.url()}`);
      return frame;
    }
  }

  return null;
}

/**
 * El login se da por bueno solo cuando el iframe desaparece Y la página
 * muestra algo de sesión iniciada. Sin esto, cualquier página sin mensajes
 * de error pasaba como "login OK".
 */
async function isLoggedIn(page: Page): Promise<boolean> {
  if (await findLoginFrame(page)) return false;
  return await page
    .evaluate(() => {
      const text = (document.body?.innerText || "").toLowerCase();
      return ["cerrar sesión", "cerrar sesion", "mis productos", "cartola"].some((k) =>
        text.includes(k),
      );
    })
    .catch(() => false);
}

async function waitForLogin(page: Page, timeoutMs = 45000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isLoggedIn(page)) return true;
    await delay(2000);
  }
  return false;
}

/**
 * Envía el formulario con un click de mouse real (no `element.click()` desde
 * evaluate). El portal corre reCAPTCHA en el submit y los eventos sintéticos
 * no siempre lo disparan.
 */
async function nativeSubmit(ctx: Page | Frame, debugLog: string[]): Promise<boolean> {
  for (const selector of LOGIN_SELECTORS.submitSelectors) {
    try {
      const handle = await ctx.$(selector);
      if (!handle) continue;
      await handle.click({ delay: 60 });
      debugLog.push(`  Submit: click real en ${selector}`);
      return true;
    } catch {
      // siguiente selector
    }
  }
  return false;
}

/** Texto del iframe de login, para distinguir CAPTCHA de clave mala */
async function loginFrameText(page: Page): Promise<string> {
  const frame = await findLoginFrame(page);
  if (!frame) return "";
  return await frame
    .evaluate(() => (document.body?.innerText || "").toLowerCase())
    .catch(() => "");
}

/** Llena el RUT de la empresa si el formulario lo pide */
async function fillCompanyRut(ctx: Page | Frame, companyRut: string): Promise<boolean> {
  for (const selector of COMPANY_RUT_SELECTORS) {
    try {
      const element = await ctx.$(selector);
      if (!element) continue;
      await element.click({ clickCount: 3 });
      await element.type(companyRut.replace(/[.\-]/g, ""), { delay: 45 });
      return true;
    } catch {
      // siguiente selector
    }
  }
  return false;
}

// ─── Scrape principal ────────────────────────────────────────────────

async function scrapeSantanderOffice(
  session: BrowserSession,
  options: ScraperOptions,
): Promise<ScrapeResult> {
  const { rut, password, saveScreenshots, headful, onProgress } = options;
  const { debugLog, screenshot: doSave } = session;

  // Con Chrome adjunto la pestaña útil es la que el usuario ya tiene en el portal.
  let page = session.page;
  if (session.attached) {
    const tabs = await session.browser.pages().catch(() => [] as Page[]);
    const portalTab = tabs.find((tab) => tab.url().includes("officebanking"));
    if (portalTab) {
      page = portalTab;
      debugLog.push("  Pestaña de Office Banking tomada del navegador adjunto.");
    }
  }
  const progress = onProgress || (() => {});
  const bank = "santander-office";

  const rutFilter = parseRutFilter(process.env.SANTANDER_OFFICE_RUTS);
  const maxCompanies = clampInt(process.env.SANTANDER_OFFICE_MAX_RUTS, 20, 1, 100);
  const maxAccounts = clampInt(process.env.SANTANDER_OFFICE_MAX_ACCOUNTS, 10, 1, 50);
  const maxPages = clampInt(process.env.SANTANDER_OFFICE_MAX_PAGES, 25, 1, 100);
  const companyRut = process.env.SANTANDER_OFFICE_COMPANY_RUT;
  const manualTimeoutSec = clampInt(process.env.SANTANDER_OFFICE_MANUAL_TIMEOUT_SEC, 300, 60, 900);
  // Con reCAPTCHA activo el POST automático siempre vuelve 403; este flag evita
  // mandar las credenciales a un endpoint que ya sabemos que las rechaza.
  const manualLogin = /^(1|true|si|sí)$/i.test(process.env.SANTANDER_OFFICE_MANUAL_LOGIN ?? "");

  const fail = async (error: string): Promise<ScrapeResult> => {
    const ss = (await page.screenshot({ encoding: "base64" }).catch(() => undefined)) as
      | string
      | undefined;
    return { success: false, bank, accounts: [], error, screenshot: ss, debug: debugLog.join("\n") };
  };

  // El portal falla de formas que no dejan rastro en el DOM (el iframe de
  // login muere, el POST se rechaza). Sin esto el debug log queda mintiendo.
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (!url.includes("officebanking") && !url.includes("santander")) return;
    debugLog.push(
      `  ✗ ${request.method()} ${url.slice(0, 120)} → ${request.failure()?.errorText ?? "?"}`,
    );
  });
  let loginPostStatus: number | null = null;
  page.on("response", (response) => {
    if (!response.url().includes(LOGIN_FRAME_MARKER)) return;
    const method = response.request().method();
    if (method === "POST" && response.url().endsWith("/login")) {
      loginPostStatus = response.status();
    }
    debugLog.push(`  → ${method} ${response.url().slice(0, 120)} → HTTP ${response.status()}`);
  });

  // 1. Login
  debugLog.push("1. Abriendo Office Banking...");
  progress("Abriendo Office Banking...");
  // Con el navegador adjunto la sesión suele venir ya iniciada por el usuario.
  const alreadyLogged = await isLoggedIn(page);
  let ctx: Frame | null = null;

  if (alreadyLogged) {
    debugLog.push("  Sesión ya iniciada en el navegador: se omite el login.");
  } else {
    ctx = await openLogin(page, debugLog);
    if (!ctx) {
      return fail(
        "No cargó el formulario de login (iframe de api.officebanking.cl). " +
          "Con Chrome adjunto (CHROME_DEBUG_PORT), inicia sesión tú en esa ventana y vuelve a correrlo. " +
          "Si el portal cambió de URL, fíjala con SANTANDER_OFFICE_URL.",
      );
    }
    await doSave(page, "01-login");
  }

  if (alreadyLogged || manualLogin) {
    if (!alreadyLogged) {
      debugLog.push("2. SANTANDER_OFFICE_MANUAL_LOGIN activo: no se envían credenciales.");
    }
  } else {
    if (!ctx) return fail("No se encontró el formulario de login.");
    if (companyRut) {
      debugLog.push("2. Llenando RUT de empresa...");
      const filled = await fillCompanyRut(ctx, companyRut);
      debugLog.push(
        filled ? `  RUT empresa: ${normalizeRut(companyRut)}` : "  (sin campo de RUT empresa)",
      );
    }

    debugLog.push("3. Llenando RUT de usuario...");
    progress("Ingresando credenciales...");
    if (!(await fillRut(ctx, rut, LOGIN_SELECTORS))) {
      return fail("No se encontró el campo de RUT de usuario.");
    }
    await delay(600);

    if (!(await fillPassword(ctx, password, LOGIN_SELECTORS))) {
      return fail("No se encontró el campo de clave.");
    }
    await delay(600);

    debugLog.push("4. Enviando login...");
    progress("Iniciando sesión...");

    // Estado del formulario antes de enviarlo: si el botón está deshabilitado
    // (reCAPTCHA sin resolver) clickSubmit cae al Enter y no pasa nada.
    // Solo booleanos: nunca los valores.
    const formState = await ctx
      .evaluate(() => {
        const value = (selector: string) =>
          !!(document.querySelector(selector) as HTMLInputElement | null)?.value;
        const button = document.querySelector("#doLoginButton") as HTMLButtonElement | null;
        return {
          rut: value("#username"),
          clave: value("#password"),
          recaptchaToken: value("#recaptchaToken"),
          boton: button ? (button.disabled ? "deshabilitado" : "habilitado") : "ausente",
        };
      })
      .catch(() => null);
    debugLog.push(`  Formulario: ${JSON.stringify(formState)}`);

    if (!(await nativeSubmit(ctx, debugLog))) {
      await clickSubmit(ctx, page, LOGIN_SELECTORS);
    }
    await delay(6000);
  }
  if (!alreadyLogged) await doSave(page, "02-post-login");

  // 2FA (Santander Pass)
  if (!alreadyLogged && (await detect2FA(page, TWO_FACTOR_CONFIG))) {
    progress("Esperando aprobación de Santander Pass...");
    const approved = await waitFor2FA(page, debugLog, TWO_FACTOR_CONFIG);
    await doSave(page, "02b-after-2fa");
    if (!approved) return fail("Timeout esperando la aprobación del segundo factor.");
  }

  const loginError = alreadyLogged ? null : await detectLoginError(page, await findLoginFrame(page));
  if (loginError) return fail(`Error del banco: ${loginError}`);

  if (!alreadyLogged && !(await waitForLogin(page))) {
    const frameText = await loginFrameText(page);
    const captcha =
      loginPostStatus === 403 ||
      /captcha|verificaci[óo]n de seguridad|no eres un robot/.test(frameText);

    if (captcha) {
      debugLog.push(
        `  El banco rechazó el login automático${loginPostStatus ? ` (HTTP ${loginPostStatus})` : ""}: ` +
          "el formulario exige reCAPTCHA.",
      );
    }

    // El reCAPTCHA no se automatiza. Con Chrome visible le pasamos el control
    // al usuario: entra a mano y el scraper sigue solo desde la sesión abierta.
    if (!headful) {
      return fail(
        manualLogin
          ? "SANTANDER_OFFICE_MANUAL_LOGIN necesita Chrome visible: corre con --headful."
          : captcha
          ? "El banco rechazó el login automático: el formulario de Office Banking exige reCAPTCHA. " +
              "Corre con --headful e inicia sesión a mano; el scraper espera y continúa solo con el recorrido de RUT."
          : "El login no se completó: el formulario sigue en pantalla. " +
              "Revisa screenshots/02-post-login.png para ver qué muestra el portal.",
      );
    }

    debugLog.push(`  Esperando login manual en la ventana de Chrome (${manualTimeoutSec}s máx)...`);
    progress(`Inicia sesión a mano en Chrome — esperando hasta ${manualTimeoutSec}s...`);
    if (!(await waitForLogin(page, manualTimeoutSec * 1000))) {
      return fail(
        `No se detectó la sesión tras ${manualTimeoutSec}s de espera. ` +
          "Si alcanzaste a entrar, súbele el tiempo con SANTANDER_OFFICE_MANUAL_TIMEOUT_SEC.",
      );
    }
    debugLog.push("  Login manual completado.");
  }

  debugLog.push("5. Login OK.");
  progress("Sesión iniciada");
  await closePopups(page);

  // 2. Descubrir RUT disponibles
  debugLog.push("6. Buscando RUT disponibles...");
  progress("Buscando RUT disponibles...");
  // La pestaña adjunta puede venir ya metida dentro de una empresa.
  await returnToCompanySelector(page, debugLog);
  await openCompanySwitcher(page, debugLog);
  await doSave(page, "03-empresas");

  let companies = await discoverCompanies(page, debugLog);
  if (companies.length > 0) {
    debugLog.push(`  ${companies.map((c) => `${c.rut}${c.name ? ` (${c.name})` : ""}`).join(" | ")}`);
  }

  companies = companies.filter((c) => matchesRutFilter(c.rut, rutFilter));
  if (rutFilter.length > 0) {
    debugLog.push(`  Filtro SANTANDER_OFFICE_RUTS: ${companies.length} de ${rutFilter.length} RUT encontrados`);
  }
  companies = companies.slice(0, maxCompanies);

  const accounts: AccountBalance[] = [];

  // 3. Recorrer cada RUT
  if (companies.length === 0) {
    // El usuario puede tener un solo mandato y entrar directo a su cartola.
    debugLog.push("  No se detectó selector de empresas; se usa la sesión actual.");
    progress("Extrayendo cartola...");
    const single: CompanyRef = { rut: normalizeRut(rut), name: "", kind: "element" };
    if (await navigateToCartola(page, debugLog)) {
      await doSave(page, "04-cartola");
      accounts.push(...(await scrapeCompanyAccounts(page, single, debugLog, { maxAccounts, maxPages })));
    }
  } else {
    for (const [index, company] of companies.entries()) {
      progress(`RUT ${index + 1}/${companies.length}: ${company.rut}`);
      debugLog.push(`7.${index + 1} ${company.rut} ${company.name}`);

      if (index > 0) await returnToCompanySelector(page, debugLog);

      if (!(await selectCompany(page, company, debugLog))) continue;
      await doSave(page, `04-${company.rut}-home`);

      if (!(await navigateToCartola(page, debugLog))) continue;
      await doSave(page, `05-${company.rut}-cartola`);

      accounts.push(...(await scrapeCompanyAccounts(page, company, debugLog, { maxAccounts, maxPages })));
    }
  }

  const total = accounts.reduce((sum, a) => sum + a.movements.length, 0);
  debugLog.push(`8. Total: ${total} movimiento(s) en ${accounts.length} cuenta(s)`);
  progress(`Listo — ${total} movimientos en ${accounts.length} cuenta(s)`);
  await doSave(page, "06-final");

  if (accounts.length === 0) {
    return fail(
      "No se pudo leer ninguna cartola. Corre con --headful --screenshots para ver dónde se detuvo.",
    );
  }

  const screenshot = saveScreenshots
    ? ((await page.screenshot({ encoding: "base64", fullPage: true }).catch(() => undefined)) as
        | string
        | undefined)
    : undefined;

  return { success: true, bank, accounts, screenshot, debug: debugLog.join("\n") };
}

// ─── Export ──────────────────────────────────────────────────────────

const santanderOffice: BankScraper = {
  id: "santander-office",
  name: "Santander Office Banking",
  url: BANK_URL,
  scrape: (options) =>
    runScraper("santander-office", options, { viewport: { width: 1366, height: 900 } }, scrapeSantanderOffice),
};

export default santanderOffice;
