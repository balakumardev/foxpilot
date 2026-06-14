import type { Browser } from "webextension-polyfill";

declare global {
  const browser: Browser;
  const chrome: Browser & {
    offscreen?: {
      createDocument: (options: {
        url: string;
        reasons: string[];
        justification: string;
      }) => Promise<void>;
      closeDocument: () => Promise<void>;
    };
    runtime: Browser["runtime"] & {
      onMessage: Browser["runtime"]["onMessage"] & {
        addListener: (
          callback: (
            message: any,
            sender: any,
            sendResponse: (response?: any) => void
          ) => boolean | void
        ) => void;
      };
    };
  };
}

export {};
