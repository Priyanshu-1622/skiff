import { test } from "node:test";
import assert from "node:assert/strict";
import { groupByDay } from "@skiff/shared";

// groupByDay lives in the shared package (the web UI uses it). The web app has
// no unit-test harness, so it is tested from here, against the built package.
// All dates use local-time constructors so the tests don't depend on the timezone.

const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo, d, h, mi).toISOString();
const NOW = new Date(2026, 9, 8, 15, 30); // 8 Oct 2026, 15:30 local
const entry = (id: string, startedAt: string) => ({ id, startedAt });

test("entries from today share one 'Today' group", () => {
  const groups = groupByDay([entry("a", at(2026, 9, 8, 15)), entry("b", at(2026, 9, 8, 9)), entry("c", at(2026, 9, 8, 0, 5))], NOW);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.label, "Today");
  assert.deepEqual(groups[0]!.items.map((i) => i.id), ["a", "b", "c"]);
});

test("today, yesterday and an older day get their own groups, in order", () => {
  const groups = groupByDay([entry("t", at(2026, 9, 8, 10)), entry("y", at(2026, 9, 7, 20)), entry("o", at(2026, 9, 5, 8))], NOW);
  assert.equal(groups.length, 3);
  assert.equal(groups[0]!.label, "Today");
  assert.equal(groups[1]!.label, "Yesterday");
  assert.ok(groups[2]!.label !== "Today" && groups[2]!.label !== "Yesterday" && groups[2]!.label.length > 0);
  assert.deepEqual(groups.map((g) => g.items.map((i) => i.id)), [["t"], ["y"], ["o"]]);
});

test("the day boundary is local midnight", () => {
  const groups = groupByDay([entry("late", at(2026, 9, 8, 0, 1)), entry("earlier", at(2026, 9, 7, 23, 59))], NOW);
  assert.deepEqual(groups.map((g) => g.label), ["Today", "Yesterday"]);
  const same = groupByDay([entry("a", at(2026, 9, 7, 23, 59)), entry("b", at(2026, 9, 7, 0, 1))], NOW);
  assert.equal(same.length, 1, "00:01 and 23:59 of the same local day share a group");
});

test("a different day is a different group even when the entries are adjacent, and the same older day groups together", () => {
  const groups = groupByDay([entry("a", at(2026, 8, 30, 12)), entry("b", at(2026, 8, 30, 8)), entry("c", at(2026, 8, 29, 22))], NOW);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.items.length), [2, 1]);
  assert.notEqual(groups[0]!.label, groups[1]!.label);
});

test("a date from another year shows the year, one from this year does not", () => {
  const groups = groupByDay([entry("old", at(2025, 11, 24, 12)), entry("new", at(2026, 2, 3, 12))], NOW);
  const byId = Object.fromEntries(groups.map((g) => [g.items[0]!.id, g.label]));
  assert.ok(byId.old!.includes("2025"), byId.old);
  assert.ok(!byId.new!.includes("2026"), byId.new);
});

test("nothing is lost, duplicated or reordered", () => {
  const input = [
    entry("1", at(2026, 9, 8, 14)), entry("2", at(2026, 9, 8, 13)), entry("3", at(2026, 9, 7, 11)),
    entry("4", at(2026, 9, 6, 11)), entry("5", at(2026, 9, 6, 10)), entry("6", at(2026, 8, 1, 10)),
  ];
  const flat = groupByDay(input, NOW).flatMap((g) => g.items.map((i) => i.id));
  assert.deepEqual(flat, ["1", "2", "3", "4", "5", "6"]);
});

test("an unparseable date lands in an 'Earlier' group instead of throwing", () => {
  const groups = groupByDay([entry("good", at(2026, 9, 8, 10)), entry("bad", "not a date")], NOW);
  assert.deepEqual(groups.map((g) => g.label), ["Today", "Earlier"]);
  assert.deepEqual(groups[1]!.items.map((i) => i.id), ["bad"]);
});

test("no entries, no groups", () => {
  assert.deepEqual(groupByDay([], NOW), []);
});
