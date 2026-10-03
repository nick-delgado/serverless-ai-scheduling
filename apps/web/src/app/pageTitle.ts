import { CLINIC } from "@sched/contracts";

/** `<title>` text for a page. React 19 hoists a `<title>` rendered anywhere into <head>. */
export function pageTitle(page: string): string {
  return `${page} · ${CLINIC.name}`;
}
