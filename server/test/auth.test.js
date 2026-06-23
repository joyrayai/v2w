import test from "node:test";
import assert from "node:assert/strict";
import { createLoginRateLimiter, signToken, verifyToken } from "../src/auth.js";

test("signed tokens expire by session version after password reset", () => {
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "test-session-secret";
  try {
    const user = { id: "user_1", username: "worker", sessionVersion: 1 };
    const token = signToken(user);
    assert.equal(verifyToken(token, [user])?.id, "user_1");
    assert.equal(verifyToken(token, [{ ...user, sessionVersion: 2 }]), null);
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }
});

test("login rate limiter blocks repeated failures without exposing account existence", () => {
  const limiter = createLoginRateLimiter({ maxAttempts: 2, windowMs: 60_000 });
  const req = { ip: "127.0.0.1" };
  limiter.assertAllowed(req, "worker@example.com");
  limiter.recordFailure(req, "worker@example.com");
  limiter.assertAllowed(req, "worker@example.com");
  limiter.recordFailure(req, "worker@example.com");
  assert.throws(() => limiter.assertAllowed(req, "worker@example.com"), /登录尝试过于频繁/);
  limiter.recordSuccess(req, "worker@example.com");
  assert.doesNotThrow(() => limiter.assertAllowed(req, "worker@example.com"));
});
