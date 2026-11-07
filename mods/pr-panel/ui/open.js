// Opening links from the panel and the peek: only absolute http(s) URLs, ever.
import { exec } from "herdr";
import { isWebUrl } from "../github.js";

/**
 * Opens an http(s) URL with the system browser. cx.open_url is Herdr's own (it refuses anything
 * that isn't http/https); `open` is the fallback when there's no cx. Never anything else.
 */
export function openWebUrl(url, cx) {
  if (!isWebUrl(url)) return;
  try {
    if (cx && typeof cx.open_url === "function") { cx.open_url(url); return; }
  } catch { /* refused or unavailable: fall through to `open` */ }
  exec("open", [url]).catch(() => {});
}
