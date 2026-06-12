import {
  buildInjectorCode,
  buildPollerCode,
  buildEvalPageScript,
  buildUploadPageScript,
  buildDialogPageScript,
  buildEmulatePageScript,
  runInPageWorld,
} from "../injected/page-world";

/**
 * These tests exercise the PURE builders and the `runInPageWorld` orchestrator
 * with a mocked `exec` (the `browser.tabs.executeScript` wrapper). The builders
 * emit strings of isolated-world / page-world JS; we assert on their shape
 * rather than executing them, because jsdom has no isolated-vs-page world
 * separation. The orchestration is verified end-to-end through the mock.
 */
describe("buildInjectorCode", () => {
  it("appends a page-world <script> whose textContent is the JSON-encoded pageScript", () => {
    const pageScript = "document.title = 'hi';";
    const code = buildInjectorCode(pageScript);

    // Creates a <script> element.
    expect(code).toContain("createElement('script')");
    // Embeds the page script safely as the script's textContent.
    expect(code).toContain("textContent");
    expect(code).toContain(JSON.stringify(pageScript));
    // Appends to head or documentElement, then removes the element.
    expect(code).toContain("appendChild");
    expect(code).toContain("document.head");
  });

  it("escapes a pageScript that contains quotes and </script> safely", () => {
    const nasty = `const s = "</script><b>x</b>"; alert('x');`;
    const code = buildInjectorCode(nasty);
    // The `</` sequence is escaped to `<\/`, so a literal closing tag can never
    // appear verbatim in the injector (a JS parser reads `<\/` as `</`).
    expect(code).not.toContain("</script>");
    expect(code).toContain("<\\/script>");
    // The embedded value is still parseable JS: re-deriving the escaped form
    // from the input matches what the builder embeds.
    const escaped = JSON.stringify(nasty).replace(/<\//g, "<\\/");
    expect(code).toContain(escaped);
  });
});

describe("buildPollerCode", () => {
  it("reads the result attribute and removes it when present", () => {
    const attr = "data-bcmcp-result-abc";
    const code = buildPollerCode(attr);
    expect(code).toContain("getAttribute");
    expect(code).toContain("removeAttribute");
    expect(code).toContain(JSON.stringify(attr));
    expect(code).toContain("documentElement");
  });
});

describe("buildEvalPageScript", () => {
  const attr = "data-bcmcp-result-1";

  it("embeds the function source, args, and result attribute", () => {
    const fn = "() => document.title";
    const args = [1, "two", { three: true }];
    const code = buildEvalPageScript(fn, args, attr);

    expect(code).toContain(JSON.stringify(fn));
    expect(code).toContain(JSON.stringify(args));
    expect(code).toContain(JSON.stringify(attr));
  });

  it("references setAttribute and has both ok:true and ok:false branches", () => {
    const code = buildEvalPageScript("() => 1", [], attr);
    expect(code).toContain("setAttribute");
    expect(code).toContain("ok:true");
    expect(code).toContain("ok:false");
  });

  it("produces a script that actually runs in the page world for a sync function", async () => {
    // Although the builder targets the page world, the emitted body is plain JS
    // that we can execute here to prove the contract: it sets the result attr to
    // a JSON {ok:true,value:...} envelope. We run it as the body of a script
    // element appended to the jsdom document.
    document.documentElement.removeAttribute(attr);
    const fn = "() => 6 * 7";
    const code = buildEvalPageScript(fn, [], attr);

    const el = document.createElement("script");
    el.textContent = code;
    document.head.appendChild(el);
    // The eval script is synchronous-ish but wraps in an async IIFE; give the
    // microtask queue a tick to flush before reading the attribute.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    const raw = document.documentElement.getAttribute(attr);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({ ok: true, value: 42 });
    document.documentElement.removeAttribute(attr);
    el.remove();
  });

  it("spreads args into the evaluated function", async () => {
    document.documentElement.removeAttribute(attr);
    const fn = "(a, b) => a + b";
    const code = buildEvalPageScript(fn, [3, 4], attr);

    const el = document.createElement("script");
    el.textContent = code;
    document.head.appendChild(el);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    expect(JSON.parse(document.documentElement.getAttribute(attr) as string)).toEqual({
      ok: true,
      value: 7,
    });
    document.documentElement.removeAttribute(attr);
    el.remove();
  });

  it("captures a thrown error as ok:false with the message", async () => {
    document.documentElement.removeAttribute(attr);
    const fn = "() => { throw new Error('boom'); }";
    const code = buildEvalPageScript(fn, [], attr);

    const el = document.createElement("script");
    el.textContent = code;
    document.head.appendChild(el);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    const parsed = JSON.parse(document.documentElement.getAttribute(attr) as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("boom");
    document.documentElement.removeAttribute(attr);
    el.remove();
  });

  it("maps a top-level undefined return to value:null (not the string 'undefined')", async () => {
    // JSON.stringify(undefined) === undefined, so JSON.parse(undefined) throws.
    // The builder must special-case undefined BEFORE the JSON round-trip,
    // otherwise the catch turns it into the string "undefined".
    document.documentElement.removeAttribute(attr);
    const fn = "() => undefined";
    const code = buildEvalPageScript(fn, [], attr);

    const el = document.createElement("script");
    el.textContent = code;
    document.head.appendChild(el);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    const raw = document.documentElement.getAttribute(attr);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({ ok: true, value: null });
    document.documentElement.removeAttribute(attr);
    el.remove();
  });

  it("escapes a function source containing </script> and a quote safely", () => {
    const nasty = `() => { var s = "</script>"; return s; }`;
    const code = buildEvalPageScript(nasty, [], attr);
    // The `</` sequence is escaped to `<\/`, so a literal closing tag can never
    // appear verbatim (a JS parser reads `<\/` as `</`).
    expect(code).not.toContain("</script>");
    expect(code).toContain("<\\/script>");
  });
});

describe("buildUploadPageScript", () => {
  const attr = "data-bcmcp-result-upload-1";

  it("embeds the uid, filename, mimeType, and result attribute (JSON-encoded)", () => {
    const code = buildUploadPageScript(
      "e7",
      "report.pdf",
      "application/pdf",
      "QUJD", // base64 for "ABC"
      attr
    );

    expect(code).toContain(JSON.stringify("e7"));
    expect(code).toContain(JSON.stringify("report.pdf"));
    expect(code).toContain(JSON.stringify("application/pdf"));
    expect(code).toContain(JSON.stringify("QUJD"));
    expect(code).toContain(JSON.stringify(attr));
  });

  it("uses the DataTransfer + File technique and decodes base64 with atob", () => {
    const code = buildUploadPageScript("e1", "a.txt", "text/plain", "QQ==", attr);

    // The verified technique: reconstruct a File and assign it via DataTransfer.
    expect(code).toContain("DataTransfer");
    expect(code).toContain("new File(");
    expect(code).toContain("atob");
    // charCodeAt loop turns the decoded binary string into a Uint8Array.
    expect(code).toContain("charCodeAt");
    expect(code).toContain("Uint8Array");
    // Assigns to input.files so the browser sees the file as if the user picked it.
    expect(code).toContain(".files");
  });

  it("dispatches bubbling input and change events", () => {
    const code = buildUploadPageScript("e1", "a.txt", "text/plain", "QQ==", attr);
    expect(code).toContain('"input"');
    expect(code).toContain('"change"');
    expect(code).toContain("bubbles");
    expect(code).toContain("dispatchEvent");
  });

  it("resolves the element by its bcmcp uid attribute and has a missing-uid branch", () => {
    const code = buildUploadPageScript("e9", "a.txt", "text/plain", "QQ==", attr);
    // Looks up the element by the snapshot uid attribute.
    expect(code).toContain("data-bcmcp-uid");
    expect(code).toContain("querySelector");
    // Writes a not-found error when the uid no longer resolves.
    expect(code).toContain("not found");
    expect(code).toContain("setAttribute");
  });

  it("has both ok:true and ok:false branches wrapped in try/catch", () => {
    const code = buildUploadPageScript("e1", "a.txt", "text/plain", "QQ==", attr);
    expect(code).toContain("ok:true");
    expect(code).toContain("ok:false");
    expect(code).toContain("try");
    expect(code).toContain("catch");
  });

  it("escapes a filename containing </script> and quotes safely", () => {
    const nasty = `</script><img>"'.png`;
    const code = buildUploadPageScript("e1", nasty, "image/png", "QQ==", attr);
    // The `</` sequence must be escaped so a literal closing tag never appears.
    expect(code).not.toContain("</script>");
    expect(code).toContain("<\\/script>");
  });

  it("reports a missing uid by writing an ok:false envelope to the result attribute", () => {
    // The emitted body is plain JS; running it against jsdom for a uid that does
    // NOT exist exercises the not-found branch end-to-end (no File/DataTransfer
    // needed on this path, so jsdom handles it). The happy path that assigns
    // input.files is browser-only and is covered by the structural assertions
    // above plus the message-handler orchestration test.
    document.documentElement.removeAttribute(attr);
    const code = buildUploadPageScript(
      "missing-uid",
      "a.txt",
      "text/plain",
      "QQ==",
      attr
    );

    const el = document.createElement("script");
    el.textContent = code;
    document.head.appendChild(el);

    const raw = document.documentElement.getAttribute(attr);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("not found");

    document.documentElement.removeAttribute(attr);
    el.remove();
  });
});

describe("buildDialogPageScript", () => {
  const attr = "data-bcmcp-result-dialog-1";

  it("overrides window.alert, window.confirm, and window.prompt", () => {
    const code = buildDialogPageScript("accept", "hi", attr);
    expect(code).toContain("window.alert");
    expect(code).toContain("window.confirm");
    expect(code).toContain("window.prompt");
  });

  it("makes confirm return true and prompt return the promptText when action is accept", () => {
    const code = buildDialogPageScript("accept", "hi", attr);
    // confirm resolves to true on accept.
    expect(code).toContain("return true");
    // prompt returns the embedded promptText on accept.
    expect(code).toContain(JSON.stringify("hi"));
  });

  it("makes confirm return false and prompt return null when action is dismiss", () => {
    const code = buildDialogPageScript("dismiss", undefined, attr);
    expect(code).toContain("return false");
    expect(code).toContain("null");
  });

  it("best-effort clears window.onbeforeunload", () => {
    const code = buildDialogPageScript("accept", undefined, attr);
    expect(code).toContain("onbeforeunload");
  });

  it("embeds the result attribute and has both ok:true and ok:false branches in try/catch", () => {
    const code = buildDialogPageScript("accept", "x", attr);
    expect(code).toContain(JSON.stringify(attr));
    expect(code).toContain("ok:true");
    expect(code).toContain("ok:false");
    expect(code).toContain("try");
    expect(code).toContain("catch");
  });

  it("escapes a promptText containing </script> and quotes safely", () => {
    const nasty = `</script><img>"'`;
    const code = buildDialogPageScript("accept", nasty, attr);
    expect(code).not.toContain("</script>");
    expect(code).toContain("<\\/script>");
  });

  it("arms the page and writes an ok:true envelope when executed (jsdom-safe)", () => {
    // The override installation itself is harmless in jsdom (it just reassigns
    // window.alert/confirm/prompt), so we can execute the emitted body and prove
    // the {ok:true} envelope is written. The actual dialog suppression is
    // browser-only.
    document.documentElement.removeAttribute(attr);
    const code = buildDialogPageScript("accept", "answer", attr);

    const el = document.createElement("script");
    el.textContent = code;
    document.head.appendChild(el);

    const raw = document.documentElement.getAttribute(attr);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({ ok: true });
    // The overrides took effect in this (jsdom) window: confirm now returns true,
    // prompt returns the answer.
    expect(window.confirm()).toBe(true);
    expect(window.prompt()).toBe("answer");

    document.documentElement.removeAttribute(attr);
    el.remove();
  });

  it("dismiss makes confirm false and prompt null when executed (jsdom-safe)", () => {
    document.documentElement.removeAttribute(attr);
    const code = buildDialogPageScript("dismiss", undefined, attr);

    const el = document.createElement("script");
    el.textContent = code;
    document.head.appendChild(el);

    expect(JSON.parse(document.documentElement.getAttribute(attr) as string)).toEqual({
      ok: true,
    });
    expect(window.confirm()).toBe(false);
    expect(window.prompt()).toBeNull();

    document.documentElement.removeAttribute(attr);
    el.remove();
  });
});

describe("buildEmulatePageScript", () => {
  const attr = "data-bcmcp-result-emulate-1";

  it("overrides navigator.geolocation.getCurrentPosition/watchPosition when geolocation is given", () => {
    const code = buildEmulatePageScript(
      { latitude: 1, longitude: 2 },
      undefined,
      attr
    );
    expect(code).toContain("navigator.geolocation");
    expect(code).toContain("getCurrentPosition");
    expect(code).toContain("watchPosition");
  });

  it("embeds the latitude, longitude, and accuracy in the synthetic position", () => {
    const code = buildEmulatePageScript(
      { latitude: 12.5, longitude: -77.25, accuracy: 42 },
      undefined,
      attr
    );
    expect(code).toContain("12.5");
    expect(code).toContain("-77.25");
    expect(code).toContain("42");
    // The synthetic position shape.
    expect(code).toContain("coords");
    expect(code).toContain("timestamp");
  });

  it("defines navigator.userAgent via Object.defineProperty when userAgent is given", () => {
    const code = buildEmulatePageScript(undefined, "UA/1.0", attr);
    expect(code).toContain("Object.defineProperty(navigator");
    expect(code).toContain('"userAgent"');
    expect(code).toContain(JSON.stringify("UA/1.0"));
    expect(code).toContain("configurable");
  });

  it("embeds both geolocation and userAgent together", () => {
    const code = buildEmulatePageScript(
      { latitude: 1, longitude: 2 },
      "UA/1.0",
      attr
    );
    expect(code).toContain("navigator.geolocation");
    expect(code).toContain("Object.defineProperty(navigator");
    expect(code).toContain(JSON.stringify("UA/1.0"));
  });

  it("embeds the result attribute and has both ok:true and ok:false branches in try/catch", () => {
    const code = buildEmulatePageScript({ latitude: 1, longitude: 2 }, "UA/1.0", attr);
    expect(code).toContain(JSON.stringify(attr));
    expect(code).toContain("ok:true");
    expect(code).toContain("ok:false");
    expect(code).toContain("try");
    expect(code).toContain("catch");
  });

  it("escapes a userAgent containing </script> and quotes safely", () => {
    const nasty = `</script>Mozilla"'`;
    const code = buildEmulatePageScript(undefined, nasty, attr);
    expect(code).not.toContain("</script>");
    expect(code).toContain("<\\/script>");
  });

  it("writes an ok:true envelope when executed with only a userAgent (jsdom-safe)", () => {
    // Defining navigator.userAgent is harmless in jsdom; executing the body
    // proves the {ok:true} envelope. (The geolocation override calls back
    // asynchronously and is browser-meaningful, but installation is also
    // harmless here.)
    document.documentElement.removeAttribute(attr);
    const code = buildEmulatePageScript(
      { latitude: 1, longitude: 2 },
      "Emu/9.9",
      attr
    );

    const el = document.createElement("script");
    el.textContent = code;
    document.head.appendChild(el);

    const raw = document.documentElement.getAttribute(attr);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({ ok: true });

    document.documentElement.removeAttribute(attr);
    el.remove();
  });

  it("writes ok:true even when neither geolocation nor userAgent is given", () => {
    document.documentElement.removeAttribute(attr);
    const code = buildEmulatePageScript(undefined, undefined, attr);

    const el = document.createElement("script");
    el.textContent = code;
    document.head.appendChild(el);

    expect(JSON.parse(document.documentElement.getAttribute(attr) as string)).toEqual({
      ok: true,
    });

    document.documentElement.removeAttribute(attr);
    el.remove();
  });
});

describe("runInPageWorld", () => {
  const noSleep = () => Promise.resolve();

  it("injects once, polls until the result attribute appears, and parses it", async () => {
    const resultAttr = "data-bcmcp-result-x";
    const envelope = JSON.stringify({ ok: true, value: 42 });
    const calls: string[] = [];
    // First call is the injector (resolves [true]); subsequent calls are the
    // poller: [null] (not ready yet) then the serialized envelope.
    const responses: any[][] = [[true], [null], [envelope]];
    let i = 0;
    const exec = jest.fn(async (code: string) => {
      calls.push(code);
      return responses[i++] ?? [null];
    });

    const result = await runInPageWorld(
      exec,
      "PAGE_SCRIPT",
      resultAttr,
      1000,
      noSleep
    );

    expect(result).toEqual({ ok: true, value: 42 });
    // The first exec was the injector (contains createElement('script')).
    expect(calls[0]).toContain("createElement('script')");
    // The injector embeds the page script.
    expect(calls[0]).toContain(JSON.stringify("PAGE_SCRIPT"));
    // Later calls are the poller (read the attribute).
    expect(calls[1]).toContain("getAttribute");
  });

  it("returns the inner envelope verbatim (ok:false from the page propagates)", async () => {
    const resultAttr = "data-bcmcp-result-y";
    const envelope = JSON.stringify({ ok: false, error: "page blew up" });
    const responses: any[][] = [[true], [envelope]];
    let i = 0;
    const exec = jest.fn(async () => responses[i++] ?? [null]);

    const result = await runInPageWorld(
      exec,
      "PAGE",
      resultAttr,
      1000,
      noSleep
    );

    expect(result).toEqual({ ok: false, error: "page blew up" });
  });

  it("times out with a CSP hint when the result attribute never appears", async () => {
    const resultAttr = "data-bcmcp-result-z";
    // Injector resolves, then the poller always returns [null].
    const exec = jest.fn(async (code: string) => {
      if (code.includes("createElement('script')")) {
        return [true];
      }
      return [null];
    });

    const result = await runInPageWorld(
      exec,
      "PAGE",
      resultAttr,
      5, // tiny timeout so the loop exits almost immediately
      noSleep
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Content-Security-Policy");
  });

  it("returns ok:false when the stored attribute is not valid JSON", async () => {
    const resultAttr = "data-bcmcp-result-bad";
    const responses: any[][] = [[true], ["this is not json"]];
    let i = 0;
    const exec = jest.fn(async () => responses[i++] ?? [null]);

    const result = await runInPageWorld(
      exec,
      "PAGE",
      resultAttr,
      1000,
      noSleep
    );

    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
  });
});
