import { CancelAndNotify } from "./cancel_and_notify";
import { Issues } from "./issues";
import { Notices } from "./notices";

/** What «project» offers, by the name each service is reached by. */
export const features = { Issues, Notices };
export const applicationServices = { CancelAndNotify };

export type ProjectFeatures = typeof features;
