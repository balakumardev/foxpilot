/**
 * browser-fetch with a `tabId`: a fetch issued INSIDE the tab's page context, in
 * the extension's ISOLATED content-script world.
 *
 * Why it exists: the background-context browser-fetch runs at the extension
 * origin, so its request carries the extension's Origin
 * (moz-extension://<id> / chrome-extension://<id>) and no Referer of the page.
 * APIs that check Origin / Referer / CSRF answer such a request 403/401, often
 * with an empty body. A fetch issued from the page's own context has the page's Origin,
 * Referer and cookies, so it looks like the page's own call.
 *
 * Why not a page-world <script>: strict-CSP pages block it, and the page's own
 * (possibly patched) `window.fetch` would be in the way. This runs in the
 * extension's content-script sandbox instead. UNVERIFIED here: whether the
 * page's CSP `connect-src` applies to the request made from that sandbox.
 *
 * Firefox MV2 caveat: a plain `fetch` in a Firefox MV2 content script carries
 * the EXTENSION principal (extension Origin, extension cross-origin privileges)
 * and would silently reproduce the very problem this fixes. Firefox exposes the
 * page-principal fetch as `content.fetch`; `window.wrappedJSObject.fetch` (with
 * `cloneInto` for the init object) is the fallback. Chrome has neither, so the
 * plain `fetch` is the page-context one there.
 *
 * NO PAGE TIMERS: this function never sleeps or sets a timeout. A hidden tab
 * clamps page timers to one tick per second, so the timeout is raced from the
 * extension background (tab-fetch.ts) and, when it fires, the background calls
 * `abortFetchInTab` to cancel the request. Here an AbortController is only
 * registered so that call can find it.
 *
 * Both functions are injected by `.toString()` (Firefox: a code string; Chrome:
 * scripting.executeScript `func`), so each MUST stay fully self-contained: inner
 * helpers only, no imports or module references (guarded by
 * self-containment.test.ts). Their bodies are byte-identical in the two
 * extensions (guarded by mirror.test.ts). Every value returned is
 * JSON-serializable.
 */

export interface FetchInTabArgs {
  /** Correlates a later abortFetchInTab call with this request. */
  requestId: string;
  /** Absolute URL, already resolved by the background against the tab URL. */
  url: string;
  /**
   * The origin the background gated (deny-list + host permission). If the tab
   * has navigated to another origin since, nothing is sent.
   */
  expectOrigin?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  bodyBase64?: string;
  /** Defaults to "same-origin", fetch's own default (the page's own default). */
  credentials?: "include" | "omit" | "same-origin";
  redirect?: "follow" | "manual" | "error";
  /** Body bytes kept; the rest is not read. Defaults to 5,000,000. */
  maxBytes?: number;
}

export interface FetchInTabResult {
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  finalUrl?: string;
  bodyText?: string;
  bodyBase64?: string;
  truncated?: boolean;
  error?: string;
}

