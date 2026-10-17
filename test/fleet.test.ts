import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_HEALTH_GUARD,
  DEFAULT_SLOT_CEILING,
  loadFleetConfig,
  saveFleetConfig,
  fleetConfigPath,
} from "../src/fleet.ts";

function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-connector-fleet-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("fleet registry persistence (<paseoHome>/connector/fleet.json)", () => {
  it("loads a default config with a single local Node entry when fleet.json is missing", () => {
    const home = makeTempHome();
    const config = loadFleetConfig(home);

    assert.equal(config.localNodeId, config.nodes[0].id);
    assert.equal(config.nodes.length, 1);

    const local = config.nodes[0];
    assert.equal(local.transport, "local");
    assert.equal(local.posture, "mobile");
    assert.equal(local.slotCeiling, DEFAULT_SLOT_CEILING);
    assert.equal(local.reserveMode, false);
    assert.deepEqual(local.healthGuard, DEFAULT_HEALTH_GUARD);
    assert.ok(local.id.length > 0);
    assert.ok(local.name.length > 0);

    // Loading alone must not create the file on disk.
    assert.equal(existsSync(fleetConfigPath(home)), false);
  });

  it("saves fleet.json under <paseoHome>/connector/ (creating the directory) and roundtrips", () => {
    const home = makeTempHome();
    const config = loadFleetConfig(home);
    saveFleetConfig(home, config);

    const path = fleetConfigPath(home);
    assert.equal(existsSync(path), true);

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(onDisk, config);

    const reloaded = loadFleetConfig(home);
    assert.deepEqual(reloaded, config);
  });

  it("refuses to silently reset a corrupted registry, throwing with the file path", () => {
    const home = makeTempHome();
    mkdirSync(join(home, "connector"), { recursive: true });
    writeFileSync(fleetConfigPath(home), "{ not json", "utf8");

    assert.throws(() => loadFleetConfig(home), (error: Error) => {
      assert.match(error.message, /fleet\.json/);
      return true;
    });
  });
});
