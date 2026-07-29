import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getControlSecret,
  ensureFoxpilotDir,
  foxpilotDir,
} from "../control-secret";

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

describe("ensureFoxpilotDir", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "foxpilot-dir-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("names the shared state directory under the user's home", () => {
    expect(foxpilotDir()).toBe(path.join(os.homedir(), ".foxpilot"));
  });

  it("creates the directory 0700 and returns it", () => {
    const dir = path.join(root, ".foxpilot");
    expect(ensureFoxpilotDir(dir)).toBe(dir);
    const stat = fs.statSync(dir);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("is idempotent when the directory already exists", () => {
    const dir = path.join(root, ".foxpilot");
    ensureFoxpilotDir(dir);
    expect(() => ensureFoxpilotDir(dir)).not.toThrow();
  });

  it("throws when the directory cannot be created", () => {
    // browser-api's openBrokerLog relies on this throwing rather than returning
    // a bogus path: that throw is what makes the broker log degrade to "ignore"
    // instead of taking the spawn (and therefore all automation) down with it.
    const blocked = path.join(root, "not-a-dir");
    fs.writeFileSync(blocked, "regular file");
    expect(() => ensureFoxpilotDir(path.join(blocked, ".foxpilot"))).toThrow();
  });
});
