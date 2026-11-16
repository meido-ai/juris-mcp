/**
 * Runs the mock Juris Web API on http://localhost:4100.
 *
 *   npm run mock
 *
 * Sign in as 9999000\SMGR / mock-password (Basic auth). Override with MOCK_JURIS_USER, MOCK_JURIS_PASSWORD
 * and MOCK_JURIS_COMPANY (empty for none), and the port with MOCK_JURIS_PORT. Localhost only: plain http.
 */
import type { AddressInfo } from "node:net";
import { loadMockData, MOCK_PERSON_TYPES } from "./data.js";
import { createMockJurisApi } from "./server.js";

export const MOCK_LOGIN = { user: "SMGR", password: "mock-password", companyCode: "9999000" };

/** Start the mock. Port 0 picks a free port. */
export function startMock(opts: { port?: number; log?: boolean } = {}) {
  const data = loadMockData();
  const user = process.env.MOCK_JURIS_USER ?? MOCK_LOGIN.user;
  const password = process.env.MOCK_JURIS_PASSWORD ?? MOCK_LOGIN.password;
  const companyCode = process.env.MOCK_JURIS_COMPANY ?? MOCK_LOGIN.companyCode;
  const app = createMockJurisApi({
    data,
    user,
    password,
    companyCode: companyCode || undefined,
    onRequest: opts.log ? (req) => console.log(`${req.method} ${decodeURIComponent(req.originalUrl.replace(/\+/g, " "))}`) : undefined,
  });
  return new Promise<{ url: string; close: () => Promise<void>; summary: string }>((resolve) => {
    const server = app.listen(opts.port ?? 4100, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://localhost:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
        summary:
          `  ${data.clients.length} clients, ${data.matters.length} matters, ${data.timeEntries.length} time entries\n` +
          `  sign in as ${companyCode ? `${companyCode}\\` : ""}${user} (Basic auth)\n` +
          `  person types: JURIS_API_PERSON_TYPES="${MOCK_PERSON_TYPES}"`,
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mock = await startMock({ port: Number(process.env.MOCK_JURIS_PORT ?? 4100), log: true });
  console.log(`Mock Juris Web API on ${mock.url}\n${mock.summary}`);
}
