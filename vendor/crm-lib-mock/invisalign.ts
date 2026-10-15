// Invisalign: series of trays and the log of when each tray went in.
import { randomUUID } from "node:crypto";
import type { Schemas } from "@/lib/api/schemas";
import type { Handlers } from "./types";
import { fields } from "./util";

type InvisalignOperations = "listInvisalign" | "logInvisalignTray";

const MISSING = "can't be blank";

export const invisalignHandlers: Pick<Handlers, InvisalignOperations> = {
  listInvisalign: ({ store }) => {
    const ordered = store.series.toSorted((a, b) => b.series_number - a.series_number);

    const series = ordered.map((s, position) => {
      const logs = store.trayLogs
        .filter((l) => l.series_id === s.id)
        .toSorted((a, b) => a.tray_number - b.tray_number);
      const current = logs[logs.length - 1];

      return {
        id: s.id,
        series_number: s.series_number,
        total_trays: s.total_trays,
        // Only the latest series can be the one being worn.
        active: position === 0 && current !== undefined && current.tray_number < s.total_trays,
        tray_number: current?.tray_number ?? null,
        started_at: current?.started_at ?? null,
        expected_duration_days: current?.expected_duration_days ?? null,
        logs: logs.map((l) => ({
          id: l.id,
          tray_number: l.tray_number,
          started_at: l.started_at,
          expected_duration_days: l.expected_duration_days,
        })),
      };
    });

    return { status: 200, body: { series } };
  },

  // Logs the start of a tray. A series that doesn't exist yet is created when `total_trays` says
  // how big it is, and is a 404 otherwise.
  logInvisalignTray: ({ body, store }) => {
    const input = fields(body);
    const startedAt = (body.started_at ?? body.date) as string | undefined;
    const errors: Record<string, string[]> = {};

    if (input.series_number == null) errors.series_number = [MISSING];
    else if (!(Number(input.series_number) > 0)) {
      errors.series_number = ["must be greater than 0"];
    }
    if (input.tray_number == null) errors.tray_number = [MISSING];
    else if (!(Number(input.tray_number) > 0)) errors.tray_number = ["must be greater than 0"];
    if (!startedAt) errors.started_at = [MISSING];
    if (input.total_trays != null && !(Number(input.total_trays) > 0)) {
      errors.total_trays = ["must be greater than 0"];
    }
    if (input.expected_duration_days != null && !(Number(input.expected_duration_days) > 0)) {
      errors.expected_duration_days = ["must be greater than 0"];
    }
    if (Object.keys(errors).length > 0) return { status: 422, body: { errors } };

    let series = store.series.find((s) => s.series_number === body.series_number);
    if (!series) {
      if (body.total_trays == null) {
        return { status: 404, body: { errors: { series: ["not found"] } } };
      }
      series = {
        id: randomUUID(),
        series_number: body.series_number,
        total_trays: body.total_trays,
      };
      store.series.push(series);
    }

    if (body.tray_number > series.total_trays) {
      return {
        status: 422,
        body: {
          errors: { tray_number: [`must be less than or equal to ${series.total_trays}`] },
        },
      };
    }
    if (
      store.trayLogs.some((l) => l.series_id === series.id && l.tray_number === body.tray_number)
    ) {
      return { status: 422, body: { errors: { series_id: ["has already been taken"] } } };
    }

    const log: Schemas["InvisalignTrayLogResponse"] = {
      id: randomUUID(),
      tray_number: body.tray_number,
      started_at: startedAt as string,
      expected_duration_days: body.expected_duration_days ?? 7,
    };
    store.trayLogs.push({ ...log, series_id: series.id });
    return { status: 200, body: log };
  },
};
