// `import browser from "webextension-polyfill"` is remapped here by jest's
// moduleNameMapper. Return the same mock the setup file installs on the global,
// so a default-import of the polyfill and the global `browser` are the SAME
// object (a single set of jest.fn() spies to assert against).
import { mockBrowser } from "./setup";

export default mockBrowser;
