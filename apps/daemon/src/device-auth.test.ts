import { expect, test } from "bun:test";

import { isDeviceTokenRejected } from "./device-auth";

test("recognizes revoked and unknown device-token errors", () => {
  expect(isDeviceTokenRejected(new Error("Device token has been revoked"))).toBeTrue();
  expect(isDeviceTokenRejected(new Error("Unknown device token"))).toBeTrue();
});

test("does not treat transient backend errors as token revocation", () => {
  expect(isDeviceTokenRejected(new Error("Network unavailable"))).toBeFalse();
});
