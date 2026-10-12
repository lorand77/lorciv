"use strict";

// The hex maths the canvas leans on: a tile's centre on screen, the tile under
// a click, and the corners it draws. The engine's own tests cover distances,
// neighbours and ranges; nothing there goes through pixels.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { HEX_SIZE, hexToPixel, pixelToHex, hexCorners, hexesInRange, axialRound } = require("../../src/shared/hex");

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
// Rounding can give -0, which deepEqual tells from 0; tile keys ("0,1") do not.
const tile = (x, y, size) => pixelToHex(x, y, size).map((v) => v + 0);

test("a tile's centre maps back to the same tile, at any hex size", () => {
  for (const size of [HEX_SIZE, 20, 75.5]) {
    for (const [q, r] of hexesInRange(0, 0, 6)) {
      const [x, y] = hexToPixel(q, r, size);
      assert.deepEqual(tile(x, y, size), [q, r], `size ${size}, tile ${q},${r}`);
    }
  }
  assert.deepEqual(hexToPixel(0, 0), [0, 0]);
  const [x, y] = hexToPixel(0, 1);
  near(x, HEX_SIZE * Math.sqrt(3) / 2, "the next row is shifted half a hex");
  near(y, HEX_SIZE * 1.5, "rows are 1.5 sizes apart");
});

test("a click anywhere inside a hex picks that hex, up to just inside its corners", () => {
  for (const [q, r] of hexesInRange(2, -1, 2)) {
    const [cx, cy] = hexToPixel(q, r);
    for (const [px, py] of hexCorners(cx, cy)) {
      const x = cx + (px - cx) * 0.95, y = cy + (py - cy) * 0.95;
      assert.deepEqual(tile(x, y), [q, r], `near a corner of ${q},${r}`);
    }
  }
});

test("a click just past an edge picks the neighbour across it", () => {
  const [cx, cy] = hexToPixel(0, 0);
  // Pointy-top: the right-hand edge sits √3/2 of a size from the centre.
  const edge = HEX_SIZE * Math.sqrt(3) / 2;
  assert.deepEqual(tile(cx + edge - 1, cy), [0, 0]);
  assert.deepEqual(tile(cx + edge + 1, cy), [1, 0]);
  assert.deepEqual(tile(cx - edge - 1, cy), [-1, 0]);
});

test("a hex has six corners on its circle, the first at the upper right", () => {
  const corners = hexCorners(100, 50, 10);
  assert.equal(corners.length, 6);
  for (const [x, y] of corners) near(Math.hypot(x - 100, y - 50), 10, "corner radius");
  near(corners[0][0], 100 + 10 * Math.cos(-Math.PI / 6), "first corner x");
  near(corners[0][1], 50 - 5, "first corner y");
  // Pointy-top: straight above and below the centre are corners.
  assert.ok(corners.some(([x, y]) => Math.abs(x - 100) < 1e-9 && Math.abs(y - 40) < 1e-9));
  assert.ok(corners.some(([x, y]) => Math.abs(x - 100) < 1e-9 && Math.abs(y - 60) < 1e-9));
});

test("rounding fixes whichever axis strayed furthest, so q + r + s stays 0", () => {
  assert.deepEqual(axialRound(0.6, 0.1), [1, 0]);   // q furthest off
  assert.deepEqual(axialRound(0.1, 0.6), [0, 1]);   // r furthest off
  assert.deepEqual(axialRound(0.3, 0.3), [0, 0]);   // s furthest off
  assert.deepEqual(axialRound(-2, 3), [-2, 3]);
});
