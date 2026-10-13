import assert from "node:assert/strict";
import { test } from "node:test";
import { keyFromSeed } from "@rwaix/protocol";
import { issueSelectiveDisclosure, presentSelectiveDisclosure, verifySelectiveDisclosure } from "../src/index.js";

test("SD-JWT discloses only the presented claims", () => {
  const key = keyFromSeed("sd-issuer");
  const claims = { qualificationId: "qual-architect", recipientOrg: "org-design", birthYear: "1990" };
  const salts = { qualificationId: "salt-qualification-01", recipientOrg: "salt-recipient-org-01", birthYear: "salt-birth-year-0001" };
  const issued = issueSelectiveDisclosure(key, claims, salts);
  const presentation = presentSelectiveDisclosure(issued.issuerJws, [issued.disclosures.qualificationId, issued.disclosures.recipientOrg]);
  const verified = verifySelectiveDisclosure(presentation);
  assert.equal(verified.issuer, key.publicRef);
  assert.deepEqual(verified.claims, { qualificationId: "qual-architect", recipientOrg: "org-design" });
  assert.equal("birthYear" in verified.claims, false);
  assert.throws(() => verifySelectiveDisclosure(`${issued.issuerJws}~${issued.disclosures.birthYear}~not-a-disclosure~`));
});
