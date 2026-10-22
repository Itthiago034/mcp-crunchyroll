import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { createSessionEligibilityStore, sessionEligibilityPath } from "../src/transport/session-eligibility.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "eligibility-"));
  dirs.push(dir);
  return dir;
}

describe("session eligibility marker", () => {
  test("lives next to the dedicated profile, never inside it", () => {
    const path = sessionEligibilityPath("/home/x/.strider/crunchyroll/browser-profile");
    assert.equal(path, "/home/x/.strider/crunchyroll/silent-reauth-eligible.json");
  });

  test("record → eligible; clear → not eligible; it stores no secret", async () => {
    const path = join(scratch(), "nested", "marker.json");
    const store = createSessionEligibilityStore(path, () => 1234);
    assert.equal(await store.isEligible(), false);
    await store.record();
    assert.equal(await store.isEligible(), true);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), { version: 1, established_at: 1234 });
    await store.clear();
    assert.equal(await store.isEligible(), false);
    await store.clear();
  });

  test("a marker with loose permissions is not trusted", async () => {
    const path = join(scratch(), "marker.json");
    const store = createSessionEligibilityStore(path);
    await store.record();
    chmodSync(path, 0o644);
    assert.equal(await store.isEligible(), false);
  });

  test("a symlink is never followed, and clear removes the link, not its target", async () => {
    const dir = scratch();
    const target = join(dir, "target.json");
    writeFileSync(target, JSON.stringify({ version: 1, established_at: 1 }), { mode: 0o600 });
    const path = join(dir, "marker.json");
    symlinkSync(target, path);
    const store = createSessionEligibilityStore(path);
    assert.equal(await store.isEligible(), false);
    await assert.rejects(store.record());
    await store.clear();
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(target), true);
  });

  test("malformed or foreign content is not eligible", async () => {
    const dir = scratch();
    for (const content of ["", "{}", "not json", JSON.stringify({ version: 2, established_at: 1 }), JSON.stringify({ version: 1, established_at: "x" })]) {
      const path = join(dir, `m-${Math.random()}.json`);
      writeFileSync(path, content, { mode: 0o600 });
      assert.equal(await createSessionEligibilityStore(path).isEligible(), false, content);
    }
  });
});
