// One handler per operation in `Mocked`. Each re-implements just enough of the backend to keep
// the UI coherent: filters, ordering, derived figures and the mutations. tests/mock replays the
// backend's recorded responses against these to keep them honest.
import { authHandlers } from "./auth";
import { carKmHandlers } from "./carkm";
import { concertHandlers } from "./concerts";
import { financeHandlers } from "./finance";
import { invisalignHandlers } from "./invisalign";
import { timeOffHandlers } from "./timeoff";
import { tripHandlers } from "./trips";
import type { Handlers } from "./types";

export { MOCK_LOGIN_CODE } from "./auth";

export const handlers: Handlers = {
  ...authHandlers,
  ...timeOffHandlers,
  ...tripHandlers,
  ...concertHandlers,
  ...carKmHandlers,
  ...invisalignHandlers,
  ...financeHandlers,
};
