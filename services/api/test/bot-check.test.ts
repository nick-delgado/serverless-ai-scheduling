/**
 * The Turnstile verifier against a fake `fetch`. The token and secret strings are Cloudflare's documented dummy
 * values (https://developers.cloudflare.com/turnstile/troubleshooting/testing/): the always-passes secret
 * `1x0000000000000000000000000000000AA`, the always-fails secret `2x0000000000000000000000000000000AA`, and a
 * dummy token `XXXX.DUMMY.TOKEN.XXXX`. Nothing here calls Cloudflare.
 */
import { describe, expect, it, vi } from "vitest";

import { createTurnstileVerifier, SITEVERIFY_TIMEOUT_MS, SITEVERIFY_URL } from "../src/lib/bot-check";

const PASS_SECRET = "1x0000000000000000000000000000000AA";
const FAIL_SECRET = "2x0000000000000000000000000000000AA";
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(reply: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve().then(reply);
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("createTurnstileVerifier", () => {
  it("accepts a token Cloudflare validates, posting the secret and the token to siteverify", async () => {
    const f = fakeFetch(() => json({ success: true, hostname: "localhost", "error-codes": [] }));
    const verify = createTurnstileVerifier({ secret: PASS_SECRET, fetch: f.impl });

    await expect(verify(TOKEN)).resolves.toEqual({ ok: true });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(SITEVERIFY_URL);
    expect(SITEVERIFY_URL).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(f.calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({ secret: PASS_SECRET, response: TOKEN });
    expect(f.calls[0]?.init.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("never sends the visitor's address (no remoteip)", async () => {
    const f = fakeFetch(() => json({ success: true }));
    await createTurnstileVerifier({ secret: PASS_SECRET, fetch: f.impl })(TOKEN);
    expect(String(f.calls[0]?.init.body)).not.toContain("remoteip");
  });

  it("gives Cloudflare a 4-second timeout, so a hung call can't hold the Lambda", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const f = fakeFetch(() => json({ success: true }));
    await createTurnstileVerifier({ secret: PASS_SECRET, fetch: f.impl })(TOKEN);
    expect(f.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(4000);
    expect(SITEVERIFY_TIMEOUT_MS).toBe(4000);
    timeout.mockRestore();
  });

  it("rejects a token Cloudflare refuses (success false, with the always-fails secret)", async () => {
    const f = fakeFetch(() => json({ success: false, "error-codes": ["invalid-input-response"] }));
    await expect(createTurnstileVerifier({ secret: FAIL_SECRET, fetch: f.impl })(TOKEN)).resolves.toEqual({
      ok: false,
      reason: "rejected",
    });
  });

  it("rejects a replayed token (timeout-or-duplicate)", async () => {
    const f = fakeFetch(() => json({ success: false, "error-codes": ["timeout-or-duplicate"] }));
    await expect(createTurnstileVerifier({ secret: PASS_SECRET, fetch: f.impl })(TOKEN)).resolves.toEqual({
      ok: false,
      reason: "rejected",
    });
  });

  it("rejects an empty token without calling Cloudflare", async () => {
    const f = fakeFetch(() => json({ success: true }));
    await expect(createTurnstileVerifier({ secret: PASS_SECRET, fetch: f.impl })("")).resolves.toEqual({
      ok: false,
      reason: "rejected",
    });
    expect(f.calls).toHaveLength(0);
  });

  it("rejects a token served on another hostname when one is expected", async () => {
    const f = fakeFetch(() => json({ success: true, hostname: "attacker.example" }));
    const verify = createTurnstileVerifier({
      secret: PASS_SECRET,
      expectedHostname: "demo.example",
      fetch: f.impl,
    });
    await expect(verify(TOKEN)).resolves.toEqual({ ok: false, reason: "rejected" });
  });

  it("reads a secret problem as unavailable even when a hostname is expected and none came back", async () => {
    const f = fakeFetch(() => json({ success: false, "error-codes": ["invalid-input-secret"] }));
    const verify = createTurnstileVerifier({
      secret: PASS_SECRET,
      expectedHostname: "demo.example",
      fetch: f.impl,
    });
    await expect(verify(TOKEN)).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("accepts a token served on the expected hostname", async () => {
    const f = fakeFetch(() => json({ success: true, hostname: "demo.example" }));
    const verify = createTurnstileVerifier({
      secret: PASS_SECRET,
      expectedHostname: "demo.example",
      fetch: f.impl,
    });
    await expect(verify(TOKEN)).resolves.toEqual({ ok: true });
  });

  it("skips the hostname check when none is expected (Cloudflare's test keys report localhost)", async () => {
    const f = fakeFetch(() => json({ success: true, hostname: "localhost" }));
    await expect(
      createTurnstileVerifier({ secret: PASS_SECRET, expectedHostname: "", fetch: f.impl })(TOKEN),
    ).resolves.toEqual({ ok: true });
  });

  it.each([
    ["the network fails", () => Promise.reject(new TypeError("fetch failed"))],
    ["Cloudflare answers 500", () => json({ success: false }, 500)],
    ["the body isn't JSON", () => new Response("<html>", { status: 200 })],
    ["the body isn't an object", () => json("ok")],
    ["the body is null", () => json(null)],
  ])("fails closed as unavailable when %s", async (_name, reply) => {
    const f = fakeFetch(reply);
    await expect(createTurnstileVerifier({ secret: PASS_SECRET, fetch: f.impl })(TOKEN)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it.each(["missing-input-secret", "invalid-input-secret", "internal-error"])(
    "reports %s, which is our fault or Cloudflare's, as unavailable and not as the visitor's failure",
    async (code) => {
      const f = fakeFetch(() => json({ success: false, "error-codes": [code] }));
      await expect(createTurnstileVerifier({ secret: PASS_SECRET, fetch: f.impl })(TOKEN)).resolves.toEqual({
        ok: false,
        reason: "unavailable",
      });
    },
  );

  it("reads one server-side code among visitor codes as unavailable", async () => {
    const f = fakeFetch(() =>
      json({ success: false, "error-codes": ["invalid-input-response", "internal-error"] }),
    );
    await expect(createTurnstileVerifier({ secret: PASS_SECRET, fetch: f.impl })(TOKEN)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("treats success: 'true' (a string) as a failure, not a pass", async () => {
    const f = fakeFetch(() => json({ success: "true" }));
    await expect(createTurnstileVerifier({ secret: PASS_SECRET, fetch: f.impl })(TOKEN)).resolves.toEqual({
      ok: false,
      reason: "rejected",
    });
  });
});
