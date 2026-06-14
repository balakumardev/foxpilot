/**
 * Offscreen document for DOM operations that require a real DOM (canvas, Image)
 * but cannot run in a service worker. Chrome MV3 service workers have no DOM
 * access, so screenshot compositing is delegated to this offscreen document.
 */

import {
  cropElementFromCapture,
  mimeTypeForFormat,
  planFullPageSteps,
  stitchFullPage,
  stripDataUrlPrefix,
  type ImageFormat,
} from "./injected/screenshot-script";

type OffscreenRequest =
  | {
      type: "cropElement";
      dataUrl: string;
      rect: { x: number; y: number; width: number; height: number; dpr: number };
      format: ImageFormat;
    }
  | {
      type: "stitchFullPage";
      captures: { offsetY: number; dataUrl: string }[];
      dims: { scrollWidth: number; scrollHeight: number; dpr: number };
      format: ImageFormat;
    };

chrome.runtime.onMessage.addListener(
  (message: OffscreenRequest, _sender, sendResponse) => {
    (async () => {
      try {
        if (message.type === "cropElement") {
          const result = await cropElementFromCapture(
            message.dataUrl,
            message.rect,
            message.format
          );
          sendResponse(result);
        } else if (message.type === "stitchFullPage") {
          const result = await stitchFullPage(
            message.captures,
            message.dims,
            message.format
          );
          sendResponse(result);
        }
      } catch (error) {
        console.error("Offscreen error:", error);
        sendResponse({
          mimeType: "image/png",
          base64: "",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return true;
  }
);
