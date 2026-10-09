/**
 * The gate for voice's timing record (#29 r2/Q-2 (a)): on only in builds made with
 * `VITE_VOICE_TIMING=1`, such as the ephemeral env AC4 and AC6 run on. Vite replaces the flag at
 * build time, so in every other build each branch below is dead and the bundler drops it, with the
 * lazy `transcribe/timing` and `transcribe/TimingPanel` chunks (`build.test.ts` checks it).
 */
import { type ComponentType, lazy } from "react";

import type { StreamObserver } from "./transcribe/RealTranscriber";

let createObserver: (() => StreamObserver) | undefined;

if (import.meta.env.VITE_VOICE_TIMING === "1") {
  void import("./transcribe/timing").then((timing) => {
    createObserver = () => timing.createTimingObserver();
  });
}

/** A timing observer per recording, in timing builds (none until the module has loaded). */
export const observeTiming: (() => StreamObserver | undefined) | undefined =
  import.meta.env.VITE_VOICE_TIMING === "1" ? () => createObserver?.() : undefined;

/** The timing panel, in timing builds; null elsewhere. */
export const TimingPanel: ComponentType | null =
  import.meta.env.VITE_VOICE_TIMING === "1" ? lazy(() => import("./transcribe/TimingPanel")) : null;
