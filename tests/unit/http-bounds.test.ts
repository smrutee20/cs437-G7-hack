// SPEC.md §14 request budget and response-host ingress hygiene, as pure units.
import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { applyRequestBudget, isStrippedIngressHeader, stripIngressHeaders } from "../../packages/http/src/index";

describe("request budget", () => {
  test("a handler that overruns the budget gets a bounded 503; fast handlers are untouched", async () => {
    const app = Fastify({ logger: false });
    applyRequestBudget(app, 50);
    let finished = false;
    app.get("/slow", async () => { await new Promise((done) => setTimeout(done, 200)); finished = true; return { late: true }; });
    app.get("/fast", async () => ({ ok: true }));
    const slow = await app.inject({ method: "GET", url: "/slow" });
    expect([slow.statusCode, slow.json(), slow.headers["cache-control"]])
      .toEqual([503, { error: { code: "temporarily_unavailable", message: "temporarily unavailable" } }, "no-store"]);
    expect((await app.inject({ method: "GET", url: "/fast" })).json()).toEqual({ ok: true });
    await new Promise((done) => setTimeout(done, 250));
    expect(finished).toBe(true); // the overrun handler ran to completion without a second reply or crash
    await app.close();
  });
});

describe("response-host ingress stripping", () => {
  test("identity, client-address, fingerprint and tracing headers are removed; ordinary headers stay", () => {
    const headers: Record<string, unknown> = {
      host: "respond.example.org", accept: "application/json", "content-type": "application/json", "content-length": "10", origin: "x",
      cookie: "a=b", authorization: "Bearer t", "proxy-authorization": "x", forwarded: "for=1.2.3.4", "x-forwarded-for": "1.2.3.4",
      "x-forwarded-proto": "https", "x-real-ip": "1.2.3.4", "true-client-ip": "1.2.3.4", "cf-connecting-ip": "1.2.3.4",
      "fastly-client-ip": "1.2.3.4", "user-agent": "UA", "sec-ch-ua": "x", "sec-ch-ua-platform": "x", traceparent: "00-x", tracestate: "x",
      baggage: "x", "x-request-id": "x", "x-amzn-trace-id": "x", "x-cloud-trace-context": "x", "x-b3-traceid": "x", b3: "x",
      "x-goog-iap-jwt-assertion": "x", "x-ms-client-principal-name": "x", "x-auth-request-email": "x", "x-forwarded-user": "x", via: "1.1 proxy",
    };
    stripIngressHeaders(headers);
    expect(Object.keys(headers).sort()).toEqual(["accept", "content-length", "content-type", "host", "origin"]);
    expect(isStrippedIngressHeader("X-Forwarded-For")).toBe(true);
    expect(isStrippedIngressHeader("content-type")).toBe(false);
  });
});
