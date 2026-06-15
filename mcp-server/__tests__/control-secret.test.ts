import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getControlSecret } from "../control-secret";

describe("getControlSecret", () => {
  let dir: string;
  const savedEnv = process.env.EXTENSION_SECRET;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foxpilot-secret-"));
    delete process.env.EXTENSION_SECRET;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.EXTENSION_SECRET;
    } else {
      process.env.EXTENSION_SECRET = savedEnv;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns EXTENSION_SECRET from the environment when set", () => {
    process.env.EXTENSION_SECRET = "env-secret-123";
    expect(getControlSecret({ dir })).toBe("env-secret-123");
  });

  it("generates and persists a secret when no env and no file", () => {
    const first = getControlSecret({ dir });
    expect(first.length).toBeGreaterThan(0);
    const file = path.join(dir, "control-secret");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf8").trim()).toBe(first);
  });

  it("returns the same persisted secret on a second call", () => {
    const first = getControlSecret({ dir });
    const second = getControlSecret({ dir });
    expect(second).toBe(first);
  });

  it("writes the secret file with 0600 permissions", () => {
    getControlSecret({ dir });
    const mode = fs.statSync(path.join(dir, "control-secret")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
