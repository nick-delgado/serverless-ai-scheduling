// @vitest-environment node
import { buildClinicFixture, type ClinicFixture } from "@sched/tools/fixtures";
import { describe, expect, it } from "vitest";

import { BOOKING_PROVIDERS, bookingPlan, fixtureFirstName, planProblems, reschedulePlan } from "./plan";

/** The clinic fixture with `change` applied to a copy. */
function fixtureWith(change: (f: ClinicFixture) => void): ClinicFixture {
  const fixture = structuredClone(buildClinicFixture());
  change(fixture);
  return fixture;
}
const provider = (f: ClinicFixture, id: string) => {
  const found = f.providers.find((p) => p.providerId === id);
  if (!found) throw new Error(id);
  return found;
};

describe("the plan (r1/Q-1 (a))", () => {
  it("books Lee on Chromium, Okafor on WebKit and Haddad on Firefox", () => {
    expect(BOOKING_PROVIDERS).toEqual({
      chromium: "prov_lee",
      webkit: "prov_okafor",
      firefox: "prov_haddad",
    });
    expect(bookingPlan("chromium")).toEqual({
      providerId: "prov_lee",
      doctor: "Dr. Priya Lee",
      reason: "a skin check",
    });
    expect(bookingPlan("firefox").reason).toBe("a blood pressure check");
  });

  it("has no booking for another project", () => {
    expect(() => bookingPlan("chromium-last")).toThrow("No booking planned for project chromium-last");
  });

  it("moves Sofia's seeded appointment with Dr. Alvarez", () => {
    expect(reschedulePlan()).toEqual({
      appointmentId: "appt_01JBXB1F7G8H9J0K1M2N3P4Q5R",
      doctor: "Dr. Elena Alvarez",
    });
  });

  it("greets the patients by their fixture first names", () => {
    expect(fixtureFirstName("pat-sofia")).toBe("Sofia");
    expect(fixtureFirstName("pat-maria")).toBe("Maria");
  });

  it("holds for the clinic fixture", () => {
    expect(planProblems()).toEqual([]);
  });

  it("fails when a booking provider stops taking new patients", () => {
    const fixture = fixtureWith((f) => {
      provider(f, "prov_lee").acceptingNewPatients = false;
    });
    expect(planProblems(fixture)).toEqual(["prov_lee doesn't take new patients"]);
  });

  it("fails when a booking provider becomes Sofia's own", () => {
    const fixture = fixtureWith((f) => {
      const sofia = f.patients.find((p) => p.firstName === "Sofia");
      if (sofia) sofia.preferredProviderId = "prov_haddad";
    });
    expect(planProblems(fixture)).toEqual(["prov_haddad is pat-sofia's own provider"]);
  });

  it("fails when a booking provider leaves the fixture", () => {
    const fixture = fixtureWith((f) => {
      f.providers = f.providers.filter((p) => p.providerId !== "prov_okafor");
    });
    expect(planProblems(fixture)).toEqual(["prov_okafor isn't in the fixture"]);
  });

  it("fails without Sofia", () => {
    const fixture = fixtureWith((f) => {
      f.patients = f.patients.filter((p) => p.firstName !== "Sofia");
    });
    expect(planProblems(fixture)).toEqual(["no fixture patient pat-sofia"]);
  });

  it("fails when Sofia has no seeded BOOKED appointment to move", () => {
    const fixture = fixtureWith((f) => {
      f.appointments = f.appointments.filter((a) => a.appointmentId !== "appt_01JBXB1F7G8H9J0K1M2N3P4Q5R");
    });
    expect(planProblems(fixture)).toEqual(["pat-sofia has 0 seeded BOOKED appointments, not 1"]);
    expect(() => reschedulePlan(fixture)).toThrow("No seeded BOOKED appointment for pat-sofia");
  });
});
