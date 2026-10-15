// The backend recorded what it really returns for these requests (contracts/examples.json).
// Replaying each one against the mock, seeded from the same data, is what keeps the mock's
// filters, ordering and derived figures from drifting away from the backend's.
import { beforeEach, describe, expect, it } from "vitest";
import { examples } from "@/lib/mock/recorded";
import { handleMockRequest, resetMockStore, SEED_CLOCK } from "@/lib/mock/server";
import { handlers } from "@/lib/mock/handlers";

// The mock covers the crm pages' endpoints; the contract also describes the expense tracker's,
// which recorded examples exist for but the mock leaves to the real backend.
const mocked = new Set(Object.keys(handlers));
const replayable = examples.filter((e) => mocked.has(e.operationId));

describe("mock backend replays the recorded backend responses", () => {
  beforeEach(() => {
    process.env.MOCK_TODAY = SEED_CLOCK;
    resetMockStore(SEED_CLOCK);
  });

  it("has recordings to replay for the crm pages", () => {
    const operations = new Set(replayable.map((e) => e.operationId));
    for (const operation of [
      "listTimeOff",
      "listTrips",
      "listTripLocations",
      "listHomePeriods",
      "getResidencySummary",
      "listConcerts",
      "listConcertVenues",
      "listCarKm",
      "getCarKmSummary",
      "listInvisalign",
      "listPayslips",
      "getPayslipProjection",
      "listMoneyAccounts",
      "getNetWorth",
      "getNetWorthHistory",
      "listTargets",
    ]) {
      expect(operations, operation).toContain(operation);
    }
  });

  it.each(replayable.map((e) => [`${e.operationId}/${e.name}`, e] as const))(
    "%s",
    async (_label, example) => {
      const url = new URL(example.request.path, "http://mock.test");
      url.search = new URLSearchParams(example.request.query).toString();

      const response = await handleMockRequest(
        new Request(url, {
          method: example.request.method,
          headers: example.name === "signedOut" ? {} : { cookie: "session_token=mock-session" },
        }),
      );

      const text = await response.text();
      expect({
        status: response.status,
        body: text === "" ? null : JSON.parse(text),
      }).toEqual(example.response);
    },
  );
});
