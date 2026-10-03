import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleControlUiHttpRequest } from "./control-ui.js";

const servers: Server[] = [];
const origins = new Map<string, string>();

beforeAll(async () => {
  for (const basePath of ["", "/mounted/ui"]) {
    const server = createServer((req, res) => {
      void handleControlUiHttpRequest(req, res, {
        basePath,
        config: { agents: { defaults: { workspace: "/private/synthetic-workspace" } } },
      })
        .then((handled) => {
          if (!handled) {
            res.statusCode = 404;
            res.end("Unclaimed");
          }
        })
        .catch(() => {
          res.statusCode = 500;
          res.end("Fixture failure");
        });
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    origins.set(basePath, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  }
});

afterAll(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("Control UI static interactive SVG viewer HTTP boundary", () => {
  it.each(["", "/mounted/ui"])(
    "serves only a blank, independently sandboxed GET/HEAD at base %s",
    async (basePath) => {
      const url = `${origins.get(basePath)}${basePath}/__openclaw__/svg-viewer`;
      const get = await fetch(url);
      expect(get.status).toBe(200);
      const body = await get.text();
      expect(body).toContain("openclaw-svg-ready");
      expect(body).not.toContain("<svg");
      expect(body).not.toContain("synthetic-workspace");
      const policy = get.headers.get("content-security-policy")?.split("; ");
      expect(policy).toEqual(
        expect.arrayContaining([
          "sandbox allow-scripts",
          "default-src 'none'",
          "script-src 'unsafe-inline'",
          "style-src 'unsafe-inline'",
          "img-src data:",
          "connect-src 'none'",
          "frame-src 'none'",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'self'",
        ]),
      );
      expect(get.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(get.headers.get("cache-control")).toBe("no-store");
      expect(get.headers.get("referrer-policy")).toBe("no-referrer");
      expect(get.headers.get("permissions-policy")).toContain("microphone=()");
      const head = await fetch(url, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(head.headers.get("content-security-policy")).toBe(
        get.headers.get("content-security-policy"),
      );
      const injected = await fetch(
        `${url}?sourceURL=https://example.invalid/secret&document=secret`,
        {
          headers: { authorization: "Bearer synthetic-token" },
        },
      );
      expect(await injected.text()).toBe(body);
      const post = await fetch(url, { method: "POST", body: "untrusted" });
      expect(post.status).toBe(404);
      expect(await post.text()).toBe("Unclaimed");
      for (const suffix of ["/", "/nested", ".html"]) {
        const neighbor = await fetch(`${url}${suffix}`);
        expect(neighbor.status).not.toBe(200);
        expect(neighbor.headers.get("content-security-policy")).not.toContain(
          "script-src 'unsafe-inline'",
        );
        expect(neighbor.headers.get("x-frame-options")).toBe("DENY");
      }
    },
  );

  it("does not admit the viewer outside the configured base path", async () => {
    const response = await fetch(`${origins.get("/mounted/ui")}/__openclaw__/svg-viewer`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Unclaimed");
  });
});
