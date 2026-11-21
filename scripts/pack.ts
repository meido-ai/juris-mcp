/**
 * Builds the Claude Desktop extension: build/juris-mcp-<version>.mcpb.
 *
 *   npm run pack
 *
 * Steps: compile to dist/, stage dist/ + manifest.json + production node_modules in build/bundle/,
 * validate the manifest, then zip it with the mcpb CLI. Users open the .mcpb file to install it.
 *
 * Optional environment variables:
 *   JURIS_MCP_VERSION            version to stamp (default: package.json's). The release workflow passes the tag.
 *   JURIS_MCP_DEFAULT_URL        pre-fill the settings form, so users only type their user name and password.
 *   JURIS_MCP_DEFAULT_COMPANY      Bake in only values that are fine for anyone who gets the file to see:
 *   JURIS_MCP_DEFAULT_TIME_FILTER  they're readable inside the .mcpb (it's a zip).
 *   JURIS_MCP_DEFAULT_PERSON_TYPES
 *   MCPB_SIGNING_CERT, MCPB_SIGNING_KEY   PEM files: sign the bundle (mcpb sign). Skipped when unset.
 *   MCPB_SIGNING_INTERMEDIATES    space-separated intermediate certificate PEM files, if the CA needs them.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const build = join(root, "build");
const stage = join(build, "bundle");
const mcpb = join(root, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const run = (cmd: string, args: string[], cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
// npm is a .cmd script on Windows, which needs a shell. (node itself doesn't, and its path may contain spaces.)
const runNpm = (args: string[], cwd = root) => execFileSync(npm, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
const env = (name: string) => process.env[name]?.trim() || undefined;

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
const version = (env("JURIS_MCP_VERSION") ?? pkg.version).replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Not a version: "${version}" (expected e.g. 1.2.3)`);

// 1. Compile.
rmSync(join(root, "dist"), { recursive: true, force: true });
runNpm(["run", "build"]);

// 2. Stage: only what the server needs at run time.
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
for (const f of ["package.json", "package-lock.json", "README.md", "LICENSE"]) cpSync(join(root, f), join(stage, f));
if (existsSync(join(root, "icon.png"))) cpSync(join(root, "icon.png"), join(stage, "icon.png"));
runNpm(["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);

// 3. Manifest: stamp the version and the firm's defaults.
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
manifest.version = version;
if (existsSync(join(stage, "icon.png"))) manifest.icon = "icon.png";
const defaults: Record<string, string | undefined> = {
  juris_url: env("JURIS_MCP_DEFAULT_URL"),
  company: env("JURIS_MCP_DEFAULT_COMPANY"),
  time_filter: env("JURIS_MCP_DEFAULT_TIME_FILTER"),
  person_types: env("JURIS_MCP_DEFAULT_PERSON_TYPES"),
};
for (const [key, value] of Object.entries(defaults)) {
  if (value === undefined) continue;
  if (key === "juris_url" && !/^https:\/\//.test(value)) throw new Error("JURIS_MCP_DEFAULT_URL must start with https://");
  manifest.user_config[key].default = value;
  console.log(`default ${key}: ${value}`);
}
writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
run(process.execPath, [mcpb, "validate", join(stage, "manifest.json")]);

// 4. Pack, and sign when a certificate is configured.
const out = join(build, `juris-mcp-${version}.mcpb`);
rmSync(out, { force: true });
run(process.execPath, [mcpb, "pack", stage, out]);
const cert = env("MCPB_SIGNING_CERT");
const key = env("MCPB_SIGNING_KEY");
if (cert && key) {
  const intermediates = env("MCPB_SIGNING_INTERMEDIATES")?.split(/\s+/) ?? [];
  run(process.execPath, [mcpb, "sign", out, "--cert", cert, "--key", key, ...(intermediates.length ? ["--intermediate", ...intermediates] : [])]);
  run(process.execPath, [mcpb, "verify", out]);
} else {
  console.log("Not signed (MCPB_SIGNING_CERT / MCPB_SIGNING_KEY not set). Claude Desktop will show it as unsigned.");
}
console.log(`\nBuilt ${out}`);
