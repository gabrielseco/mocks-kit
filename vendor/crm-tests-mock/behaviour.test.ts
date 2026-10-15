// What the recordings can't pin: sign-in, mutations and the mock's own guards.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import spec from "@/contracts/openapi.json";
import { handlers, MOCK_LOGIN_CODE } from "@/lib/mock/handlers";
import { handleMockRequest, resetMockStore, SEED_CLOCK } from "@/lib/mock/server";
import { createStore } from "@/lib/mock/store";
import { validate } from "@/lib/mock/validate";
import type { Schemas } from "@/lib/api/schemas";

const SESSION = { cookie: "session_token=mock-session" };

async function call(
  method: string,
  path: string,
  { body, headers = SESSION }: { body?: unknown; headers?: HeadersInit } = {},
) {
  const response = await handleMockRequest(
    new Request(new URL(path, "http://mock.test"), {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: (text === "" ? null : JSON.parse(text)) as any,
    setCookie: response.headers.get("set-cookie"),
  };
}

beforeEach(() => {
  process.env.MOCK_TODAY = SEED_CLOCK;
  resetMockStore(SEED_CLOCK);
});

describe("session", () => {
  it("signs in with the mock code and any email, and rejects other codes", async () => {
    const ok = await call("POST", "/api/auth/verify_code", {
      body: { email: "anyone@example.com", code: MOCK_LOGIN_CODE },
      headers: {},
    });
    expect(ok.status).toBe(200);
    expect(ok.body.user.email).toBe("demo@example.com");
    expect(ok.setCookie).toContain("session_token=mock-session");
    expect(ok.setCookie).toContain("HttpOnly");

    const wrong = await call("POST", "/api/auth/verify_code", {
      body: { email: "anyone@example.com", code: "000000" },
      headers: {},
    });
    expect(wrong.status).toBe(401);
    expect(wrong.setCookie).toBeNull();
  });

  it("answers 401 on an authed route without the session cookie", async () => {
    expect((await call("GET", "/api/crm/trips", { headers: {} })).status).toBe(401);
    expect((await call("GET", "/api/me", { headers: {} })).status).toBe(401);
  });

  it("clears the cookie on logout", async () => {
    const out = await call("DELETE", "/api/auth/logout");
    expect(out.status).toBe(204);
    expect(out.setCookie).toContain("Max-Age=0");
  });
});

describe("the mock's own guards", () => {
  it("answers 501 for an operation it does not mock, naming the route", async () => {
    const response = await call("GET", "/api/expenses?date=2026-01-01T00:00:00Z");
    expect(response.status).toBe(501);
    expect(response.body.mock).toBe(true);
    expect(response.body.error).toContain("GET /api/expenses");
    expect(response.body.error).toContain("listExpenses");
  });

  it("has a handler for every /api/crm operation in the contract", () => {
    const missing: string[] = [];
    for (const [path, item] of Object.entries(spec.paths)) {
      if (!path.startsWith("/api/crm")) continue;
      for (const operation of Object.values(item as Record<string, { operationId?: string }>)) {
        if (operation.operationId && !(operation.operationId in handlers)) {
          missing.push(operation.operationId);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("turns a response the contract does not allow into a 500 naming the operation", async () => {
    const original = handlers.listTrips;
    handlers.listTrips = () => ({ status: 200, body: [{ nope: true }] }) as never;
    try {
      const response = await call("GET", "/api/crm/trips");
      expect(response.status).toBe(500);
      expect(response.body.error).toContain("listTrips");
      expect(response.body.error).toContain("breaks the contract");
    } finally {
      handlers.listTrips = original;
    }
  });

  it("resets the store through the reset endpoint", async () => {
    await call(
      "DELETE",
      `/api/crm/concerts/${(await call("GET", "/api/crm/concerts")).body[0].slug}`,
    );
    expect((await call("GET", "/api/crm/concerts")).body).toHaveLength(3);

    expect((await call("POST", "/api/__mock/reset", { headers: {} })).status).toBe(204);
    expect((await call("GET", "/api/crm/concerts")).body).toHaveLength(4);
  });

  describe("production", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it("refuses API_MODE=mock when deployed to production", async () => {
      vi.stubEnv("API_MODE", "mock");
      vi.stubEnv("VERCEL_ENV", "production");
      vi.stubEnv("BACKEND_URL", "http://backend.test");
      vi.resetModules();

      const { GET } = await import("@/app/api/[...path]/route");
      const { NextRequest } = await import("next/server");
      const response = await GET(new NextRequest("http://app.test/api/crm/trips"), {
        params: Promise.resolve({ path: ["crm", "trips"] }),
      });

      expect(response.status).toBe(500);
      expect((await response.json()).error).toContain("not allowed in production");
    });
  });
});

describe("the seeded data follows today", () => {
  it("slides recorded dates by whole months so the default views have data", () => {
    const recorded = createStore(SEED_CLOCK);
    const slid = createStore("2026-10-14");

    expect(slid.trips[0].start_date).toBe("2026-09-12");
    expect(slid.trips.map((t) => t.nights)).toEqual(recorded.trips.map((t) => t.nights));
    expect(slid.carKm.at(-1)).toMatchObject({ year: 2026, month: 10 });
  });
});

describe("time off", () => {
  const holiday = {
    status: "approved",
    timeoff_type: "public_holiday",
    start_date: "2026-03-19",
    end_date: "2026-03-19",
    hours: 8,
  };

  it("creates an entry as manual, and lists it in date order", async () => {
    const created = await call("POST", "/api/crm/time-off", {
      body: { ...holiday, timeoff_type: "paid_time_off", start_date: "2026-01-02" },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      source: "manual",
      automatic: false,
      in_lieu_used_hours: 0,
    });
    expect(validate(created.body, { $ref: "#/components/schemas/TimeOff" })).toEqual([]);

    const list = (await call("GET", "/api/crm/time-off")).body as Schemas["TimeOff"][];
    const dates = list.map((t) => t.start_date);
    expect(dates).toEqual([...dates].sort());
  });

  it("rejects an entry missing its required fields", async () => {
    const response = await call("POST", "/api/crm/time-off", { body: { status: "approved" } });
    expect(response.status).toBe(422);
    expect(Object.keys(response.body.errors).sort()).toEqual([
      "end_date",
      "start_date",
      "timeoff_type",
    ]);
  });

  it("books a worked holiday and takes hours back until none are left", async () => {
    const created = await call("POST", "/api/crm/time-off", {
      body: { ...holiday, worked_hours: 8 },
    });
    const slug = created.body.slug as string;

    const taken = await call("POST", "/api/crm/time-off", {
      body: {
        status: "approved",
        timeoff_type: "paid_time_off",
        start_date: "2026-03-23",
        end_date: "2026-03-23",
        hours: 5,
        in_lieu_of_slug: slug,
      },
    });
    expect(taken.status).toBe(201);
    expect(taken.body).toMatchObject({ in_lieu_of_slug: slug, in_lieu_of_date: "2026-03-19" });

    const holidayNow = (await call("GET", "/api/crm/time-off?worked=true")).body.find(
      (t: Schemas["TimeOff"]) => t.slug === slug,
    );
    expect(holidayNow.in_lieu_used_hours).toBe(5);

    const tooMuch = await call("POST", "/api/crm/time-off", {
      body: {
        status: "approved",
        timeoff_type: "paid_time_off",
        start_date: "2026-03-24",
        end_date: "2026-03-24",
        hours: 4,
        in_lieu_of_slug: slug,
      },
    });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.errors.in_lieu_of_slug).toEqual(["only has 3h left to take"]);
  });

  it("refuses to lower worked hours below what was taken, and unlinks on delete", async () => {
    const slug = (
      await call("POST", "/api/crm/time-off", { body: { ...holiday, worked_hours: 8 } })
    ).body.slug as string;
    const taken = await call("POST", "/api/crm/time-off", {
      body: {
        status: "approved",
        timeoff_type: "paid_time_off",
        start_date: "2026-03-23",
        end_date: "2026-03-23",
        hours: 6,
        in_lieu_of_slug: slug,
      },
    });

    const lowered = await call("PUT", `/api/crm/time-off/${slug}`, { body: { worked_hours: 4 } });
    expect(lowered.status).toBe(422);
    expect(lowered.body.errors.worked_hours[0]).toContain("already been taken in lieu");

    expect((await call("DELETE", `/api/crm/time-off/${slug}`)).status).toBe(204);
    const list = (await call("GET", "/api/crm/time-off")).body as Schemas["TimeOff"][];
    expect(list.find((t) => t.slug === taken.body.slug)?.in_lieu_of_slug).toBeNull();
  });

  it("only lets worked hours sit on a public holiday, and ignores source on update", async () => {
    const pto = (await call("GET", "/api/crm/time-off?timeoff_type=paid_time_off")).body[0];

    const worked = await call("PUT", `/api/crm/time-off/${pto.slug}`, {
      body: { worked_hours: 4 },
    });
    expect(worked.status).toBe(422);
    expect(worked.body.errors.worked_hours).toEqual(["can only be set on a public holiday"]);

    const source = await call("PUT", `/api/crm/time-off/${pto.slug}`, {
      body: { source: pto.source === "manual" ? "remote_sync" : "manual", notes: "edited" },
    });
    expect(source.body).toMatchObject({ source: pto.source, notes: "edited" });
  });

  it("answers 404 for an unknown slug", async () => {
    const unknown = "00000000-0000-4000-8000-000000000000";
    expect((await call("PUT", `/api/crm/time-off/${unknown}`, { body: {} })).status).toBe(404);
    expect((await call("DELETE", `/api/crm/time-off/${unknown}`)).status).toBe(404);
  });
});

describe("trips, places and residency", () => {
  const unknownTrip = "00000000-0000-4000-8000-000000000000";

  it("validates trip dates and keeps places inside their trip", async () => {
    const backwards = await call("POST", "/api/crm/trips", {
      body: { label: "Oops", start_date: "2026-02-10", end_date: "2026-02-01" },
    });
    expect(backwards.status).toBe(422);
    expect(backwards.body.errors.end_date).toEqual(["must be on or after start_date"]);

    const trip = (
      await call("POST", "/api/crm/trips", {
        body: { label: "Rome", start_date: "2026-02-10", end_date: "2026-02-14" },
      })
    ).body;
    expect(trip.nights).toBe(4);

    const outside = await call("POST", `/api/crm/trips/${trip.slug}/locations`, {
      body: { location: "Naples", start_date: "2026-02-09", end_date: "2026-02-12" },
    });
    expect(outside.status).toBe(422);
    expect(outside.body.errors.start_date[0]).toContain("trip's start_date (2026-02-10)");

    const inside = await call("POST", `/api/crm/trips/${trip.slug}/locations`, {
      body: { location: "Rome", start_date: "2026-02-10", end_date: "2026-02-14" },
    });
    expect(inside.status).toBe(201);
    expect(inside.body.nights).toBe(4);
    expect(inside.body).not.toHaveProperty("trip_slug");
  });

  it("answers 404 for the places of an unknown trip", async () => {
    expect((await call("GET", `/api/crm/trips/${unknownTrip}/locations`)).status).toBe(404);
    expect(
      (
        await call("POST", `/api/crm/trips/${unknownTrip}/locations`, {
          body: { location: "X", start_date: "2026-01-01", end_date: "2026-01-02" },
        })
      ).status,
    ).toBe(404);
  });

  it("deletes a trip's places with it", async () => {
    const trip = (
      await call("POST", "/api/crm/trips", {
        body: { label: "Rome", start_date: "2026-02-10", end_date: "2026-02-14" },
      })
    ).body;
    await call("POST", `/api/crm/trips/${trip.slug}/locations`, {
      body: { location: "Rome", start_date: "2026-02-10", end_date: "2026-02-14" },
    });
    expect((await call("GET", `/api/crm/trips/${trip.slug}/locations`)).body).toHaveLength(1);

    expect((await call("DELETE", `/api/crm/trips/${trip.slug}`)).status).toBe(204);
    expect((await call("GET", `/api/crm/trips/${trip.slug}/locations`)).status).toBe(404);
  });

  it("counts a new trip in the residency summary", async () => {
    const summary = async () =>
      (await call("GET", "/api/crm/residency/summary?start_date=2026-02-01&end_date=2026-02-28"))
        .body as Schemas["ResidencySummary"];

    const before = await summary();
    await call("POST", "/api/crm/trips", {
      body: { label: "Rome", start_date: "2026-02-10", end_date: "2026-02-14" },
    });
    const after = await summary();

    expect(after.days_out_of_home - before.days_out_of_home).toBe(4);
    expect(after.days_at_base).toBe(before.days_at_base - 4);
    // The new trip has no places yet, so its nights are Unassigned.
    const unassigned = (r: Schemas["ResidencySummary"]) =>
      r.by_location.find((l) => l.location === "Unassigned")?.days ?? 0;
    expect(unassigned(after) - unassigned(before)).toBe(4);
  });

  it("gives the same figures for the slid period as the recorded one", async () => {
    const recorded = (
      await call("GET", "/api/crm/residency/summary?start_date=2026-01-01&end_date=2026-01-15")
    ).body;

    // Nine months on, the data sits nine months later: the same fortnight lands in October.
    process.env.MOCK_TODAY = "2026-10-15";
    resetMockStore("2026-10-15");
    const slid = (
      await call("GET", "/api/crm/residency/summary?start_date=2026-10-01&end_date=2026-10-15")
    ).body;

    expect(slid).toMatchObject({
      total_days: recorded.total_days,
      days_out_of_home: recorded.days_out_of_home,
      days_at_base: recorded.days_at_base,
      by_location: recorded.by_location,
    });
  });

  it("closes an ongoing home period when a new one starts", async () => {
    const created = await call("POST", "/api/crm/home-periods", {
      body: { location: "Valencia", start_date: "2026-02-01" },
    });
    expect(created.status).toBe(201);
    expect(created.body.end_date).toBeNull();

    const missing = await call("POST", "/api/crm/home-periods", {
      body: { start_date: "2026-02-01" },
    });
    expect(missing.body.errors.location).toEqual(["can't be blank"]);
  });
});

describe("concerts", () => {
  it("creates, updates and deletes a concert, and the venues follow", async () => {
    const created = await call("POST", "/api/crm/concerts", {
      body: { name: "Sigur Ros", venue: "Palau Sant Jordi", date: "2026-03-01", rating: "great" },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ rolling: false, accompanied: false, expenseSlug: null });

    let venues = (await call("GET", "/api/crm/concerts/venues")).body as { venue: string }[];
    expect(venues[0].venue).toBe("Palau Sant Jordi");

    const updated = await call("PUT", `/api/crm/concerts/${created.body.slug}`, {
      body: { venue: "WiZink Center", rating: null },
    });
    expect(updated.body).toMatchObject({ venue: "WiZink Center", rating: null });

    expect((await call("DELETE", `/api/crm/concerts/${created.body.slug}`)).status).toBe(204);
    venues = (await call("GET", "/api/crm/concerts/venues")).body;
    expect(venues.find((v) => v.venue === "Palau Sant Jordi")).toBeUndefined();
  });

  it("rejects a rating outside the scale", async () => {
    const response = await call("POST", "/api/crm/concerts", {
      body: { name: "X", date: "2026-03-01", rating: "amazing" },
    });
    expect(response.status).toBe(422);
    expect(response.body.errors.rating).toEqual(["is invalid"]);
  });
});

describe("car km", () => {
  it("updates the month's log when one exists instead of adding a second", async () => {
    const first = await call("POST", "/api/crm/car-km", {
      body: { year: 2026, month: 3, km: "512.5" },
    });
    expect(first.status).toBe(201);
    expect(first.body.km).toBe(512.5);

    const again = await call("POST", "/api/crm/car-km", {
      body: { year: 2026, month: 3, km: 600 },
    });
    expect(again.body.slug).toBe(first.body.slug);

    const logs = (await call("GET", "/api/crm/car-km?year=2026")).body as Schemas["CarKm"][];
    expect(logs.filter((l) => l.month === 3)).toHaveLength(1);

    const summary = (await call("GET", "/api/crm/car-km/summary?year=2026")).body;
    expect(summary.months[2]).toMatchObject({ month: 3, km: 600, logged: true });
  });

  it("rejects a month outside 1 to 12 and negative km", async () => {
    const month = await call("POST", "/api/crm/car-km", { body: { year: 2026, month: 13, km: 1 } });
    expect(month.body.errors.month).toEqual(["is invalid"]);

    const km = await call("POST", "/api/crm/car-km", { body: { year: 2026, month: 4, km: -1 } });
    expect(km.body.errors.km).toEqual(["must be greater than or equal to 0"]);
  });
});

describe("invisalign", () => {
  const change = (body: object) => call("POST", "/api/crm/invisalign/change", { body });

  it("logs the next tray of the active series", async () => {
    const before = (await call("GET", "/api/crm/invisalign")).body.series[0];
    const response = await change({
      series_number: before.series_number,
      tray_number: before.tray_number + 1,
      date: "2026-02-10",
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      tray_number: before.tray_number + 1,
      started_at: "2026-02-10",
      expected_duration_days: 7,
    });

    const after = (await call("GET", "/api/crm/invisalign")).body.series[0];
    expect(after.tray_number).toBe(before.tray_number + 1);
    expect(after.logs).toHaveLength(before.logs.length + 1);
  });

  it("creates a series that doesn't exist only when told its size", async () => {
    const unknown = await change({ series_number: 9, tray_number: 1, date: "2026-02-10" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.errors.series).toEqual(["not found"]);

    const created = await change({
      series_number: 9,
      total_trays: 2,
      tray_number: 1,
      date: "2026-02-10",
    });
    expect(created.status).toBe(200);

    const list = (await call("GET", "/api/crm/invisalign")).body.series;
    expect(list[0]).toMatchObject({ series_number: 9, total_trays: 2, active: true });
  });

  it("rejects a tray past the series, a repeated tray and a missing date", async () => {
    const past = await change({
      series_number: 9,
      total_trays: 2,
      tray_number: 3,
      date: "2026-02-10",
    });
    expect(past.status).toBe(422);
    expect(past.body.errors.tray_number).toEqual(["must be less than or equal to 2"]);

    await change({ series_number: 9, total_trays: 2, tray_number: 1, date: "2026-02-10" });
    const repeat = await change({ series_number: 9, tray_number: 1, date: "2026-02-11" });
    expect(repeat.status).toBe(422);

    const noDate = await change({ series_number: 9, tray_number: 2 });
    expect(noDate.body.errors.started_at).toEqual(["can't be blank"]);
  });
});

describe("money accounts, net worth and targets", () => {
  it("lists a new account with no balance, then moves net worth and history on a snapshot", async () => {
    const before = (await call("GET", "/api/net-worth")).body;
    const created = await call("POST", "/api/money-accounts", {
      body: { name: "Wallet", kind: "wallet" },
    });
    expect(created.status).toBe(201);

    const listed = (await call("GET", "/api/money-accounts")).body as {
      slug: string;
      latest: unknown;
    }[];
    expect(listed.find((a) => a.slug === created.body.slug)?.latest).toBeNull();

    const snapshot = await call("POST", `/api/money-accounts/${created.body.slug}/snapshots`, {
      body: { date: SEED_CLOCK, cash: 100, savings: "50.5" },
    });
    expect(snapshot.body).toMatchObject({ cash: 100, savings: 50.5, invested: 0, total: 150.5 });

    const after = (await call("GET", "/api/net-worth")).body;
    expect(after.net_worth).toBeCloseTo(before.net_worth + 150.5);
    expect(after.accounts).toHaveLength(before.accounts.length + 1);

    const history = (await call("GET", "/api/net-worth/history")).body as { date: string }[];
    expect(history.at(-1)?.date).toBe(SEED_CLOCK);
  });

  it("rejects a negative amount and answers 404 for an unknown account", async () => {
    const account = (await call("GET", "/api/money-accounts")).body[0];
    const negative = await call("POST", `/api/money-accounts/${account.slug}/snapshots`, {
      body: { cash: -5 },
    });
    expect(negative.status).toBe(422);

    const unknown = await call(
      "POST",
      "/api/money-accounts/00000000-0000-4000-8000-000000000000/snapshots",
      {
        body: { cash: 1 },
      },
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: "Not found" });
  });

  it("hides a target until hidden ones are asked for", async () => {
    const visible = (await call("GET", "/api/targets")).body as Schemas["ListTargetsResponse"];
    const slug = visible[0].slug;

    const hidden = await call("PUT", `/api/targets/${slug}`, { body: { hidden: true } });
    expect(hidden.body.hidden).toBe(true);

    const after = (await call("GET", "/api/targets")).body as Schemas["ListTargetsResponse"];
    expect(after.map((t) => t.slug)).not.toContain(slug);
    const all = (await call("GET", "/api/targets?include_hidden=true"))
      .body as Schemas["ListTargetsResponse"];
    expect(all.map((t) => t.slug)).toContain(slug);

    const invalid = await call("PUT", `/api/targets/${slug}`, { body: { target_value: 0 } });
    expect(invalid.status).toBe(422);
  });

  it("filters payslips by month: a range ending on the 31st includes that month", async () => {
    const december = (await call("GET", "/api/payslips?start_date=2025-12-15&end_date=2025-12-31"))
      .body as Schemas["ListPayslipsResponse"];
    expect(december.map((p) => p.period)).toEqual(["2025-12-01"]);
  });
});
