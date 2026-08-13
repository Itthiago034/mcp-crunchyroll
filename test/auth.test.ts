import { test } from "node:test";
import assert from "node:assert/strict";
import { isTokenExpired, getConfigDir, type TokenData } from "../src/auth.js";

function makeTokens(overrides: Partial<TokenData> = {}): TokenData {
  return {
    access_token: "at",
    refresh_token: "rt",
    expires_at: Date.now() + 3_600_000,
    token_type: "Bearer",
    account_id: "acct123",
    ...overrides,
  };
}

test("isTokenExpired returns false for tokens expiring in the future", () => {
  assert.equal(isTokenExpired(makeTokens()), false);
});

test("isTokenExpired returns true for tokens expired in the past", () => {
  assert.equal(isTokenExpired(makeTokens({ expires_at: Date.now() - 3_600_000 })), true);
});

test("isTokenExpired respects the 60-second expiry buffer", () => {
  // expires within the buffer window -> considered expired
  assert.equal(isTokenExpired(makeTokens({ expires_at: Date.now() + 30_000 })), true);
  // expires just outside the buffer window -> not expired
  assert.equal(isTokenExpired(makeTokens({ expires_at: Date.now() + 90_000 })), false);
});

test("getConfigDir returns a deterministic path rooted in homedir", () => {
  const dir = getConfigDir();
  assert.ok(dir.endsWith(".strider/crunchyroll"));
  // same process, same result
  assert.equal(dir, getConfigDir());
});
