import assert from "node:assert/strict";
import { test } from "node:test";
import { refusalShape } from "../src/transport/browser-api-backend.js";

test("a 403 body is classified by shape only, never by content", () => {
  assert.equal(refusalShape(""), "empty-response");
  assert.equal(refusalShape("   \n"), "empty-response");
  assert.equal(refusalShape("<!DOCTYPE html><title>Just a moment...</title>"), "html-response");
  assert.equal(refusalShape('{"code":"forbidden.not_allowed"}'), "json-response");
  assert.equal(refusalShape("denied"), "other-response");
});