export async function fetchInTab(
  args: FetchInTabArgs
): Promise<FetchInTabResult> {
  const DEFAULT_MAX_BYTES = 5000000;
  const REGISTRY_KEY = "__foxpilotTabFetches";
  const g: any = globalThis;

  // Same textual rules as the background path (browser-http.ts isTextualContentType).
  function isTextual(ct: string | null | undefined): boolean {
    if (!ct) {
      return false;
    }
    const type = ct.split(";")[0].trim().toLowerCase();
    if (type.startsWith("text/")) {
      return true;
    }
    if (
      type === "application/json" ||
      type === "application/xml" ||
      type === "application/javascript" ||
      type === "application/x-www-form-urlencoded"
    ) {
      return true;
    }
    if (/^application\/.+\+json$/.test(type)) {
      return true;
    }
    if (/^application\/.+\+xml$/.test(type)) {
      return true;
    }
    return false;
  }

  function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }

  // Built in 8 KiB slices: one String.fromCharCode over a whole body would
  // overflow the argument limit.
  function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    const SLICE = 0x2000;
    for (let i = 0; i < bytes.length; i += SLICE) {
      const part = bytes.subarray(i, i + SLICE);
      let chunk = "";
      for (let j = 0; j < part.length; j++) {
        chunk += String.fromCharCode(part[j]);
      }
      binary += chunk;
    }
    return btoa(binary);
  }

  function messageOf(e: any): string {
    return String((e && e.message) || e);
  }

  // Shared with abortFetchInTab through the world's global, which lasts across
  // injections into the same document.
  const registry: Map<string, AbortController> =
    g[REGISTRY_KEY] || (g[REGISTRY_KEY] = new Map());
  let controller: AbortController | undefined;

  try {
    const pageOrigin: string = g.location ? g.location.origin : "";
    if (args.expectOrigin && pageOrigin && pageOrigin !== args.expectOrigin) {
      return {
        ok: false,
        error:
          "The tab navigated to " +
          pageOrigin +
          " after the origin " +
          args.expectOrigin +
          " was checked, so nothing was sent. Retry against the page that is open now.",
      };
    }

    // The page-principal fetch. Firefox MV2 content scripts: `content.fetch`,
    // else the page's own fetch through wrappedJSObject (init cloned into the
    // page realm). Chrome and Firefox MV3: the content-script fetch is already
    // made as the page.
    let fetchImpl: (u: string, i: any) => any;
    if (
      g.content &&
      typeof g.content === "object" &&
      typeof g.content.fetch === "function"
    ) {
      fetchImpl = function (u, i) {
        return g.content.fetch(u, i);
      };
    } else if (
      g.wrappedJSObject &&
      typeof g.wrappedJSObject.fetch === "function" &&
      typeof g.cloneInto === "function"
    ) {
      fetchImpl = function (u, i) {
        return g.wrappedJSObject.fetch(
          u,
          g.cloneInto(i, g.wrappedJSObject, { wrapReflectors: true })
        );
      };
    } else {
      fetchImpl = function (u, i) {
        return g.fetch(u, i);
      };
    }

    const init: any = {
      method: args.method || "GET",
      credentials: args.credentials || "same-origin",
      redirect: args.redirect || "follow",
    };
    if (args.headers) {
      init.headers = args.headers;
    }
    if (args.body !== undefined) {
      init.body = args.body;
    } else if (args.bodyBase64 !== undefined) {
      init.body = base64ToBytes(args.bodyBase64);
    }

    if (typeof AbortController === "function") {
      controller = new AbortController();
      init.signal = controller.signal;
      registry.set(args.requestId, controller);
    }

    let pending: any;
    try {
      pending = fetchImpl(args.url, init);
    } catch (syncError) {
      // A standard fetch() reports problems as a REJECTED promise, so a
      // synchronous throw only comes from a path that converts its arguments
      // eagerly (the cloneInto route, or a privileged wrapper): the call was
      // refused before any request existed. If the signal is what it choked on,
      // drop it and call once more; the request then just cannot be aborted on
      // timeout. A network failure is an async rejection and is never retried
      // here, because a retry could send the request twice.
      if (init.signal === undefined) {
        throw syncError;
      }
      delete init.signal;
      registry.delete(args.requestId);
      controller = undefined;
      pending = fetchImpl(args.url, init);
    }
    const resp: any = await pending;

    const maxBytes =
      typeof args.maxBytes === "number" && args.maxBytes >= 0
        ? args.maxBytes
        : DEFAULT_MAX_BYTES;
    let bytes: Uint8Array;
    let truncated = false;
    const stream: any = resp.body;
    if (stream && typeof stream.getReader === "function") {
      // Stop reading at the cap instead of downloading the whole body.
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const step = await reader.read();
        if (step.done) {
          break;
        }
        const value: Uint8Array | undefined = step.value;
        if (!value) {
          continue;
        }
        if (total + value.byteLength > maxBytes) {
          const room = maxBytes - total;
          if (room > 0) {
            chunks.push(value.subarray(0, room));
            total += room;
          }
          truncated = true;
          try {
            await reader.cancel();
          } catch (e) {
            /* already closed */
          }
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
      bytes = new Uint8Array(total);
      let offset = 0;
      for (let i = 0; i < chunks.length; i++) {
        bytes.set(chunks[i], offset);
        offset += chunks[i].byteLength;
      }
    } else {
      const full = new Uint8Array(await resp.arrayBuffer());
      if (full.byteLength > maxBytes) {
        bytes = full.slice(0, maxBytes);
        truncated = true;
      } else {
        bytes = full;
      }
    }

    const headers: Record<string, string> = {};
    if (resp.headers && typeof resp.headers.forEach === "function") {
      resp.headers.forEach(function (value: string, key: string) {
        headers[key] = value;
      });
    }
    const contentType =
      resp.headers && typeof resp.headers.get === "function"
        ? resp.headers.get("content-type")
        : null;

    const result: FetchInTabResult = {
      ok: true,
      status: resp.status,
      statusText: resp.statusText,
      headers: headers,
      finalUrl: resp.url,
      truncated: truncated,
    };
    if (isTextual(contentType)) {
      result.bodyText = new TextDecoder("utf-8").decode(bytes);
    } else {
      result.bodyBase64 = bytesToBase64(bytes);
    }
    return result;
  } catch (e: any) {
    if (controller && controller.signal.aborted) {
      return { ok: false, error: "The request was aborted." };
    }
    let message = messageOf(e);
    // A cross-origin target is subject to the page's CORS rules, and the
    // browser reports a CORS refusal as a bare network error.
    try {
      const pageOrigin: string = g.location ? g.location.origin : "";
      if (
        e &&
        e.name === "TypeError" &&
        pageOrigin &&
        new URL(args.url).origin !== pageOrigin
      ) {
        message +=
          " (the target is a different origin than the page, so the page's CORS rules apply; the server may not allow origin " +
          pageOrigin +
          ")";
      }
    } catch (ignored) {
      /* keep the plain message */
    }
    return { ok: false, error: message };
  } finally {
    registry.delete(args.requestId);
  }
}

/**
 * Cancels a request started by `fetchInTab` (looked up by `requestId`). Called
 * from the background when its timeout fires. Returns whether one was found.
 */
export function abortFetchInTab(requestId: string): boolean {
  const g: any = globalThis;
  const registry: Map<string, AbortController> | undefined =
    g["__foxpilotTabFetches"];
  if (!registry) {
    return false;
  }
  const controller = registry.get(requestId);
  if (!controller) {
    return false;
  }
  try {
    controller.abort();
  } catch (e) {
    /* already settled */
  }
  registry.delete(requestId);
  return true;
}
