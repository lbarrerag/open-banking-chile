import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { DebugLog, findChrome, saveScreenshot } from "../utils.js";

export interface BrowserOptions {
  chromePath?: string;
  /**
   * Puerto de depuración de un Chrome ya abierto por el usuario. Si viene,
   * no se lanza un navegador nuevo: se usa ese. Sirve para portales que
   * bloquean a los navegadores lanzados por automatización (Office Banking).
   * También se lee de CHROME_DEBUG_PORT.
   */
  attachPort?: number;
  headful?: boolean;
  /** Force headless mode off (e.g., Banco Estado TLS fingerprinting) */
  forceHeadful?: boolean;
  extraArgs?: string[];
  viewport?: { width: number; height: number };
  /** Callback invocado en cada línea de debug en tiempo real */
  onDebug?: (line: string) => void;
}

export interface BrowserSession {
  browser: Browser;
  page: Page;
  debugLog: string[];
  /** Save a named screenshot (noop if screenshots disabled) */
  screenshot: (page: Page, name: string) => Promise<void>;
  /** true si nos conectamos a un Chrome del usuario: no se cierra al terminar */
  attached: boolean;
}

const DEFAULT_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--window-size=1280,900",
  "--disable-blink-features=AutomationControlled",
];

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Launches a browser session for scraping.
 *
 * NOTE — Lightpanda (https://lightpanda.io) as a future alternative:
 * Lightpanda is a headless browser written in Zig that uses ~10-20x less memory
 * and runs ~10x faster than Chrome. It supports the Chrome DevTools Protocol (CDP),
 * so swapping would only require changing this function to use puppeteer.connect():
 *
 *   const browser = await puppeteer.connect({
 *     browserWSEndpoint: "ws://127.0.0.1:9222", // Lightpanda serving CDP
 *   });
 *
 * It is NOT integrated yet because (as of early 2026) it is still in beta and has
 * two blockers for banking scrapers:
 *   1. iframe support is incomplete (BCI and Santander rely on iframes)
 *   2. No cookie import/export API (issue #335) — breaks session persistence
 * Worth revisiting once it hits v1.0.
 */
export async function launchBrowser(
  options: BrowserOptions,
  saveScreenshots: boolean,
): Promise<BrowserSession> {
  const { chromePath, attachPort, headful, forceHeadful, extraArgs, viewport, onDebug } = options;
  const debugLog: string[] = onDebug ? new DebugLog(onDebug) : [];

  const doSave = async (p: Page, name: string) =>
    saveScreenshot(p, name, saveScreenshots, debugLog);

  // Modo adjunto: usamos el Chrome que el usuario ya tiene abierto (con su
  // perfil y su sesión). No lleva flags de automatización, así que pasa por
  // los portales que bloquean navegadores lanzados por puppeteer.
  const port = attachPort ?? parseInt(process.env.CHROME_DEBUG_PORT ?? "", 10);
  if (Number.isInteger(port) && port > 0) {
    const browserURL = `http://127.0.0.1:${port}`;
    let browser: Browser;
    try {
      browser = await puppeteer.connect({ browserURL, defaultViewport: null });
    } catch (error) {
      throw new Error(
        `No se pudo conectar a Chrome en ${browserURL}.\n` +
          `  Cierra Chrome por completo y ábrelo así:\n` +
          `  chrome.exe --remote-debugging-port=${port}\n` +
          `  Detalle: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const pages = await browser.pages();
    const page =
      pages.find((p) => p.url().startsWith("http")) ?? pages[0] ?? (await browser.newPage());
    debugLog.push(`  Conectado al Chrome existente en ${browserURL}`);
    return { browser, page, debugLog, screenshot: doSave, attached: true };
  }

  // Some banks (e.g. BancoEstado) block headless browsers via TLS fingerprinting
  // and require a visible Chrome window. On Linux this needs a display server.
  if (forceHeadful && process.platform === "linux") {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      throw new Error(
        "Este banco requiere modo headful (Chrome visible) pero no se detectó display.\n" +
          "  Opciones: exporta DISPLAY=:0, usa una sesión con GUI, o configura Xvfb:\n" +
          "  Xvfb: Xvfb :99 -screen 0 1280x900x24 & export DISPLAY=:99",
      );
    }
  }

  const executablePath = findChrome(chromePath);
  if (!executablePath) {
    throw new Error(
      "No se encontró Chrome/Chromium. Instala Google Chrome o pasa chromePath en las opciones.\n" +
        "  Ubuntu/Debian: sudo apt install google-chrome-stable\n" +
        "  macOS: brew install --cask google-chrome",
    );
  }

  const browser = await puppeteer.launch({
    executablePath,
    headless: forceHeadful ? false : !headful,
    args: [...DEFAULT_ARGS, ...(extraArgs || [])],
  });

  const page = await browser.newPage();
  const vp = viewport || { width: 1280, height: 900 };
  await page.setViewport(vp);
  await page.setUserAgent(DEFAULT_UA);

  // Hide automation signals
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  return { browser, page, debugLog, screenshot: doSave, attached: false };
}
